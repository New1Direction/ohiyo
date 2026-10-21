import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComputerProvider } from '../src/computer-provider.mjs';
import { ComputerNotDispatched } from '../src/computer-contract.mjs';
import { FakeComputerBackend } from './fixtures/fake-computer.mjs';

const identity = { account: 'alice', workspace_id: 'travel', task_id: 'one', root_goal_id: 'root-one', request_id: 'open' };
const grant = { account: 'alice', workspace_id: 'travel', features: new FakeComputerBackend().capabilities().features,
  allowed_urls: ['https://example.com/'], read_only_urls: ['https://example.com/'] };
const action = (operation, args, replay_class = 'read_only', extra = {}) => ({ operation, args, replay_class, ...extra });
async function fixture(t, { resolveGrants } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'burrow-provider-')); const backend = new FakeComputerBackend();
  let clock = Date.now();
  let provider = new ComputerProvider({ directory, backend, grants: [grant], resolveGrants, idleMs: 1000, now: () => clock });
  t.after(async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); });
  return { backend, get provider() { return provider; }, advance() { clock += 1001; }, async reopen() {
    await provider.close(); provider = new ComputerProvider({ directory, backend, grants: [grant], resolveGrants, idleMs: 1000, now: () => clock }); await provider.reconcile();
  }, run(request_id, a, i = identity) { return provider.execute({ ...i, request_id }, a); } };
}

test('fake contract acceptance: open, discovery, actions, live view, loss, reconnect and durable identity', async t => {
  const f = await fixture(t);
  assert.equal((await f.provider.open(identity)).state, 'ready');
  assert.ok((await f.provider.capabilities(identity)).features.includes('browser.read'));
  assert.equal((await f.run('navigate', action('browser.navigate', { url: 'https://example.com/' }))).status, 'complete');
  assert.equal((await f.run('write', action('files.write', { path: 'trip.txt', content: 'Budget 240' }, 'non_idempotent_effect'))).status, 'complete');
  assert.equal((await f.provider.live_view(identity, { mode: 'read_only' })).mode, 'read_only');
  assert.equal((await f.run('read', action('files.read', { path: 'trip.txt' }))).output.text, 'Budget 240');
  f.backend.lost = true;
  assert.equal((await f.run('lost', action('browser.read', {}))).status, 'unavailable');
  assert.equal((await f.provider.status(identity)).state, 'unavailable');
  await f.reopen();
  assert.equal((await f.provider.reconnect(identity)).state, 'ready');
  assert.equal((await f.run('after-reconnect', action('files.read', { path: 'trip.txt' }))).output.text, 'Budget 240');
  const receipt = f.provider.receipt({ ...identity, request_id: 'write' });
  assert.equal(receipt.root_goal_id, 'root-one'); assert.equal(receipt.replay_class, 'non_idempotent_effect');
});

test('uncertain effect cannot replay under same or new action ID, or after restart/replacement', async t => {
  const f = await fixture(t); await f.provider.open(identity);
  await f.run('navigate', action('browser.navigate', { url: 'https://example.com/' }));
  f.backend.failAfterEffect = true;
  const write = action('files.write', { path: 'trip.txt', content: 'once' }, 'non_idempotent_effect');
  assert.equal((await f.run('write', write)).status, 'uncertain');
  await f.reopen(); await f.provider.reconnect(identity);
  assert.equal((await f.run('write', write)).status, 'uncertain');
  assert.equal((await f.run('different', write)).status, 'uncertain');
  assert.equal((await f.run('observe', action('files.read', { path: 'trip.txt' }))).output.text, 'once');
  const replacement = await f.provider.replace(identity);
  assert.equal(replacement.generation, 2); assert.equal(replacement.capabilities.persistence.profile, true);
  assert.equal((await f.run('third', write)).status, 'uncertain');
  assert.equal((await f.run('replacement-observe', action('files.read', { path: 'trip.txt' }))).output.text, 'once');
  assert.equal((await f.run('profile-observe', action('browser.read', {}))).output.url, 'https://example.com/');
  assert.equal(f.backend.calls.filter(c => c.action.operation === 'files.write').length, 1);
});

test('workspace reuse, task reference cleanup, idle release and namespace-only orphan cleanup', async t => {
  const f = await fixture(t);
  const one = await f.provider.open(identity);
  const twoId = { ...identity, task_id: 'two', root_goal_id: 'root-two' };
  assert.equal((await f.provider.open(twoId)).computer_id, one.computer_id);
  await f.provider.release(identity);
  assert.equal((await f.provider.status(twoId)).state, 'ready');
  f.backend.resources.set('foreign', { computer_id: 'foreign', namespace: 'someone-else' });
  f.backend.resources.set('orphan', { computer_id: 'orphan', namespace: f.provider.namespace });
  f.advance(); await f.provider.reconcile();
  assert.equal((await f.provider.status(twoId)).state, 'released');
  assert.ok(f.backend.resources.has('foreign')); assert.ok(!f.backend.resources.has('orphan'));
});

test('account/workspace isolation, capability policy and immutable action terms', async t => {
  const grants = [grant];
  const f = await fixture(t, { resolveGrants: () => grants }); const alice = await f.provider.open(identity);
  for (const other of [{ ...identity, account: 'bob' }, { ...identity, workspace_id: 'other' }]) {
    await assert.rejects(f.provider.open(other), /authorized/);
    await assert.rejects(f.provider.execute(other, action('files.read', { path: 'trip.txt' })), /authorized/);
    assert.throws(() => f.provider.receipt(other), /authorized/);
  }
  await assert.rejects(f.run('shell', action('shell', { argv: ['true'] }, 'non_idempotent_effect')), /Shell/);
  await f.run('read', action('files.read', { path: 'trip.txt' }));
  await assert.rejects(f.run('read', action('files.read', { path: 'different.txt' })), /terms/);
  await f.run('private-write', action('files.write', { path: 'trip.txt', content: 'Alice only' }, 'non_idempotent_effect'));
  grants.push({ ...grant, account: 'bob' });
  const bob = { ...identity, account: 'bob' };
  assert.notEqual((await f.provider.open(bob)).computer_id, alice.computer_id);
  assert.equal((await f.run('bob-read', action('files.read', { path: 'trip.txt' }), bob)).output.text, '');
  await f.run('bob-write', action('files.write', { path: 'trip.txt', content: 'Bob only' }, 'non_idempotent_effect'), bob);
  assert.equal((await f.run('alice-read', action('files.read', { path: 'trip.txt' }))).output.text, 'Alice only');
  await f.provider.stop(identity);
  assert.equal((await f.run('after-stop', action('files.read', { path: 'trip.txt' }))).status, 'stopped');
});

test('read retry and explicitly tested mkdir invariant differ from uncertain writes', async t => {
  const f = await fixture(t); await f.provider.open(identity);
  const mkdir = action('files.ensure_directory', { path: 'notes' }, 'idempotent_effect', { invariant: 'mkdir_exists_v1' });
  f.backend.failAfterEffect = true;
  assert.equal((await f.run('mkdir', mkdir)).status, 'unavailable');
  await f.provider.reconnect(identity);
  assert.equal((await f.run('mkdir', mkdir)).status, 'complete');
  f.backend.lost = true;
  assert.equal((await f.run('read', action('files.read', { path: 'notes/a.txt' }))).status, 'unavailable');
  await f.provider.reconnect(identity);
  assert.equal((await f.run('read', action('files.read', { path: 'notes/a.txt' }))).status, 'complete');
});

test('queued effects, live views and lifecycle calls recheck current host policy before dispatch', async t => {
  let grants = [structuredClone(grant)];
  const f = await fixture(t, { resolveGrants: () => grants }); await f.provider.open(identity);
  const execute = f.backend.execute.bind(f.backend);
  let entered, release;
  const hold = () => {
    const active = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    f.backend.execute = async (...args) => { entered(); await blocked; return execute(...args); };
    return active;
  };
  const active = hold();
  const first = f.run('holding', action('browser.read', {})); await active;
  const queued = assert.rejects(f.run('revoked-write', action('files.write', { path: 'trip.txt', content: 'no' }, 'non_idempotent_effect')), /permission/);
  const view = assert.rejects(f.provider.live_view(identity), /authorized/);
  grants[0].features = ['browser.read']; release();
  await Promise.all([first, queued, view]);
  assert.equal(f.backend.calls.filter(c => c.action.operation === 'files.write').length, 0);

  const activeAgain = hold();
  const second = f.run('holding-again', action('browser.read', {})); await activeAgain;
  const open = assert.rejects(f.provider.open({ ...identity, task_id: 'two', root_goal_id: 'root-two' }), /authorized/);
  const reconnect = assert.rejects(f.provider.reconnect(identity), /authorized/);
  grants = []; release(); await Promise.all([second, open, reconnect]);
  await f.provider.reconcile();
  assert.equal(f.backend.resources.size, 0, 'revoked scope is cleaned up without reviving tasks');
});

test('proven non-dispatch permits retry after restart; a lookalike error never clears uncertainty', async t => {
  const f = await fixture(t); await f.provider.open(identity);
  const execute = f.backend.execute.bind(f.backend);
  const write = action('files.write', { path: 'trip.txt', content: 'once' }, 'non_idempotent_effect');
  f.backend.execute = async () => { throw new ComputerNotDispatched(); };
  assert.equal((await f.run('write', write)).status, 'unavailable');
  await f.reopen(); await f.provider.reconnect(identity);
  f.backend.execute = execute;
  assert.equal((await f.run('write', write)).status, 'complete');
  assert.equal(f.backend.calls.filter(c => c.action.operation === 'files.write').length, 1);
  f.backend.execute = async (...args) => { await execute(...args); throw Object.assign(new Error('lost'), { name: 'ComputerNotDispatched' }); };
  assert.equal((await f.run('lost', write)).status, 'uncertain');
  await f.provider.reconnect(identity);
  assert.equal((await f.run('lost-new-id', write)).status, 'uncertain');
  assert.equal(f.backend.calls.filter(c => c.action.operation === 'files.write').length, 2);
});

test('stopping one task does not wait for or cancel a neighboring task on the same computer', async t => {
  const f = await fixture(t); await f.provider.open(identity);
  const other = { ...identity, task_id: 'two', root_goal_id: 'root-two' }; await f.provider.open(other);
  let entered, release;
  const active = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const execute = f.backend.execute.bind(f.backend);
  f.backend.execute = async (...args) => { entered(); await blocked; return execute(...args); };
  const reading = f.run('holding', action('browser.read', {}), other); await active;
  let timer;
  try {
    await Promise.race([f.provider.stop(identity), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Stop waited for the other task')), 1000); })]);
  } finally { clearTimeout(timer); release(); }
  assert.equal((await reading).status, 'complete');
  assert.equal((await f.run('other-still-usable', action('files.read', { path: 'trip.txt' }), other)).status, 'complete');
});
