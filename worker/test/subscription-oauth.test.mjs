import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { SubscriptionAccounts, subscriptionProviders } from '../src/subscription-oauth.mjs';
import { KikkaWorker } from '../src/runtime.mjs';
import { roles, subscriptionTransport } from '../src/routing.mjs';

// Fake authorization and HTTP responses; real Pi OAuth contracts, provider
// serialization, tool execution, durable journals and account vault underneath.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kikka-oauth-'));
  const authorizations = [], refreshes = [];
  const providers = Object.fromEntries(Object.entries(subscriptionProviders).map(([name, native]) => [name, {
    ...native, auth: { oauth: { ...native.auth.oauth,
      login: async interaction => {
        assert.equal(await interaction.prompt({ type: 'select' }), name === 'claude' ? 'copy_code' : 'device_code');
        if (name === 'claude') interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?state=fixture' });
        else interaction.notify({ type: 'device_code', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' });
        const authorized = name === 'claude' ? await interaction.prompt({ type: 'manual_code' }) : await new Promise((resolve, reject) => {
          authorizations.push(resolve); interaction.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
        if (authorized !== 'approved') throw new Error('private provider diagnostic');
        return { type: 'oauth', access: name === 'claude' ? 'sk-ant-oat01-fixture-secret' : `a.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.b`, refresh: 'private-refresh-secret', expires: Date.now() + 3600000 };
      },
      refresh: async credential => { refreshes.push(name); return { ...credential, expires: Date.now() + 3600000 }; },
    } },
  }]));
  const options = { directory: join(directory, 'vault'), key: 'fixture-vault-key-01234567890123456789', providers };
  const accounts = new SubscriptionAccounts(options);
  t.after(async () => { await accounts.close(); await rm(directory, { recursive: true, force: true }); });
  const login = async (provider = 'claude', owner = 'alice') => {
    const job = await accounts.call(owner, provider, 'connect');
    if (job.state === 'connected') return;
    if (provider === 'claude') await accounts.call(owner, provider, 'complete', { attempt: job.attempt, code: 'approved' });
    else authorizations.shift()('approved');
    for (let n = 0; n < 100; n++) {
      if ((await accounts.call(owner, provider, 'status')).state === 'connected') return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('Fixture login did not complete');
  };
  return { directory, accounts, options, login, refreshes };
}

test('subscription sign-in, encryption, restart, refresh and disconnect preserve account boundaries and pinned versions', async t => {
  const { accounts, options, directory, login, refreshes } = await fixture(t);
  const job = await accounts.call('alice', 'claude', 'connect');
  assert.equal((await accounts.call('alice', 'claude', 'connect')).attempt, job.attempt);
  await assert.rejects(accounts.call('bob', 'claude', 'complete', { attempt: job.attempt, code: 'approved' }));
  await accounts.call('alice', 'claude', 'complete', { attempt: job.attempt, code: 'approved' });
  await login();
  const status = await accounts.call('alice', 'claude', 'status');
  assert.equal(status.usableForResearch, true);
  assert.equal((await accounts.call('bob', 'claude', 'status')).state, 'disconnected');
  const model = status.models.find(m => m.providerModelId === 'claude-sonnet-5-5').id;
  const route = await accounts.call('alice', 'claude', 'route', { model });
  await assert.rejects(accounts.auth('bob', route));
  const file = await readFile(join(directory, 'vault', 'accounts.sqlite'));
  assert.ok(!file.includes(Buffer.from('private-refresh-secret')));
  assert.ok(!file.includes(Buffer.from('sk-ant-oat01-fixture-secret')));
  const other = new SubscriptionAccounts(options);
  await other.open();
  assert.equal((await other.call('alice', 'claude', 'route', { model })).connectionRevision, route.connectionRevision);
  await other.close();
  const saved = accounts.read('alice', 'claude');
  accounts.save('alice', 'claude', { ...saved.credential, expires: 1 }, saved.revision);
  await Promise.all([accounts.auth('alice', route), accounts.auth('alice', route)]);
  assert.deepEqual(refreshes, ['claude'], 'rotating refresh tokens are serialized');
  await accounts.call('alice', 'claude', 'disconnect');
  await assert.rejects(accounts.auth('alice', route));
  await login();
  await assert.rejects(accounts.auth('alice', route), /Reconnect/, 'reconnecting cannot silently revive old approvals');
  await login('chatgpt', 'bob');
  assert.equal((await accounts.call('bob', 'chatgpt', 'status')).usableForResearch, true);
  assert.equal((await accounts.call('alice', 'chatgpt', 'status')).state, 'disconnected');
});

for (const provider of ['claude', 'chatgpt']) test(`${provider} subscription executes through real Pi and native HTTP adapter, retains revisions and never repeats uncertain requests`, async t => {
  const { accounts, directory, login } = await fixture(t);
  await login(provider);
  const status = await accounts.call('alice', provider, 'status');
  const model = status.models.find(m => m.providerModelId === (provider === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6-sol')).id;
  const route = await accounts.call('alice', provider, 'route', { model });
  let calls = 0, denied = false, browsers = 0;
  const worker = new KikkaWorker({ directory: join(directory, 'runs'), policy: { provider: 'burrow-routing' },
    routingEnabled: true, approvedUrls: ['https://example.com/'], resolveCredential: async body => { assert.equal(body.owner, 'alice'); return 'subscription-authorized'; },
    browser: async ({ evidenceDirectory }) => { browsers++; await writeFile(join(evidenceDirectory, 'page.png'), 'fixture'); return { text: 'Fixture monthly price 7 USD', url: 'https://example.com/', capturedAt: '2026-10-21T00:00:00Z', screenshot: 'page.png', sha256: createHash('sha256').update('fixture').digest('hex') }; },
    inferenceTransport: async (url, init) => {
      calls++; const body = JSON.parse((init.headers['content-encoding'] === 'zstd' ? zlib.zstdDecompressSync(init.body) : init.body).toString());
      assert.equal(body.model, route.providerModelId); assert.equal(init.redirect, 'error');
      assert.match(init.headers.authorization, provider === 'claude' ? /^Bearer sk-ant-oat01-fixture/ : /^Bearer a\./);
      if (denied) throw new Error('Unknown provider outcome');
      const read = JSON.stringify(body).includes('Fixture monthly price');
      let events;
      if (provider === 'claude') {
        const block = read ? { type: 'text', text: 'Sourced fixture comparison.' } : { type: 'tool_use', id: 'page-1', name: 'read_public_page', input: { url: 'https://example.com/' } };
        events = [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 30, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: read ? { ...block, text: '' } : { ...block, input: {} } },
          { type: 'content_block_delta', index: 0, delta: read ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: read ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 10 } }, { type: 'message_stop' }];
      } else {
        const item = read ? { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Sourced fixture comparison.', annotations: [] }] }
          : { type: 'function_call', id: 'f', call_id: 'page-1', name: 'read_public_page', arguments: JSON.stringify({ url: 'https://example.com/' }) };
        events = [{ type: 'response.created', response: { id: 'fixture', status: 'in_progress' } },
          { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } }];
      }
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
  worker.subscriptionAccounts = accounts;
  t.after(() => worker.close());
  const admission = { owner: 'alice', task: 'task', root_goal: 'root', goal: 'Compare the approved public page', max_cost_cents: 0, role: 'research', routing: Object.fromEntries(roles.map(r => [r, route])) };
  const id = await worker.start(admission);
  async function settle() {
    for (let n = 0; n < 300; n++) { const s = await worker.status(id); if (s.state !== 'Running') return s; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Fixture did not settle');
  }
  let result = await settle();
  assert.equal(result.state, 'Completed', JSON.stringify(result)); assert.equal(calls, 2); assert.equal(browsers, 1);
  assert.equal(result.usage.length, 2); assert.equal(result.usage[0].costSource, 'subscription'); assert.equal(result.usage[0].reportedCostMicros, null);
  await worker.close(); await worker.recover();
  assert.equal((await settle()).state, 'Completed'); assert.equal(calls, 2);
  await worker.control(id, { action: 'continue', request_id: 'revision', message: 'Shorten the saved result' });
  assert.equal((await settle()).state, 'Completed'); assert.equal(calls, 3);
  assert.equal((await worker.events(id)).filter(e => e.type === 'final_message').length, 2);
  denied = true;
  await worker.control(id, { action: 'continue', request_id: 'uncertain', message: 'Revise again' });
  assert.equal((await settle()).state, 'Paused'); assert.equal(calls, 4);
  await worker.close(); await worker.recover();
  assert.equal((await settle()).state, 'Paused'); assert.equal(calls, 4);
  await assert.rejects(worker.control(id, { action: 'resume', request_id: 'repeat' }));
  await worker.control(id, { action: 'stop', request_id: 'stop' });
  for (let n = 0; n < 100 && (await worker.status(id)).state === 'Stopping'; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal((await worker.status(id)).state, 'Cancelled');
  assert.equal(calls, 4);

  // The cap is cumulative, not a fresh allowance after a restart or revision.
  denied = false;
  const capped = await worker.start({ ...admission, task: 'capped', root_goal: 'capped' });
  const settleCapped = async () => {
    for (let n = 0; n < 300 && (await worker.status(capped)).state === 'Running'; n++) await new Promise(r => setTimeout(r, 5));
    return worker.status(capped);
  };
  assert.equal((await settleCapped()).state, 'Completed');
  for (let n = 0; n < 18; n++) {
    await worker.control(capped, { action: 'continue', request_id: `revision-${n}`, message: 'Shorten the saved result' });
    assert.equal((await settleCapped()).state, 'Completed');
  }
  assert.equal((await worker.status(capped)).usage.length, 20);
  await worker.close();
  const before = calls;
  await worker.recover();
  await worker.control(capped, { action: 'continue', request_id: 'after-restart', message: 'Shorten the saved result' });
  assert.equal((await settleCapped()).state, 'Paused');
  assert.equal(calls, before, 'no 21st request after recovery');
  assert.match((await worker.status(capped)).review, /20-request/);
});

test('subscription transport rejects another endpoint, another model, redirects and a second dispatch', async () => {
  const route = { connectionId: 'subscription-claude', endpoint: 'https://api.anthropic.com/v1/messages', providerModelId: 'approved' };
  let calls = 0;
  const transport = subscriptionTransport(route, async () => { calls++; return new Response('ok'); });
  const init = { method: 'POST', body: JSON.stringify({ model: 'approved' }) };
  await assert.rejects(transport('https://evil.example/', init));
  await assert.rejects(transport(route.endpoint, { ...init, body: JSON.stringify({ model: 'other' }) }));
  await transport(route.endpoint, init);
  await assert.rejects(transport(route.endpoint, init));
  assert.equal(calls, 1);
  await assert.rejects(subscriptionTransport(route, async () => new Response(null, { status: 307 }))(route.endpoint, init), /redirect/);
});
