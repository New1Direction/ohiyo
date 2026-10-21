import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ComputerProvider } from '../src/computer-provider.mjs';
import { COMPUTER_CONTRACT_VERSION, ComputerNotDispatched } from '../src/computer-contract.mjs';
import { ImOrbComputerBackend } from '../src/imorb-computer.mjs';

const identity = { account: 'alice', workspace_id: 'work', task_id: 'task', root_goal_id: 'root', request_id: 'open' };
const grant = { account: 'alice', workspace_id: 'work', features: ['files.read', 'files.write', 'files.ensure_directory'] };
async function setup(t, { grants = [grant] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'burrow-imorb-'));
  const config = { binary: '/usr/local/bin/bun', home: join(directory, 'home'), repo: directory,
    command: ['/usr/local/bin/bun', resolve('test/fixtures/imorb-resource-cli.mjs')],
    dockerCommand: ['/usr/local/bin/bun', resolve('test/fixtures/imorb-resource-cli.mjs'), 'docker'] };
  let provider;
  const reopen = async () => { await provider?.close(); provider = new ComputerProvider({ directory, grants, backend: new ImOrbComputerBackend(config), idleMs: 1000 }); return provider; };
  t.after(async () => { await provider?.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, config, reopen, get provider() { return provider; } };
}
const action = (operation, args, replay_class = 'read_only', extra = {}) => ({ operation, args, replay_class, ...extra });

test('ImOrb CLI backend acceptance: real transport/file helper, reconnect, honest persistence, cleanup and isolation', async t => {
  const f = await setup(t);
  f.config.engines = [
    { status: async () => ({ state: 'ready', capabilities: { contract_version: '2.0.0', features: ['desktop.lcu'], persistence: { workspace: true, profile: true }, limitations: [] } }) },
    { status: async () => ({ state: 'ready', capabilities: { contract_version: COMPUTER_CONTRACT_VERSION, features: ['persistent_profile', 'persistent_workspace'], persistence: { workspace: true, profile: true }, limitations: [] } }) },
  ];
  const p = await f.reopen();
  const first = await p.open(identity); assert.equal(first.state, 'ready');
  assert.deepEqual(first.capabilities.persistence, { workspace: false, profile: false });
  assert.ok(!first.capabilities.features.includes('persistent_profile'));
  assert.ok(!first.capabilities.features.includes('persistent_workspace'));
  assert.ok(!first.capabilities.features.includes('browser.navigate'));
  assert.ok(!first.capabilities.features.includes('desktop.lcu'));
  assert.match(first.capabilities.limitations.join(' '), /version mismatch/);
  assert.equal((await p.execute({ ...identity, request_id: 'mkdir' }, action('files.ensure_directory', { path: 'notes' }, 'idempotent_effect', { invariant: 'mkdir_exists_v1' }))).status, 'complete');
  const write = action('files.write', { path: 'notes/trip.txt', content: 'Budget 240' }, 'non_idempotent_effect');
  assert.equal((await p.execute({ ...identity, request_id: 'write' }, write)).status, 'complete');
  await p.execute({ ...identity, request_id: 'shorten' }, action('files.write', { path: 'notes/trip.txt', content: '150' }, 'non_idempotent_effect'));
  await p.reconnect(identity);
  assert.equal((await p.execute({ ...identity, request_id: 'read' }, action('files.read', { path: 'notes/trip.txt' }))).output.text, '150');
  assert.equal((await p.live_view(identity).catch(() => ({ status: 'unavailable' }))).status, 'unavailable');
  await assert.rejects(p.open({ ...identity, account: 'bob' }), /authorized/);
  await assert.rejects(p.execute({ ...identity, workspace_id: 'other' }, write), /authorized/);
  const replacementId = { ...identity, request_id: 'replace' };
  const replacement = await p.replace(replacementId); assert.equal(replacement.generation, 2);
  assert.equal((await p.replace(replacementId)).generation, 2, 'duplicate lifecycle command cannot destroy the replacement');
  assert.equal((await p.execute({ ...identity, request_id: 'missing' }, action('files.read', { path: 'notes/trip.txt' }))).status, 'unavailable');
  assert.equal((await p.release({ ...identity, request_id: 'release' })).state, 'released');
  assert.equal(JSON.parse(await readFile(join(f.config.home, 'registry.json'))).length, 0);
});

test('SIGKILL after ImOrb effect before Pi acknowledgement cannot replay after worker restart', async t => {
  const f = await setup(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ComputerProvider } from './src/computer-provider.mjs';
    import { ImOrbComputerBackend } from './src/imorb-computer.mjs';
    const backend = new ImOrbComputerBackend(${JSON.stringify(f.config)});
    const execute = backend.execute.bind(backend);
    backend.execute = async (...args) => { await execute(...args); process.send('effect-committed'); await new Promise(() => {}); };
    const provider = new ComputerProvider({ directory: ${JSON.stringify(f.directory)}, backend, grants: [${JSON.stringify(grant)}] });
    await provider.open(${JSON.stringify(identity)});
    setInterval(() => {}, 1000);
    await provider.execute(${JSON.stringify({ ...identity, request_id: 'write' })}, ${JSON.stringify(action('files.write', { path: 'once.txt', content: 'once' }, 'non_idempotent_effect'))});
  `], { cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', c => { errors += c; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(errors); })]);
  assert.equal(message, 'effect-committed'); child.kill('SIGKILL'); await once(child, 'exit');
  const p = await f.reopen(); await p.reconcile(); await p.reconnect(identity);
  const write = action('files.write', { path: 'once.txt', content: 'must-not-overwrite' }, 'non_idempotent_effect');
  assert.equal(p.receipt({ ...identity, request_id: 'write' }).status, 'uncertain');
  assert.equal((await p.execute({ ...identity, request_id: 'new-id' }, write)).status, 'uncertain');
  assert.equal((await p.execute({ ...identity, request_id: 'observe' }, action('files.read', { path: 'once.txt' }))).output.text, 'once');
});

test('ImOrb spawn failure is known non-dispatch; an unacknowledged spawned process is uncertain', async t => {
  const f = await setup(t); const p = await f.reopen(); await p.open(identity);
  const transport = new ImOrbComputerBackend(f.config);
  const write = action('files.write', { path: 'once.txt', content: 'once' }, 'non_idempotent_effect');
  const executable = f.config.command[0];
  f.config.command[0] = join(f.directory, 'missing-executable');
  await assert.rejects(transport.run(['list', '--json'], { input: 'request' }), ComputerNotDispatched);
  const failed = await p.execute({ ...identity, request_id: 'write' }, write);
  assert.equal(failed.status, 'unavailable'); assert.match(failed.reason, /not dispatched/);
  f.config.command[0] = join(f.directory, 'not-executable');
  await writeFile(f.config.command[0], '#!/bin/sh\ntouch "$ORBD_HOME/unexpected-dispatch"\n', { mode: 0o600 });
  await assert.rejects(transport.run(['list', '--json'], { input: 'request' }), ComputerNotDispatched);
  await assert.rejects(access(join(f.config.home, 'unexpected-dispatch')), { code: 'ENOENT' });
  f.config.command[0] = executable; await p.reconnect(identity);
  assert.equal((await p.execute({ ...identity, request_id: 'write' }, write)).status, 'complete');
  f.config.command[0] = '/usr/bin/false';
  await assert.rejects(transport.run(['list', '--json']), error => !(error instanceof ComputerNotDispatched));
  assert.equal((await p.execute({ ...identity, request_id: 'lost' }, write)).status, 'uncertain');
  f.config.command[0] = executable; await p.reconnect(identity);
  assert.equal((await p.execute({ ...identity, request_id: 'different' }, write)).status, 'uncertain');
});

test('pre-aborted transport reports non-dispatch without starting its executable', async t => {
  const f = await setup(t); const backend = new ImOrbComputerBackend(f.config);
  await assert.rejects(backend.run(['list', '--json'], { input: 'request', signal: AbortSignal.abort() }), ComputerNotDispatched);
  await assert.rejects(access(f.config.home), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await backend.run(['list', '--json'])), []);
  await access(join(f.config.home, 'registry.json'));
});

test('only acknowledged engine unavailability proves non-dispatch; ambiguous discovery fences effects', async t => {
  const f = await setup(t, { grants: [{ ...grant, features: [...grant.features, 'desktop.lcu'] }] });
  const capabilities = { contract_version: COMPUTER_CONTRACT_VERSION, features: ['desktop.lcu'], persistence: { workspace: false, profile: false }, limitations: [] };
  const type = action('desktop.type', { window_id: 9, text: 'once' }, 'non_idempotent_effect');
  const cases = [
    { engines: [], notDispatched: true },
    { state: { state: 'unavailable', capabilities }, notDispatched: true },
    { state: { state: 'ready', capabilities: { ...capabilities, features: [] } }, notDispatched: true },
    { error: new ComputerNotDispatched(), notDispatched: true },
    { error: new DOMException('Health acknowledgement timed out after write', 'TimeoutError'), notDispatched: false },
    { error: Object.assign(new Error('Health connection reset after write'), { code: 'ECONNRESET' }), notDispatched: false },
    { state: { state: 'ready', capabilities: { ...capabilities, contract_version: 'mismatch' } }, notDispatched: false },
    { state: { state: 'unknown', capabilities }, notDispatched: false },
  ];
  for (const c of cases) {
    const backend = new ImOrbComputerBackend({ ...f.config, engines: c.engines ?? [{
      status: async () => { if (c.error) throw c.error; return c.state; },
      execute: async () => { throw new Error('An unavailable engine must not execute this effect.'); },
    }] });
    await assert.rejects(backend.execute({}, identity, type, { signal: new AbortController().signal }),
      error => (error instanceof ComputerNotDispatched) === c.notDispatched);
  }
  let healthy = true;
  f.config.engines = [{ status: async () => {
    if (!healthy) throw new Error('Health response lost after request write');
    return { state: 'ready', capabilities };
  } }];
  const p = await f.reopen(); assert.equal((await p.open(identity)).state, 'ready'); healthy = false;
  assert.equal((await p.execute({ ...identity, request_id: 'type' }, type)).status, 'uncertain');
  await p.reconnect(identity);
  assert.equal((await p.execute({ ...identity, request_id: 'type-new-id' }, type)).status, 'uncertain');
});

test('post-write timeout of a non-idempotent effect remains uncertain across restart and new IDs', async t => {
  const f = await setup(t); const p = await f.reopen(); const computer = await p.open(identity);
  const request = { ...identity, request_id: 'write-timeout' };
  const write = action('files.write', { path: 'once.txt', content: 'once' }, 'non_idempotent_effect');
  await writeFile(join(f.config.home, 'lose-exec-ack'), '');
  const controller = new AbortController();
  const pending = p.execute(request, write, { signal: controller.signal });
  try {
    let received;
    for (let n = 0; n < 500; n++) {
      try { received = JSON.parse(await readFile(join(f.config.home, 'received-exec.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(received?.identity.request_id, request.request_id, 'receiver observed the actual request bytes before timeout');
    assert.equal(await readFile(join(f.config.home, computer.computer_id, 'files/once.txt'), 'utf8'), 'once');
    const timeout = AbortSignal.timeout(20);
    timeout.addEventListener('abort', () => controller.abort(timeout.reason), { once: true });
    assert.equal((await pending).status, 'uncertain');
    assert.equal(controller.signal.reason.name, 'TimeoutError');
  } finally { controller.abort(); await pending; await rm(join(f.config.home, 'lose-exec-ack')); }
  const recovered = await f.reopen(); await recovered.reconnect(identity);
  assert.equal(recovered.receipt(request).status, 'uncertain');
  assert.equal((await recovered.execute(request, write)).status, 'uncertain');
  assert.equal((await recovered.execute({ ...identity, request_id: 'new-id' }, { ...write, args: { ...write.args, content: 'must not overwrite' } })).status, 'uncertain');
  assert.equal((await recovered.execute({ ...identity, request_id: 'observe' }, action('files.read', { path: 'once.txt' }))).output.text, 'once');
});

test('registry deletion is not release proof: leftover containers remain tracked and cleanup retries', async t => {
  const f = await setup(t); const p = await f.reopen(); const computer = await p.open(identity);
  await writeFile(join(f.config.home, 'leave-container'), '');
  await writeFile(join(f.config.home, 'fail-docker-rm'), '');
  assert.equal((await p.release({ ...identity, request_id: 'release' })).state, 'unavailable');
  assert.deepEqual(JSON.parse(await readFile(join(f.config.home, 'registry.json'))), []);
  assert.deepEqual(JSON.parse(await readFile(join(f.config.home, 'containers.json'))), [computer.computer_id]);
  await rm(join(f.config.home, 'fail-docker-rm'));
  await p.reconcile();
  assert.equal((await p.status(identity)).state, 'released');
  assert.deepEqual(JSON.parse(await readFile(join(f.config.home, 'containers.json'))), []);
  // Even without an allocation row, namespace-owned container leftovers are
  // visible to orphan cleanup; foreign resource names are left untouched.
  const orphan = `${p.namespace}0123456789abcdef`;
  await writeFile(join(f.config.home, 'containers.json'), JSON.stringify([orphan, 'someone-elses-orb']));
  await p.reconcile();
  assert.deepEqual(JSON.parse(await readFile(join(f.config.home, 'containers.json'))), ['someone-elses-orb']);
});
