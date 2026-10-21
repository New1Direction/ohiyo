import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Campaign } from '../src/campaign.mjs';
import { freePolicy, inferenceEndpoint, unauthenticatedTransport } from '../src/opencode-free.mjs';
import { KikkaWorker } from '../src/runtime.mjs';

test('campaign caps cover different tasks and reopen; failed attempts retain slots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-campaign-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let campaign = new Campaign(join(directory, 'campaign.sqlite'));
  campaign.admit('model', 'task-a:request');
  assert.throws(() => campaign.admit('model', 'task-a:request'), /uncertain/);
  campaign.close(); campaign = new Campaign(join(directory, 'campaign.sqlite'));
  for (let i = 1; i < 30; i++) campaign.admit('model', `task-b:${i}`);
  for (let i = 0; i < 60; i++) campaign.admit('browser', 'same-safe-read-retried');
  assert.deepEqual(campaign.counts(), { model: 30, browser: 60 });
  assert.throws(() => campaign.admit('model', 'compaction:31'), /limit/);
  assert.throws(() => campaign.admit('browser', 'task-c:61'), /limit/);
  campaign.close();
});

function sse(delta, finish) {
  return new Response(`data: ${JSON.stringify({ id: 'fixture-completion', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } });
}

test('installed Pi Chat Completions adapter performs a tool round trip behind gate without credential inheritance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'free-adapter-'));
  let calls = 0, reads = 0;
  const original = globalThis.fetch;
  const worker = new KikkaWorker({ directory, policy: freePolicy, approvedUrls: ['https://example.com/'],
    browser: async ({ evidenceDirectory }) => {
      reads++; await writeFile(join(evidenceDirectory, 'page.png'), 'fixture');
      return { url: 'https://example.com/', text: 'A real tool result in this transport fixture', screenshot: 'page.png' };
    } });
  t.after(async () => { globalThis.fetch = original; await worker.close(); await rm(directory, { recursive: true, force: true }); });
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, inferenceEndpoint);
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Content-Type']);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const body = JSON.parse(options.body);
    assert.equal(body.model, freePolicy.modelId); assert.equal(body.max_tokens, 4096);
    assert.equal(body.stream, true); assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.ok(!options.body.includes('private-owner-id'));
    if (calls === 3) return new Response('Free route unavailable', { status: 503 });
    if (calls === 1) return sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-one', type: 'function',
      function: { name: 'read_public_page', arguments: '{"url":"https://example.com/"}' } }] }, 'tool_calls');
    assert.ok(body.messages.some(m => m.role === 'tool' && m.content.includes('A real tool result')));
    return sse({ role: 'assistant', content: 'Evidence-based fixture answer.' }, 'stop');
  };
  const run = await worker.start({ owner: 'private-owner-id', task: 'test', root_goal: 'root-test', goal: 'Read the approved public page.', max_cost_cents: 1 });
  let state;
  for (let i = 0; i < 300; i++) {
    state = await worker.status(run); if (state.state !== 'Running') break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(state.state, 'Completed', JSON.stringify(state));
  assert.equal(calls, 2); assert.equal(reads, 1);
  assert.equal(state.reserved_micros, 0);
  assert.deepEqual(worker.campaign.counts(), { model: 2, browser: 1 });
  await worker.close(); await worker.recover();
  assert.equal((await worker.status(run)).state, 'Completed'); assert.equal(calls, 2);
  assert.deepEqual(worker.campaign.counts(), { model: 2, browser: 1 });
  await worker.control(run, { request_id: 'revision', action: 'continue', message: 'Explain tax caveats.' });
  for (let i = 0; i < 300; i++) {
    state = await worker.status(run); if (state.state === 'Paused') break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(state.state, 'Paused'); assert.equal(calls, 3, 'no SDK retry of a 503');
  await worker.close(); await worker.recover();
  assert.equal((await worker.status(run)).state, 'Paused'); assert.equal(calls, 3, 'no durable resend');
  assert.deepEqual(worker.campaign.counts(), { model: 3, browser: 1 });
});

test('unauthenticated transport rejects alternate models, redirects and retransmissions', async () => {
  let count = 0;
  const transport = unauthenticatedTransport(async () => { count++; return new Response('unavailable', { status: 503 }); });
  const init = model => ({ method: 'POST', body: JSON.stringify({ model, stream: true, max_tokens: 4096 }) });
  await assert.rejects(transport(inferenceEndpoint, init('glm-5.3-flash')), /payload/);
  await assert.rejects(transport('https://other.example/', init(freePolicy.modelId)), /route/);
  assert.equal((await transport(inferenceEndpoint, init(freePolicy.modelId))).status, 503);
  await assert.rejects(transport(inferenceEndpoint, init(freePolicy.modelId)), /retransmission/);
  assert.equal(count, 1);
});
