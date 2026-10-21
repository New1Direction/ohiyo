import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Campaign } from '../src/campaign.mjs';
import { KikkaWorker } from '../src/runtime.mjs';
import { openRouterPolicy, openRouterEndpoint, selectedEndpoint, providerRestrictions,
  openRouterPayload, openRouterTransport, verifyOpenRouterSelection } from '../src/openrouter-free.mjs';

const key = 'dedicated-test-fixture-not-a-real-key';
const endpoint = { name: selectedEndpoint, model_id: openRouterPolicy.modelId, provider_name: 'Phala', tag: 'phala',
  status: 0, max_completion_tokens: 4096, pricing: { prompt: '0', completion: '0' },
  supported_parameters: ['tools', 'tool_choice', 'max_tokens'], supports_tool_choice: { auto: true }, supports_implicit_caching: false };
const dataPolicy = { training: false, trainingOpenRouter: false, retainsPrompts: false,
  safetyRetention: false, canPublish: false, requiresUserIDs: false };
const model = { id: openRouterPolicy.modelId, pricing: endpoint.pricing, supported_parameters: endpoint.supported_parameters };

test('eligibility rejects paid, non-ZDR, training, missing parameters and changed endpoints', async () => {
  const fixture = () => [{ data: structuredClone(model) }, { data: { id: model.id, endpoints: [structuredClone(endpoint)] } },
    { data: [structuredClone(endpoint)] }, { data: [{ slug: 'phala', dataPolicy: structuredClone(dataPolicy) }] }];
  const check = async documents => {
    let i = 0;
    return verifyOpenRouterSelection(async (_url, options) => {
      assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error');
      return Response.json(documents[i++]);
    });
  };
  assert.equal((await check(fixture())).endpoint.name, selectedEndpoint);
  for (const mutate of [
    d => { d[0].data.pricing.prompt = '0.000001'; },
    d => { d[1].data.endpoints[0].pricing.request = '0.01'; },
    d => { d[2].data = []; },
    d => { d[3].data[0].dataPolicy.training = true; },
    d => { d[3].data[0].dataPolicy.retainsPrompts = true; },
    d => { d[1].data.endpoints[0].supported_parameters = ['max_tokens']; },
    d => { d[1].data.endpoints[0].name = 'another endpoint'; },
  ]) { const documents = fixture(); mutate(documents); await assert.rejects(check(documents), /not eligible/); }
});

test('dedicated authorization is host-pinned; redirects, plugins and fallback overrides are refused', async () => {
  let calls = 0;
  const send = openRouterTransport(key, async (url, init) => {
    calls++; assert.equal(url, openRouterEndpoint);
    assert.deepEqual(init.headers, { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
      'X-OpenRouter-Cache': 'false' });
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    return Response.redirect('https://unapproved.example/', 307);
  });
  const payload = openRouterPayload({ messages: [{ role: 'user', content: 'Public fixture' }] });
  const options = body => ({ method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer unrelated-key', Cookie: 'private' } });
  await assert.rejects(send('https://unapproved.example/', options(payload)), /route/);
  for (const extra of [{ models: ['paid/model'] }, { plugins: [{ id: 'web' }] },
    { provider: { ...providerRestrictions, allow_fallbacks: true } }, { model: 'openrouter/auto' },
    { tools: [{ type: 'web_search' }] }]) {
    await assert.rejects(send(openRouterEndpoint, options({ ...payload, ...extra })), /payload/);
  }
  assert.equal(calls, 0);
  await assert.rejects(send(openRouterEndpoint, options(payload)), /redirects/);
  await assert.rejects(send(openRouterEndpoint, options(payload)), /retransmission/);
  assert.equal(calls, 1);
  assert.throws(() => openRouterTransport(), /dedicated/);
});

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'router-worker-'));
  const campaignPath = join(directory, 'campaign.sqlite');
  const campaign = new Campaign(campaignPath);
  campaign.admit('model', 'earlier-rejected-opencode-fixture');
  for (let i = 1; i < (options.priorCalls ?? 1); i++) campaign.admit('model', `prior-fixture-${i}`);
  campaign.close();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, openRouterEndpoint); assert.equal(init.headers.Authorization, `Bearer ${key}`);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.provider, providerRestrictions); assert.deepEqual(body.plugins, []);
    assert.ok(!init.body.includes('private-owner'));
    if (options.denied) return Response.json({ error: { message: `Denied ${key}`, code: 403 } }, { status: 403 });
    const hasResult = body.messages.some(m => m.role === 'tool' && m.content.includes('Captured public fixture'));
    const delta = hasResult ? { content: 'Comparison grounded in captured public fixture.' }
      : { role: 'assistant', tool_calls: [{ index: 0, id: 'read-one', type: 'function',
        function: { name: 'read_public_page', arguments: '{"url":"https://example.com/"}' } }] };
    return new Response(`data: ${JSON.stringify({ id: 'fixture', model: model.id,
      choices: [{ index: 0, delta, finish_reason: hasResult ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const worker = new KikkaWorker({ directory, policy: openRouterPolicy, approvedUrls: ['https://example.com/'],
    campaignPath, openRouterKey: key, gatewayPrivacyConfirmed: true, verifyRoute: async () => ({ fixture: true, endpoint }),
    browser: async ({ evidenceDirectory }) => {
      await writeFile(join(evidenceDirectory, 'fixture.png'), 'fixture');
      return { url: 'https://example.com/', text: 'Captured public fixture', screenshot: 'fixture.png', sha256: createHash('sha256').update('fixture').digest('hex') };
    } });
  t.after(async () => { globalThis.fetch = original; await worker.close(); await rm(directory, { recursive: true, force: true }); });
  const id = await worker.start({ owner: 'private-owner', task: 'fixture', root_goal: 'fixture-root', goal: 'Read the approved page.', max_cost_cents: 1 });
  return { worker, id, calls: () => calls };
}
async function settle(worker, id) {
  for (let i = 0; i < 300; i++) {
    const status = await worker.status(id);
    if (status.state !== 'Running') return status;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Fixture did not settle.');
}

test('actual Pi adapter preserves original campaign count, completed tool results and cap across reopen', async t => {
  const { worker, id, calls } = await setup(t, { priorCalls: 28 });
  assert.equal((await settle(worker, id)).state, 'Completed');
  assert.equal(calls(), 2); assert.deepEqual(worker.campaign.counts(), { model: 30, browser: 1 });
  const evidence = (await worker.events(id)).find(e => e.type === 'evidence');
  await worker.close(); await worker.recover();
  assert.equal((await worker.status(id)).state, 'Completed'); assert.equal(calls(), 2);
  assert.equal((await worker.evidence(id, evidence.data.id)).toString(), 'fixture');
  await worker.control(id, { action: 'continue', request_id: 'annual', message: 'Show annual billing where offered; keep monthly pricing otherwise.' });
  assert.equal((await settle(worker, id)).state, 'Paused'); assert.equal(calls(), 2);
  assert.deepEqual(worker.campaign.counts(), { model: 30, browser: 1 });
  assert.ok(!JSON.stringify(worker.runs.get(id).db.prepare('SELECT * FROM model_trace').all()).includes(key));
  assert.throws(() => worker.campaign.pin({ other: 'provider' }), /different route/);
});

test('explicit access denial pauses without SDK or restart retry and redacts an upstream credential echo', async t => {
  const { worker, id, calls } = await setup(t, { denied: true });
  assert.equal((await settle(worker, id)).state, 'Paused'); assert.equal(calls(), 1);
  assert.deepEqual(worker.campaign.counts(), { model: 2, browser: 0 });
  const trace = worker.runs.get(id).db.prepare('SELECT * FROM model_trace').all();
  assert.ok(!JSON.stringify(trace).includes(key)); assert.match(JSON.stringify(trace), /redacted/);
  await worker.close(); await worker.recover();
  assert.equal((await worker.status(id)).state, 'Paused'); assert.equal(calls(), 1);
  await assert.rejects(worker.control(id, { action: 'resume', request_id: 'retry' }), /Needs you/);
});

test('changing provider cannot silently create or replace the campaign ledger', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'router-empty-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.throws(() => new Campaign(join(directory, 'absent.sqlite'), { requireExisting: true }), /refusing to reset/);
  const empty = new Campaign(join(directory, 'empty.sqlite')); empty.close();
  assert.throws(() => new Campaign(join(directory, 'empty.sqlite'), { requireExisting: true }), /earlier model attempt/);
  assert.throws(() => new KikkaWorker({ directory, policy: openRouterPolicy }), /original campaign ledger/);
  assert.throws(() => new KikkaWorker({ directory, campaignPath: join(directory, 'empty.sqlite'),
    policy: openRouterPolicy, openRouterKey: key }), /gateway prompt logging/);
});
