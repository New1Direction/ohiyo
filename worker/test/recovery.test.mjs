import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function child(mode, directory) {
  const proc = fork(new URL('./fixtures/recovery-child.mjs', import.meta.url), [mode, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; proc.stderr.on('data', b => { errors += b; });
  const ready = await Promise.race([once(proc, 'message').then(([m]) => m), once(proc, 'exit').then(() => { throw new Error(errors); })]);
  return { proc, ...ready, async kill() { const done = once(proc, 'exit'); proc.kill('SIGKILL'); await done; } };
}
async function lines(path) { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
async function until(check) {
  for (let i = 0; i < 300; i++) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Recovery condition did not occur.');
}
async function call(c, operation) {
  const r = await fetch(`http://127.0.0.1:${c.port}/command`, { method: 'POST', headers: { Authorization: `Bearer ${'f'.repeat(32)}` }, body: JSON.stringify({ operation, run: c.id }) });
  assert.equal(r.status, 200); return r.json();
}
test('stock Pi 1.3.0 resends a dispatched unfinished model request despite retries disabled', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-stock-replay-')); let c;
  t.after(async () => { if (c) await c.kill(); await rm(directory, { recursive: true, force: true }); });
  c = await child('raw', directory);
  await until(async () => (await lines(join(directory, 'provider-calls'))).length === 1);
  await c.kill(); c = null;
  c = await child('raw', directory);
  await until(async () => (await lines(join(directory, 'provider-calls'))).length === 2);
  assert.equal((await lines(join(directory, 'provider-calls'))).length, 2);
});
test('guarded worker SIGKILL preserves completed evidence and pauses unknown paid requests without redispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gated-replay-')); let c;
  t.after(async () => { if (c) await c.kill(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'hold-model'), '');
  c = await child('guarded', directory);
  await until(async () => (await lines(join(directory, 'provider-calls'))).length === 2);
  const id = c.id;
  const before = await call(c, 'watch');
  const evidence = before.find(e => e.type === 'evidence'); assert.ok(evidence);
  await c.kill(); c = null;
  await unlink(join(directory, 'hold-model'));
  c = await child('guarded', directory);
  assert.equal(c.id, id);
  const status = await call(c, 'status'); assert.equal(status.state, 'Paused'); assert.match(status.review, /paid request/);
  assert.equal((await lines(join(directory, 'provider-calls'))).length, 2);
  assert.equal((await lines(join(directory, 'browser-calls'))).length, 1);
  assert.ok((await call(c, 'watch')).some(e => e.type === 'evidence' && e.data.id === evidence.data.id));
  assert.equal(status.reserved_micros, 43316);
});
test('SIGKILL during a free read safely retries that read, not the acknowledged model request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-free-read-')); let c;
  t.after(async () => { if (c) await c.kill(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'hold-browser'), '');
  c = await child('guarded', directory);
  await until(async () => (await lines(join(directory, 'browser-calls'))).length === 1);
  await c.kill(); c = null;
  await unlink(join(directory, 'hold-browser'));
  c = await child('guarded', directory);
  await until(async () => (await call(c, 'status')).state === 'Completed');
  assert.deepEqual(await lines(join(directory, 'provider-calls')), ['initial', 'after-evidence']);
  assert.equal((await lines(join(directory, 'browser-calls'))).length, 2);
});
