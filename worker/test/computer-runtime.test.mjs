import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { KikkaWorker } from '../src/runtime.mjs';
import { ComputerProvider } from '../src/computer-provider.mjs';
import { FakeComputerBackend } from './fixtures/fake-computer.mjs';
import { ImOrbComputerBackend } from '../src/imorb-computer.mjs';
import { CodingEngine } from '../src/coding-engine.mjs';

const policy = { provider: 'openai', modelId: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, maxOutputTokens: 4096 };
const admission = { owner: 'alice', task: 'trip', root_goal: 'root-trip', goal: 'Inspect the public page with the computer.', max_cost_cents: 50, computer_workspace: 'work' };
const identity = request_id => ({ account: 'alice', workspace_id: 'work', task_id: 'trip', root_goal_id: 'root-trip', request_id });
async function settled(worker, id, expected = 'Completed') {
  for (let n = 0; n < 500; n++) {
    if ((await worker.status(id)).state === expected) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail(`Pi task did not reach ${expected}`);
}
async function setup(t, backend, reply) {
  const directory = await mkdtemp(join(tmpdir(), 'burrow-computer-pi-'));
  const worker = new KikkaWorker({ directory, policy, approvedUrls: ['https://example.com/'],
    computerFactory: () => new ComputerProvider({ directory: join(directory, 'computers'), backend,
      grants: [{ account: 'alice', workspace_id: 'work', features: backend.capabilities().features,
        shell: backend.capabilities().features.includes('shell'),
        allowed_urls: ['https://example.com/'], read_only_urls: ['https://example.com/'] }] }),
    modelsFactory: () => {
      const models = createModels(); models.setProvider(openaiProvider());
      models.completeSimple = async (_model, input) => ({ role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-4o-mini', timestamp: Date.now(),
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        ...await reply(input) });
      return models;
    } });
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  return worker;
}
const tool = (name, args, n) => ({ content: [{ type: 'toolCall', id: `call-${n}`, name, arguments: args }], stopReason: 'toolUse' });
const action = (operation, args, replay_class = 'read_only') => ({ operation, args, replay_class });
const done = { content: [{ type: 'text', text: 'Fixture computer inspected; same Pi task retained. No real browser or booking.' }], stopReason: 'stop' };

test('real Pi task uses canonical computer tools, survives loss/reconnect, saves identities and resumes its journal', async t => {
  const backend = new FakeComputerBackend(); let generations = 0;
  const steps = [ ['computer_open', {}], ['computer_action', action('browser.navigate', { url: 'https://example.com/' })],
    ['computer_action', action('browser.read', {})], ['computer_reconnect', {}],
    ['computer_action', action('screenshot', { surface: 'browser' })],
    ['computer_action', action('files.write', { path: 'trip.txt', content: 'Budget 240' }, 'non_idempotent_effect')] ];
  const worker = await setup(t, backend, async input => {
    generations++;
    const results = input.messages.filter(m => m.role === 'toolResult');
    if (results.length === 2) backend.lost = true;
    if (results.length === 3) assert.equal(JSON.parse(results.at(-1).content[0].text).status, 'unavailable');
    return results.length < steps.length ? tool(...steps[results.length], results.length) : done;
  });
  const id = await worker.start(admission); await settled(worker, id);
  const status = await worker.status(id), events = await worker.events(id);
  assert.equal(status.root_goal_id, 'root-trip'); assert.equal(status.review, null);
  const dispatched = events.filter(e => e.type === 'computer' && e.data.phase === 'requested' && e.data.operation === 'files.write');
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].data.request_id, /^pi-[a-f0-9]{64}$/);
  assert.equal(dispatched[0].data.replay_class, 'non_idempotent_effect');
  assert.equal(dispatched[0].data.account, 'alice'); assert.equal(dispatched[0].data.workspace_id, 'work');
  assert.equal(worker.computers.receipt(identity(dispatched[0].data.request_id)).status, 'complete');
  const count = generations;
  await worker.close(); await worker.recover();
  assert.equal((await worker.status(id)).state, 'Completed'); assert.equal(generations, count);
  assert.equal((await worker.status(id)).reserved_micros, status.reserved_micros);
  await assert.rejects(worker.computer({ owner: 'bob', run: id, action: 'status', request_id: 'inspect' }), /scope/);
  const view = await worker.computer({ owner: 'alice', run: id, action: 'live_view', request_id: 'view', mode: 'interactive' });
  assert.equal(view.mode, 'interactive');
  assert.ok(!(JSON.stringify(await worker.events(id))).includes('token=fake'));
});

test('Pi continues after uncertain effect; different tool IDs cannot duplicate it', async t => {
  const backend = new FakeComputerBackend();
  const write = action('files.write', { path: 'trip.txt', content: 'once' }, 'non_idempotent_effect');
  const steps = [['computer_open', {}], ['computer_action', write], ['computer_reconnect', {}], ['computer_action', write]];
  const worker = await setup(t, backend, async input => {
    const results = input.messages.filter(m => m.role === 'toolResult');
    if (results.length === 1) backend.failAfterEffect = true;
    if ([2, 4].includes(results.length)) assert.equal(JSON.parse(results.at(-1).content[0].text).status, 'uncertain');
    return results.length < steps.length ? tool(...steps[results.length], results.length) : done;
  });
  const id = await worker.start(admission); await settled(worker, id);
  assert.equal(backend.calls.filter(c => c.action.operation === 'files.write').length, 1);
  await worker.close(); await worker.recover();
  assert.equal((await worker.status(id)).state, 'Completed');
  assert.equal(backend.calls.filter(c => c.action.operation === 'files.write').length, 1);
});

test('Stop cancels computer work, even when engine ignores abort, without pretending effects rolled back', async t => {
  const backend = new FakeComputerBackend(); let entered;
  const active = new Promise(r => { entered = r; });
  backend.execute = async () => { entered(); return new Promise(() => {}); };
  const worker = await setup(t, backend, async input => {
    const results = input.messages.filter(m => m.role === 'toolResult');
    return results.length === 0 ? tool('computer_open', {}, 0)
      : tool('computer_action', action('files.write', { path: 'trip.txt', content: 'once' }, 'non_idempotent_effect'), 1);
  });
  const id = await worker.start(admission); await active;
  await worker.control(id, { request_id: 'stop-1', action: 'stop' }); await settled(worker, id, 'Cancelled');
  const effect = (await worker.events(id)).find(e => e.type === 'computer' && e.data.operation === 'files.write');
  assert.equal(worker.computers.receipt(identity(effect.data.request_id)).status, 'uncertain');
  assert.equal((await worker.computer({ owner: 'alice', run: id, action: 'release_workspace', request_id: 'cleanup' })).state, 'released');
  assert.equal((await worker.status(id)).state, 'Cancelled');
});

test('coding Pi loop fixes a real fixture repository, executes failing then passing tests and returns its diff', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'burrow-coding-repo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new ImOrbComputerBackend({ binary: '/usr/local/bin/bun', home: join(directory, 'home'), repo: directory,
    command: ['/usr/local/bin/bun', resolve('test/fixtures/imorb-resource-cli.mjs')],
    dockerCommand: ['/usr/local/bin/bun', resolve('test/fixtures/imorb-resource-cli.mjs'), 'docker'] });
  backend.engines.push(new CodingEngine({ transport: backend }));
  backend.capabilities = () => ({ features: ['files.read', 'files.write', 'shell'] });
  const before = 'export const subtract = (a, b) => a + b;\n';
  const after = 'export const subtract = (a, b) => a - b;\n';
  const check = [process.execPath, '--input-type=module', '-e', 'import assert from "node:assert/strict"; import {subtract} from "./arithmetic.mjs"; assert.equal(subtract(7,2),5); assert.equal(subtract(-1,3),-4); console.log("2 checks passed")'];
  const shell = argv => action('shell', { argv }, 'non_idempotent_effect');
  const steps = [ ['computer_open', {}],
    ['computer_action', shell(['sh', '-c', `git init -q && printf '%s' '${before}' > arithmetic.mjs && git add arithmetic.mjs`])],
    ['computer_action', action('files.read', { path: 'arithmetic.mjs' })],
    ['computer_action', shell(check)],
    ['computer_action', action('files.write', { path: 'arithmetic.mjs', content: after }, 'non_idempotent_effect')],
    ['computer_action', shell(check)], ['computer_action', shell(['git', 'diff', '--', 'arithmetic.mjs'])] ];
  let generations = 0, diff;
  const worker = await setup(t, backend, async input => {
    generations++;
    assert.deepEqual(getCurrentTools(input.messages).map(t => t.name).sort(), ['computer_action', 'computer_open', 'computer_reconnect']);
    const results = input.messages.filter(m => m.role === 'toolResult');
    const receipt = results.length && JSON.parse(results.at(-1).content[0].text);
    if (results.length === 3) assert.equal(receipt.output.text, before);
    if (results.length === 4) assert.equal(receipt.output.exit_code, 1);
    if (results.length === 6) { assert.equal(receipt.output.exit_code, 0); assert.equal(receipt.output.stdout, '2 checks passed\n'); }
    if (results.length === 7) { diff = receipt.output.stdout; assert.match(diff, /-export const subtract = \(a, b\) => a \+ b;/); assert.match(diff, /\+export const subtract = \(a, b\) => a - b;/); }
    return results.length < steps.length ? tool(...steps[results.length], results.length)
      : { content: [{ type: 'text', text: `Fixed subtraction. Two checks passed. Not pushed.\n${diff}` }], stopReason: 'stop' };
  });
  const id = await worker.start({ ...admission, coding: true, goal: 'Fix subtraction and run the regression checks.' });
  await settled(worker, id);
  assert.equal((await worker.status(id)).review, null);
  const computer = await worker.computer({ owner: 'alice', run: id, action: 'status', request_id: 'inspect' });
  assert.equal(await readFile(join(directory, 'home', computer.computer_id, 'files/arithmetic.mjs'), 'utf8'), after);
  const calls = generations;
  await worker.close(); await worker.recover();
  assert.equal((await worker.status(id)).state, 'Completed'); assert.equal(generations, calls);
});

test('coding requires explicit compatible admission; ordinary research cannot execute shell', async t => {
  const backend = new FakeComputerBackend();
  const original = backend.capabilities.bind(backend);
  backend.capabilities = () => ({ ...original(), features: [...original().features, 'shell'] });
  let generations = 0;
  const worker = await setup(t, backend, async input => {
    generations++;
    const results = input.messages.filter(m => m.role === 'toolResult');
    if (results.length === 2) assert.equal(results.at(-1).isError, true);
    return results.length === 0 ? tool('computer_open', {}, 0) : results.length === 1
      ? tool('computer_action', action('shell', { argv: ['sh', '-c', 'touch forbidden'] }, 'non_idempotent_effect'), 1) : done;
  });
  for (const extra of [{ coding: 'true' }, { coding: true, computer_workspace: undefined },
    { coding: true, comparison: true }, { coding: true, routine: {} }, { coding: true, requirements: {} }]) {
    await assert.rejects(worker.start({ ...admission, ...extra }), /coding|Coding/);
  }
  assert.equal(generations, 0);
  const id = await worker.start(admission); await settled(worker, id);
  assert.equal(backend.calls.filter(c => c.action.operation === 'shell').length, 0);
});
