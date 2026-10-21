// Fault fixture: real Pi Durable, simulated provider/browser. NEVER live evidence.
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { KikkaWorker } from '../../src/runtime.mjs';
import { workerServer } from '../../src/server.mjs';

const [mode, directory] = process.argv.slice(2);
await mkdir(directory, { recursive: true });
const policy = { provider: 'openai', modelId: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, maxOutputTokens: 4096 };
const models = () => {
  const m = createModels(); m.setProvider(openaiProvider());
  m.completeSimple = async (model, input) => {
    const read = input.messages.some(m => m.role === 'toolResult');
    appendFileSync(join(directory, 'provider-calls'), `${read ? 'after-evidence' : 'initial'}\n`);
    if (mode === 'raw' || (read && existsSync(join(directory, 'hold-model')))) await new Promise(() => {});
    return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: read ? [{ type: 'text', text: 'Fixture research result' }]
        : [{ type: 'toolCall', name: 'read_public_page', id: 'source-1', arguments: { url: 'https://example.com/' } }],
      stopReason: read ? 'stop' : 'toolUse',
      usage: { input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  };
  m.streamSimple = (model, input, options) => {
    const stream = new AssistantMessageEventStream();
    void m.completeSimple(model, input, options).then(message => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); });
    return stream;
  };
  return m;
};
if (mode === 'raw') {
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'pi.sqlite')), {
    models: models(), registry: createRegistry(), settings: { retry: { enabled: false }, stream: { maxRetries: 0 } },
  }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'gpt-4o-mini' } } });
  await root.submit({ type: 'input', content: 'Research.', requestId: 'same-admission' }, context);
  harness.resume(); process.send({ ready: true });
} else {
  const worker = new KikkaWorker({ directory, policy, approvedUrls: ['https://example.com/'], modelsFactory: models,
    browser: async ({ evidenceDirectory }) => {
      appendFileSync(join(directory, 'browser-calls'), 'read\n');
      if (existsSync(join(directory, 'hold-browser'))) await new Promise(() => {});
      await writeFile(join(evidenceDirectory, 'page.png'), 'fixture-screenshot');
      return { url: 'https://example.com/', capturedAt: '2026-10-20T00:00:00.000Z', title: 'Fixture', text: 'Untrusted fixture', screenshot: 'page.png', sha256: 'fixture', verification: 'regional-page-only' };
    } });
  await worker.recover();
  const id = await worker.start({ owner: 'alice', task: 'research', root_goal: 'fixed-admission', goal: 'Read the approved page.', max_cost_cents: 25 });
  const server = workerServer(worker, 'f'.repeat(32));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.send({ ready: true, id, port: server.address().port });
}
setInterval(() => {}, 1000);
