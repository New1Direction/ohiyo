import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { workerServer } from '../src/server.mjs';
import { NativeConnections } from '../src/subscriptions.mjs';

async function setup(t, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'kikka-subscriptions-'));
  const binary = join(directory, 'official-client-fixture');
  // Deterministic subprocess fixture, not a real provider login or model test.
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.OPENAI_API_KEY) throw Error('Credential environment leaked');
if (process.env.HOME !== (process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME) || process.cwd() !== process.env.HOME) throw Error('Profile isolation failed');
const file = path.join(process.env.HOME, 'account.json');
const event = value => fs.appendFileSync(path.join(process.env.HOME, 'events'), value + '\\n');
const args = process.argv.slice(2);
if (process.env.CODEX_HOME) {
  if (args.splice(0,4).join(' ') !== '-c forced_login_method="chatgpt" -c cli_auth_credentials_store="file"') throw Error('Unpinned subscription authentication');
}
if (args.join(' ') === 'login status') {
  console.error(fs.existsSync(file) ? 'Logged in using ChatGPT' : 'Not logged in');
} else if (args.join(' ') === 'logout') {
  fs.rmSync(file, {force:true}); event('logout');
} else if (args.join(' ') === 'login --device-auth') {
  event('login'); process.stdout.write('https://auth.openai.com/codex/device\\nABCD-EFGH');
  setTimeout(() => console.log('J'), 30);
  setInterval(() => { if (fs.existsSync(${JSON.stringify(join(directory, 'provider-authorized'))})) {
    fs.writeFileSync(file, JSON.stringify({loggedIn:true}), {mode:0o600}); process.exit(0);
  } }, 30);
} else if (args.join(' ') === 'auth status --json') {
  console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : JSON.stringify({loggedIn:false}));
} else if (args.join(' ') === 'auth logout') {
  fs.rmSync(file, {force:true}); event('logout');
} else if (args.join(' ') === 'auth login --claudeai') {
  event('login');
  console.log('https://evil.example/oauth?token=never-return-this');
  process.stdout.write('https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&code_challenge=fixture&code_challenge_method=S256&state=');
  setTimeout(() => console.log('whole-state'), 30);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', code => {
    event('code');
    if (code !== 'approve#whole-state\\n') { console.error('private-token-should-not-leak'); process.exit(1); }
    setTimeout(() => {
      fs.writeFileSync(file, JSON.stringify({loggedIn:true, email:'fixture@example.test', subscriptionType:'max', accessToken:'private-token-should-not-leak'}), {mode:0o600});
      process.exit(0);
    }, 250);
  });
} else { throw Error('Unexpected command: inference is not permitted in this fixture'); }
`, { mode: 0o700 });
  const token = 'private-fixture-worker-token-0123456789';
  const clients = Object.fromEntries(['claude', 'chatgpt'].map(provider => [provider,
    new NativeConnections({ directory: join(directory, 'subscriptions', ...(provider === 'chatgpt' ? ['chatgpt'] : [])), binary: enabled ? binary : undefined, provider })]));
  const server = workerServer({ directory }, token, { subscriptionAccounts: {
    call: (owner, provider, action, extra) => clients[provider].call(owner, action, extra),
    close: () => Promise.all(Object.values(clients).map(client => client.close())),
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const call = async (owner, action, extra = {}, bearer = token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/command`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'subscription', owner, action, ...extra }),
    });
    return { status: response.status, body: response.status === 401 ? null : await response.json() };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { call, directory, binary };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error('Connection did not settle');
}

test('private HTTP sign-in isolates accounts, rejects foreign completion, persists native login and never enables research', async t => {
  const { call, directory, binary } = await setup(t);
  assert.equal((await call('alice', 'status', {}, 'wrong')).status, 401);
  assert.equal((await call('alice', 'status')).body.state, 'disconnected');
  const started = (await call('alice', 'connect')).body;
  assert.equal(started.state, 'awaiting_sign_in');
  assert.equal(new URL(started.authorizationUrl).searchParams.get('state'), 'whole-state', 'never return a partially streamed URL');
  assert.equal((await call('alice', 'connect')).body.attempt, started.attempt, 'reconcile, do not launch another login');
  assert.equal((await call('bob', 'status')).body.state, 'disconnected');
  assert.equal((await call('bob', 'complete', { attempt: started.attempt, code: 'approve#whole-state' })).status, 409);
  assert.equal((await call('alice', 'complete', { attempt: started.attempt, code: 'line\ninjection' })).status, 409);
  const submitted = await call('alice', 'complete', { attempt: started.attempt, code: 'approve#whole-state' });
  assert.equal(submitted.body.state, 'verifying');
  await call('alice', 'complete', { attempt: started.attempt, code: 'approve#whole-state' });
  const account = await until(async () => { const r = await call('alice', 'status'); return r.body.state === 'connected' && r.body; });
  assert.equal(account.email, 'fixture@example.test'); assert.equal(account.usableForResearch, false);
  assert.doesNotMatch(JSON.stringify(account), /private-token|accessToken|authorizationUrl/);
  const reopened = new NativeConnections({ directory: join(directory, 'subscriptions'), binary });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.call('alice', 'status'), account, 'restart reads native state, not another login');
  assert.equal((await call('bob', 'disconnect')).body.state, 'disconnected');
  assert.equal((await call('alice', 'status')).body.state, 'connected');
  assert.equal((await call('alice', 'disconnect')).body.state, 'disconnected');
  const events = await readFile(join(reopened.profile('alice'), 'events'), 'utf8');
  assert.equal(events, 'login\ncode\nlogout\n', 'no model calls, duplicate logins or replayed sign-in codes');
});

test('failed sign-in stays unconfirmed and does not disclose provider output', async t => {
  const { call } = await setup(t);
  const job = (await call('alice', 'connect')).body;
  await call('alice', 'complete', { attempt: job.attempt, code: 'wrong-code' });
  const failed = await until(async () => { const r = await call('alice', 'status'); return r.body.state === 'failed' && r.body; });
  assert.equal(failed.authorizationUrl, null);
  assert.doesNotMatch(JSON.stringify(failed), /private-token|evil.example/);
  assert.equal((await call('alice', 'complete', { attempt: job.attempt, code: 'approve#whole-state' })).status, 409);
});

test('missing official client is unavailable, not a fake connected account', async t => {
  const { call } = await setup(t, false);
  assert.equal((await call('alice', 'status')).body.state, 'unavailable');
  assert.equal((await call('alice', 'connect')).status, 409);
});

test('expired and cancelled native logins cannot consume a later code', async t => {
  const { directory, binary } = await setup(t);
  const broker = new NativeConnections({ directory: join(directory, 'expiry'), binary, lifetime: 150 });
  t.after(() => broker.close());
  const job = await broker.call('alice', 'connect');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await broker.call('alice', 'status')).state, 'expired');
  await assert.rejects(broker.call('alice', 'complete', { attempt: job.attempt, code: 'approve#whole-state' }));
  assert.equal((await broker.call('alice', 'disconnect')).state, 'disconnected');
  const reopened = new NativeConnections({ directory: join(directory, 'expiry'), binary });
  t.after(() => reopened.close());
  assert.equal((await reopened.call('alice', 'status')).state, 'disconnected');
});

test('Codex device sign-in stays separate from Claude and cannot accept a completion code or activate research', async t => {
  const { call, directory, binary } = await setup(t);
  const provider = { provider: 'chatgpt' };
  const job = (await call('alice', 'connect', provider)).body;
  assert.equal(job.authorizationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(job.userCode, 'ABCD-EFGHJ'); assert.equal(job.execution, 'codex');
  assert.equal((await call('bob', 'status', provider)).body.state, 'disconnected');
  assert.equal((await call('alice', 'status')).body.state, 'disconnected', 'Claude has a different profile');
  assert.equal((await call('alice', 'complete', { ...provider, attempt: job.attempt, code: job.userCode })).status, 409);
  await writeFile(join(directory, 'provider-authorized'), 'fixture authorization, not a live login');
  const account = await until(async () => { const r = await call('alice', 'status', provider); return r.body.state === 'connected' && r.body; });
  assert.equal(account.usableForResearch, false); assert.equal(account.execution, 'codex');
  assert.equal(account.email, null, 'do not invent an identity that Codex status does not report');
  const reopened = new NativeConnections({ directory: join(directory, 'subscriptions', 'chatgpt'), binary, provider: 'chatgpt' });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.call('alice', 'status'), account);
  assert.equal((await call('alice', 'disconnect', provider)).body.state, 'disconnected');
  assert.equal(await readFile(join(reopened.profile('alice'), 'events'), 'utf8'), 'login\nlogout\n');
});
