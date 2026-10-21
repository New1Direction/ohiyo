import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { Crawl4aiEngine } from '../src/crawl4ai-engine.mjs';
import { ComputerProvider } from '../src/computer-provider.mjs';
import { ImOrbComputerBackend } from '../src/imorb-computer.mjs';
import { ComputerNotDispatched } from '../src/computer-contract.mjs';
import { batchFetch, normalizeHotel } from '../src/hotel-research.mjs';
import { KikkaWorker } from '../src/runtime.mjs';
import { BrowserServiceFixture, engineBackend, urls, png } from './fixtures/browser-service.mjs';
import { PythonBrowserFixture } from './fixtures/python-browser-service.mjs';

const identity = { account: 'alice', workspace_id: 'travel', task_id: 'tokyo', root_goal_id: 'root-tokyo', request_id: 'open' };
const features = ['browser.cdp', 'browser.navigate', 'browser.read', 'browser.tabs', 'browser.screenshot', 'screenshot'];
const grant = { account: 'alice', workspace_id: 'travel', features, allowed_urls: [...urls, 'https://hotels.example/missing'], read_only_urls: urls };
const read = { operation: 'browser.read', args: {}, replay_class: 'read_only' };
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'burrow-crawl4ai-'));
  const service = new BrowserServiceFixture();
  const engine = new Crawl4aiEngine({ transport: service });
  const backend = engineBackend(engine);
  let provider;
  const reopen = async () => { await provider?.close(); provider = new ComputerProvider({ directory, backend, grants: [grant] }); return provider; };
  t.after(async () => { await provider?.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service, engine, reopen };
}

test('browser engine discovers exact version, validates artifact ownership, and preserves ambiguous health failures', async t => {
  const f = await setup(t); const p = await f.reopen(); const allocation = await p.open(identity);
  assert.equal(allocation.state, 'ready'); assert.deepEqual(allocation.capabilities.features, features);
  assert.ok(!allocation.capabilities.features.includes('browser.extract'));
  f.service.version = 'wrong'; assert.equal((await f.engine.status({ ...allocation, ...identity })).state, 'unavailable');
  f.service.version = '0.9.5';
  const screenshot = await p.execute({ ...identity, request_id: 'screenshot' }, { operation: 'screenshot', args: { surface: 'browser' }, replay_class: 'read_only' });
  assert.equal(screenshot.status, 'complete');
  const artifact = screenshot.output.artifacts[0];
  assert.equal(artifact.source_url, urls[0]); assert.ok(Date.parse(artifact.fetched_at));
  assert.equal(artifact.identity.root_goal_id, identity.root_goal_id);
  assert.deepEqual(Buffer.from(artifact.base64, 'base64'), png);
  const before = f.service.calls.length;
  await assert.rejects(f.engine.execute({ ...identity, computer_id: allocation.computer_id }, { ...identity, account: 'bob' }, read, { signal: new AbortController().signal }), /ownership/);
  assert.equal(f.service.calls.length, before);
  f.service.mutate = data => { data.artifacts[0].identity.account = 'bob'; };
  assert.equal((await p.execute({ ...identity, request_id: 'foreign' }, read)).status, 'unavailable');
  f.service.disconnected = true;
  await assert.rejects(f.engine.status(allocation), error => !(error instanceof ComputerNotDispatched));
  // Real ImOrb dispatch selection must not turn a swallowed health timeout into
  // a typed non-dispatch assertion when the operation could have crossed it.
  const host = new ImOrbComputerBackend({ binary: '/missing/orbd', home: f.directory, repo: f.directory, engines: [f.engine] });
  await assert.rejects(host.execute(allocation, identity, { operation: 'browser.navigate', args: { url: urls[0] } }, { signal: new AbortController().signal }),
    error => !(error instanceof ComputerNotDispatched));
});

test('batch fetch keeps independent receipts, acknowledged 404 does not block others, cancellation returns partial results', async t => {
  const f = await setup(t); const p = await f.reopen(); await p.open(identity);
  const result = await batchFetch(p, { ...identity, request_id: 'batch' }, [urls[0], 'https://hotels.example/missing', urls[1]]);
  assert.deepEqual(result.results.map(r => r.status), ['complete', 'failed', 'complete']);
  assert.equal(result.results[1].output.failure.status, 404);
  assert.equal(result.results[2].output.hotel.displayed_price, '22,000 per night');
  assert.equal(new Set(result.results.map(r => r.request_id)).size, 3);
  const before = f.service.calls.length;
  await batchFetch(p, { ...identity, request_id: 'batch' }, [urls[0], 'https://hotels.example/missing', urls[1]]);
  assert.equal(f.service.calls.length, before, 'committed pages are not fetched twice');
  const controller = new AbortController();
  f.service.afterNavigate = async () => controller.abort();
  const partial = await batchFetch(p, { ...identity, request_id: 'cancel-batch' }, urls, { signal: controller.signal });
  assert.equal(partial.cancelled, true); assert.equal(partial.results.length, 1);
  assert.equal(partial.results[0].status, 'uncertain');
  assert.deepEqual(partial.pending, urls.slice(1));
  assert.equal(f.service.cancelled.root_goal_id, identity.root_goal_id);
});

test('uncertain navigation survives replacement/restart without replay; granted safe navigation alone can retry', async t => {
  const f = await setup(t); let p = await f.reopen(); await p.open(identity);
  f.service.loseAfterNavigate = true;
  const interrupted = await batchFetch(p, { ...identity, request_id: 'once' }, urls);
  assert.equal(interrupted.results[0].status, 'uncertain'); assert.equal(interrupted.pending.length, 2);
  const count = f.service.calls.length;
  f.service.disconnected = false; f.service.loseAfterNavigate = false;
  p = await f.reopen(); await p.reconnect(identity); await p.replace({ ...identity, request_id: 'replace' });
  const blocked = await batchFetch(p, { ...identity, request_id: 'different' }, urls);
  assert.equal(blocked.results[0].status, 'uncertain'); assert.equal(f.service.calls.length, count);
  const observed = await p.execute({ ...identity, request_id: 'observe' }, read);
  assert.equal(observed.output.source_url, urls[0]);
  await assert.rejects(p.execute({ ...identity, request_id: 'unsafe-downgrade' }, { operation: 'browser.navigate', args: { url: 'https://hotels.example/missing' }, replay_class: 'read_only' }), /classification/);
  f.service.loseAfterNavigate = true;
  const safe = { operation: 'browser.navigate', args: { url: urls[1] }, replay_class: 'read_only' };
  assert.equal((await p.execute({ ...identity, request_id: 'safe' }, safe)).status, 'unavailable');
  f.service.disconnected = false; f.service.loseAfterNavigate = false; await p.reconnect(identity);
  assert.equal((await p.execute({ ...identity, request_id: 'safe' }, safe)).status, 'complete');
});

test('Pi fixture demo researches three Shibuya hotels, records schema and Pi fallback Materials, and reopens same durable task', async t => {
  const f = await setup(t);
  const service = process.env.BURROW_BROWSER_REAL_PROCESSORS === '1' ? new PythonBrowserFixture() : f.service;
  if (service.close) t.after(() => service.close());
  const backend = engineBackend(new Crawl4aiEngine({ transport: service }));
  let generations = 0;
  const worker = new KikkaWorker({ directory: join(f.directory, 'worker'), policy: { provider: 'openai', modelId: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, maxOutputTokens: 4096 },
    approvedUrls: urls, computerFactory: () => new ComputerProvider({ directory: join(f.directory, 'pi-computers'), backend, grants: [grant] }),
    modelsFactory: () => {
      const models = createModels(); models.setProvider(openaiProvider());
      models.completeSimple = async (_model, input) => {
        const results = input.messages.filter(m => m.role === 'toolResult');
        let content, stopReason = 'toolUse';
        const tool = (name, args) => [{ type: 'toolCall', id: `call-${generations}`, name, arguments: args }];
        if (results.length === 0) content = tool('computer_open', {});
        else if (results.length === 1) content = tool('research_hotels', { urls });
        else if (results.length === 2) {
          const batch = JSON.parse(results.at(-1).content[0].text);
          assert.deepEqual(batch.results.map(r => r.output.extraction.path), ['css', 'xpath', 'llm_required']);
          for (const page of batch.results) {
            assert.ok(page.output.markdown);
            for (const capture of [page, page.screenshot]) for (const material of capture.output.artifacts) {
              assert.ok(material.id); assert.equal(material.text, undefined); assert.equal(material.content, undefined);
            }
          }
          service.disconnected = true;
          content = tool('computer_action', read);
        } else if (results.length === 3) {
          assert.equal(JSON.parse(results.at(-1).content[0].text).status, 'unavailable');
          service.disconnected = false;
          content = tool('computer_reconnect', {});
        } else if (results.length === 4) {
          assert.equal(JSON.parse(results.at(-1).content[0].text).state, 'ready');
          const batch = JSON.parse(results[1].content[0].text);
          const material = batch.results[2].output.artifacts.find(a => a.kind === 'markdown');
          content = tool('save_hotel_research', { material_id: material.id, hotel: {
            name: 'Shibuya Cloud Rooms (fictional)', address: '3 Invented Square, Shibuya, Tokyo', displayed_price: 'JPY 16,000 nightly',
            currency: 'JPY', room_types: ['Twin rooms'], amenities: ['Wi-Fi'], cancellation_text: 'Cancellation terms vary by room.' } });
        } else { content = [{ type: 'text', text: 'Three fictional Shibuya hotels researched. Prices advisory; no booking. Materials saved.' }]; stopReason = 'stop'; }
        generations++;
        return { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-4o-mini', timestamp: Date.now(), content, stopReason,
          usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      }; return models;
    } });
  t.after(() => worker.close());
  const run = await worker.start({ owner: 'alice', task: 'tokyo', root_goal: 'root-tokyo', goal: 'Research three Tokyo hotels near Shibuya Station.', max_cost_cents: 50, computer_workspace: 'travel' });
  for (let n = 0; n < 500 && (await worker.status(run)).state === 'Running'; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal((await worker.status(run)).state, 'Completed');
  const events = await worker.events(run); const materials = events.filter(e => e.type === 'material').map(e => e.data);
  assert.equal(materials.length, 10); assert.equal(materials.filter(m => m.kind === 'screenshot').length, 3);
  assert.ok(materials.every(m => m.identity.root_goal_id === identity.root_goal_id && m.advisory === true));
  const fallback = materials.find(m => m.extraction?.path === 'pi_llm');
  assert.equal(JSON.parse(fallback.content).displayed_price, 'JPY 16,000 nightly');
  assert.equal(JSON.parse(fallback.content).source_url, urls[2]);
  assert.equal(JSON.parse(fallback.content).rating, null);
  const image = materials.find(m => m.kind === 'screenshot');
  assert.deepEqual(await worker.evidence(run, image.id), png);
  await assert.rejects(worker.computer({ owner: 'bob', run, action: 'status', request_id: 'foreign' }), /scope/);
  const foreignRun = await worker.start({ owner: 'bob', task: 'bob-task', root_goal: 'bob-root', goal: 'Separate task.', max_cost_cents: 1 });
  await worker.control(foreignRun, { request_id: 'stop-foreign', action: 'stop' });
  await assert.rejects(worker.receipt(await worker.open(foreignRun), image.id), /ENOENT|Unknown evidence/);
  const count = generations, dispatched = service.calls.length, budget = (await worker.status(run)).reserved_micros;
  await worker.close(); await worker.recover();
  assert.equal((await worker.status(run)).state, 'Completed'); assert.equal(generations, count);
  assert.equal(service.calls.length, dispatched); assert.equal((await worker.status(run)).reserved_micros, budget);
  if (process.env.BURROW_BROWSER_DEMO_PATH) await writeFile(process.env.BURROW_BROWSER_DEMO_PATH,
    JSON.stringify({ live_imorb: false, model: 'deterministic model fixture in real Pi Durable', screenshots: 'tiny mock PNGs, not live hotel captures',
      real_crawl4ai_processors: process.env.BURROW_BROWSER_REAL_PROCESSORS === '1',
      run, status: await worker.status(run), browser_actions: service.calls, materials }, null, 2));
});

test('hotel extraction validates bounded typed data and cannot accept model-supplied provenance or booking authority', () => {
  const source = { source_url: urls[2], fetched_at: '2026-10-21T12:00:00Z' };
  assert.deepEqual(normalizeHotel({ name: 'Cloud', coords: { lat: 35.66, lng: 139.7 } }, source).coords, { lat: 35.66, lng: 139.7 });
  for (const hotel of [{ source_url: 'https://evil.example/' }, { advisory: false }, { currency: 'yen' }, { rating: 11 }, { coords: { lat: 91, lng: 1 } }, { displayed_price: 12000 }]) {
    assert.throws(() => normalizeHotel(hotel, source));
  }
});
