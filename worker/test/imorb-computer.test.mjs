import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ComputerProvider } from '../src/computer-provider.mjs';
import { COMPUTER_CONTRACT_VERSION } from '../src/computer-contract.mjs';
import { ImOrbComputerBackend } from '../src/imorb-computer.mjs';

const identity = { account: 'alice', workspace_id: 'work', task_id: 'task', root_goal_id: 'root', request_id: 'open' };
const grant = { account: 'alice', workspace_id: 'work', features: ['files.read', 'files.write', 'files.ensure_directory'] };
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'burrow-imorb-'));
  const config = { binary: '/usr/local/bin/bun', home: join(directory, 'home'), repo: directory,
    command: ['/usr/local/bin/bun', resolve('test/fixtures/imorb-resource-cli.mjs')],
    dockerCommand: ['/usr/local/bin/bun', resolve('test/fixtures/imorb-resource-cli.mjs'), 'docker'] };
  let provider;
  const reopen = async () => { await provider?.close(); provider = new ComputerProvider({ directory, grants: [grant], backend: new ImOrbComputerBackend(config), idleMs: 1000 }); return provider; };
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
  const write = action('files.write', { path: 'once.txt', content: 'once' }, 'non_idempotent_effect');
  const executable = f.config.command[0];
  f.config.command[0] = join(f.directory, 'missing-executable');
  const failed = await p.execute({ ...identity, request_id: 'write' }, write);
  assert.equal(failed.status, 'unavailable'); assert.match(failed.reason, /not dispatched/);
  f.config.command[0] = executable; await p.reconnect(identity);
  assert.equal((await p.execute({ ...identity, request_id: 'write' }, write)).status, 'complete');
  f.config.command[0] = '/usr/bin/false';
  assert.equal((await p.execute({ ...identity, request_id: 'lost' }, write)).status, 'uncertain');
  f.config.command[0] = executable; await p.reconnect(identity);
  assert.equal((await p.execute({ ...identity, request_id: 'different' }, write)).status, 'uncertain');
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
