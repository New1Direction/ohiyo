import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { KikkaWorker } from '../src/runtime.mjs';
import { roles, routedPayload, routedTransport, validateRouting, credentialResolver } from '../src/routing.mjs';

// All inference and page content below is synthetic. The installed Pi adapter,
// its SQLite journal, tools, budgets and recovery are real.
const key = 'fixture-dedicated-routing-key';
const page = 'https://example.com/';
function routes() {
  const main = { canonicalModel: 'test/research', providerModelId: 'research-main', connectionId: 'personal-one',
    connectionRevision: 'version-1', fundedBy: 'you', endpoint: 'https://research.example/v1/chat/completions',
    contextWindow: 100000, maxOutputTokens: 1000, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3 };
  return Object.fromEntries(roles.map(role => [role, role === 'summary' ? { ...main, canonicalModel: 'test/summary',
    providerModelId: 'summary-small', connectionId: 'ohiyo-default', fundedBy: 'ohiyo',
    endpoint: 'https://summary.example/v1/chat/completions', contextWindow: 200000,
    maxOutputTokens: 300, inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.4 } : { ...main }]));
}
async function settle(worker, id) {
  for (let i = 0; i < 300; i++) {
    const status = await worker.status(id);
    if (status.state !== 'Running') return status;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Routing fixture did not settle.');
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'burrow-routing-'));
  const requests = [], authorizations = [];
  let browserCalls = 0;
  const admission = { owner: 'alice-private', task: 'task-1', root_goal: 'root-1', goal: 'Compare the public plan.',
    max_cost_cents: options.cents ?? 50, role: 'research', routing: routes() };
  if (options.free) for (const route of Object.values(admission.routing)) {
    route.inputUsdPerMillion = 0; route.outputUsdPerMillion = 0;
  }
  const worker = new KikkaWorker({ directory, policy: { provider: 'burrow-routing' }, routingEnabled: true,
    approvedUrls: [page], resolveCredential: async request => {
      authorizations.push(request);
      if (options.authorization) return options.authorization(request);
      return key;
    }, inferenceTransport: async (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      const body = JSON.parse(init.body); requests.push({ url, body });
      assert.ok(!init.body.includes('alice-private'));
      if (options.denied) return Response.json({ error: { message: `Denied ${key}`, code: 403 } }, { status: 403 });
      if (options.requestLimit && init.body.length > options.requestLimit) return Response.json({ error: { message: 'Request exceeds context quota' } }, { status: 413 });
      const read = body.messages.some(m => m.role === 'tool');
      const summary = body.model === 'summary-small';
      const annual = body.messages.some(m => JSON.stringify(m).includes('annual'));
      const delta = read || summary ? { content: summary ? 'Summary fixture.' : annual ? 'Annual unavailable; retained captured monthly fixture.'
        : 'Comparison from captured public fixture: USD 7 monthly.' + (options.answerPadding ?? '') }
        : { role: 'assistant', tool_calls: [{ index: 0, id: 'source-1', type: 'function',
          function: { name: 'read_public_page', arguments: JSON.stringify({ url: page }) } }] };
      return new Response(`data: ${JSON.stringify({ id: 'fixture', model: body.model,
        choices: [{ index: 0, delta, finish_reason: read || summary ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 73, completion_tokens: 11, total_tokens: 84 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } });
    }, browser: async ({ evidenceDirectory }) => {
      browserCalls++;
      await writeFile(join(evidenceDirectory, 'fixture.png'), 'fixture-evidence');
      return { url: page, capturedAt: '2026-10-20T00:00:00Z', text: 'Captured public fixture: USD 7 monthly.' + (options.pagePadding ?? ''), screenshot: 'fixture.png', sha256: createHash('sha256').update('fixture-evidence').digest('hex') };
    } });
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  const id = await worker.start(admission);
  return { worker, id, admission, requests, authorizations, browserCalls: () => browserCalls };
}

test('revisions fit a bounded provider context without discarding saved source evidence or prior answers', async t => {
  const { worker, id, requests, browserCalls } = await setup(t, {
    pagePadding: 'x'.repeat(6000), answerPadding: 'y'.repeat(4500), requestLimit: 10000,
  });
  assert.equal((await settle(worker, id)).state, 'Completed');
  const before = await worker.events(id);
  const evidence = before.find(e => e.type === 'evidence').data;
  const original = before.find(e => e.type === 'final_message').data.content;
  await worker.control(id, { request_id: 'annual-revision', action: 'continue', message: 'Compare annual billing using the saved evidence.' });
  assert.equal((await settle(worker, id)).state, 'Completed');
  const after = await worker.events(id);
  assert.equal(after.find(e => e.type === 'evidence').data.text, evidence.text);
  assert.equal(after.filter(e => e.type === 'final_message')[0].data.content, original);
  assert.match(after.filter(e => e.type === 'final_message').at(-1).data.content, /Annual unavailable/);
  assert.equal(requests.length, 3);
  assert.equal(browserCalls(), 1);
});

test('role routing uses the actual Pi adapter, pins aliases/payers, gates summaries and preserves usage/evidence across restart and revision', async t => {
  const { worker, id, admission, requests, authorizations, browserCalls } = await setup(t);
  let status = await settle(worker, id);
  assert.equal(status.state, 'Completed'); assert.equal(requests.length, 2); assert.equal(browserCalls(), 1);
  assert.equal(requests[0].url, 'https://research.example/v1/chat/completions');
  assert.equal(requests[0].body.model, 'research-main');
  assert.equal(requests[0].body.max_tokens, 1000);
  assert.equal(authorizations[0].owner, 'alice-private'); assert.equal(authorizations[0].root_goal, 'root-1');
  assert.equal(status.reserved_micros, 20600);
  assert.equal(status.usage.length, 2);
  assert.equal(status.usage[0].usage.input, 73); assert.equal(status.usage[0].usage.output, 11);
  assert.equal(status.usage[0].fundedBy, 'you'); assert.equal(status.usage[0].connectionId, 'personal-one');
  assert.equal(status.usage[0].reportedCostMicros, 11); // ceil(73 × .1 + 11 × .3)
  const evidence = (await worker.events(id)).find(e => e.type === 'evidence').data.id;
  const beforeUsage = status.usage;
  await worker.close(); await worker.recover();
  assert.deepEqual((await worker.status(id)).usage, beforeUsage);
  assert.equal(requests.length, 2); assert.equal(authorizations.length, 2);
  assert.equal((await worker.evidence(id, evidence)).toString(), 'fixture-evidence');
  admission.routing.research.providerModelId = 'must-not-change-saved-route';
  await worker.control(id, { request_id: 'annual', action: 'continue', message: 'Show annual billing where offered; keep monthly pricing otherwise.' });
  status = await settle(worker, id);
  assert.equal(status.state, 'Completed'); assert.equal(requests.length, 3); assert.equal(browserCalls(), 1);
  assert.equal(requests[2].body.model, 'research-main');
  assert.equal((await worker.events(id)).filter(e => e.type === 'final_message').length, 2);
  const run = worker.runs.get(id);
  await run.conversation.submit({ type: 'write', entry: { kind: 'fixture.context', model: [
    { role: 'user', content: 'Historical public context. '.repeat(5000), timestamp: Date.now() },
  ] } }, context);
  const compact = await run.conversation.compact('Summarize public context.', context);
  const result = await run.harness.waitForTask(compact, context);
  assert.equal(result.state.outcome.status, 'completed');
  status = await worker.status(id);
  assert.equal(requests.length, 4); assert.equal(requests[3].url, 'https://summary.example/v1/chat/completions');
  assert.equal(requests[3].body.model, 'summary-small'); assert.equal(requests[3].body.max_tokens, 300);
  assert.equal(status.reserved_micros, 71020); // 3 × 10300 + 40120, not refunded by usage.
  assert.equal(status.usage[3].role, 'summary'); assert.equal(status.usage[3].fundedBy, 'ohiyo');
  assert.equal(authorizations[3].connectionId, 'ohiyo-default');
  assert.ok(!(await readFile(join(run.path, 'bridge.sqlite'))).includes(Buffer.from(key)));
  assert.ok(!(await readFile(join(run.path, 'pi.sqlite'))).includes(Buffer.from(key)));
});

test('budget and revoked connections prevent dispatch; denial never falls back or retries after reopen', async t => {
  await assert.rejects(setup(t, { cents: 0 }), /Invalid admission/);
  const free = await setup(t, { cents: 0, free: true });
  assert.equal((await settle(free.worker, free.id)).state, 'Completed');
  assert.equal(free.requests.length, 2);
  assert.equal((await free.worker.status(free.id)).reserved_micros, 0);
  const small = await setup(t, { cents: 1 });
  assert.equal((await settle(small.worker, small.id)).state, 'Paused');
  assert.equal(small.requests.length, 0); assert.equal(small.authorizations.length, 0);
  const shared = await setup(t, { cents: 4 });
  assert.equal((await settle(shared.worker, shared.id)).state, 'Completed');
  const run = shared.worker.runs.get(shared.id);
  await run.conversation.submit({ type: 'write', entry: { kind: 'fixture.context', model: [
    { role: 'user', content: 'Public research context. '.repeat(5000), timestamp: Date.now() },
  ] } }, context);
  const compact = await run.conversation.compact('Summarize within the remaining research budget.', context);
  await run.harness.waitForTask(compact, context);
  assert.equal((await shared.worker.status(shared.id)).state, 'Paused');
  assert.equal(shared.requests.length, 2); assert.equal(shared.authorizations.length, 2);
  assert.equal((await shared.worker.status(shared.id)).reserved_micros, 20600);
  await shared.worker.close(); await shared.worker.recover();
  assert.equal(shared.requests.length, 2);
  assert.equal((await shared.worker.status(shared.id)).reserved_micros, 20600);
  const revoked = await setup(t, { authorization: async () => { throw new Error('revoked'); } });
  const blocked = await settle(revoked.worker, revoked.id);
  assert.equal(blocked.state, 'Paused'); assert.equal(blocked.reserved_micros, 0); assert.equal(revoked.requests.length, 0);
  const denied = await setup(t, { denied: true });
  const status = await settle(denied.worker, denied.id);
  assert.equal(status.state, 'Paused'); assert.equal(status.reserved_micros, 10300);
  assert.equal(status.usage[0].status, 'dispatching'); assert.equal(status.usage[0].reportedCostMicros, null);
  assert.equal(denied.requests.length, 1);
  await denied.worker.close(); await denied.worker.recover();
  assert.equal((await denied.worker.status(denied.id)).state, 'Paused'); assert.equal(denied.requests.length, 1);
  await assert.rejects(denied.worker.control(denied.id, { request_id: 'retry', action: 'resume' }), /Needs you/);
});

test('Stop during credential resolution prevents the first inference and waits for acknowledgement', async t => {
  let enter, release;
  const entered = new Promise(r => { enter = r; });
  const authorization = new Promise(r => { release = r; });
  const { worker, id, requests } = await setup(t, { authorization: async () => { enter(); return authorization; } });
  await entered;
  await worker.control(id, { request_id: 'stop', action: 'stop' });
  release(key);
  for (let i = 0; i < 300 && (await worker.status(id)).state !== 'Cancelled'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal((await worker.status(id)).state, 'Cancelled'); assert.equal(requests.length, 0);
  assert.equal((await worker.status(id)).reserved_micros, 0);
});

test('routing transport forbids credential leakage, redirects, arbitrary tools and automatic retransmission', async () => {
  const route = routes().research;
  let calls = 0;
  const send = routedTransport(route, key, async (url, init) => {
    calls++; assert.equal(url, route.endpoint);
    assert.equal(init.headers.Authorization, `Bearer ${key}`); assert.equal(init.headers.Cookie, undefined);
    return Response.redirect('https://unapproved.example/', 307);
  });
  const payload = routedPayload(route, { messages: [{ role: 'user', content: 'public' }] });
  const options = body => ({ method: 'POST', body: JSON.stringify(body), headers: { Cookie: 'private', Authorization: 'wrong' } });
  await assert.rejects(send('https://unapproved.example/', options(payload)), /Unapproved/);
  for (const extra of [{ models: ['paid/fallback'] }, { model: 'wrong' }, { plugins: [{ id: 'web' }] },
    { tools: [{ type: 'function', function: { name: 'shell' } }] }]) {
    await assert.rejects(send(route.endpoint, options({ ...payload, ...extra })), /Unapproved/);
  }
  assert.equal(calls, 0);
  await assert.rejects(send(route.endpoint, options(payload)), /redirects/);
  await assert.rejects(send(route.endpoint, options(payload)), /Unapproved/); assert.equal(calls, 1);
  for (const endpoint of ['https://127.0.0.1/v1/chat/completions', 'https://opencode.ai/v1/chat/completions',
    'https://user:password@example.com/v1/chat/completions', 'https://example.com/v1/chat/completions?key=secret']) {
    const routing = routes(); routing.research.endpoint = endpoint;
    assert.throws(() => validateRouting(routing));
  }
  assert.throws(() => credentialResolver('https://external.example/api/v1/burrow/internal/model-access', 'f'.repeat(32)));
});
