// Local acceptance fixture: actual Pi + actual public-page browser, SIMULATED model.
// Never import this file from production. No provider credentials are used.
import { appendFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { KikkaWorker } from '../../src/runtime.mjs';
import { workerServer } from '../../src/server.mjs';
import { readPublicPage } from '../../src/browser.mjs';

const directory = process.env.KIKKA_WORKER_DIRECTORY;
const config = JSON.parse(await readFile(new URL('../../research.example.json', import.meta.url), 'utf8'));
const worker = new KikkaWorker({ ...config, directory,
  modelsFactory: () => {
    const models = createModels(); models.setProvider(openaiProvider());
    models.completeSimple = async (model, input) => {
      appendFileSync(join(directory, 'fixture-provider-calls.jsonl'), JSON.stringify({ at: new Date().toISOString(), messages: input.messages.length }) + '\n');
      const reads = input.messages.filter(m => m.role === 'toolResult' && !m.isError);
      const annual = input.messages.some(m => m.role === 'user' && JSON.stringify(m).includes('annual'));
      const latest = input.messages.findLast(m => m.role === 'user');
      const instruction = typeof latest?.content === 'string' ? latest.content : latest?.content?.map(c => c.text ?? '').join(' ');
      const content = reads.length < config.approvedUrls.length
        ? [{ type: 'toolCall', id: `page-${reads.length}`, name: 'read_public_page', arguments: { url: config.approvedUrls[reads.length] } }]
        : [{ type: 'text', text: `TEST FIXTURE — simulated model, real saved public pages.\n\n${annual ? 'Annual-plan revision requested.' : 'Monthly plans requested.'}\nLatest instruction: ${instruction}\nThis tests durable research and saved revisions, not live model quality or a verified price comparison.\n\n${reads.map(m => {
          const evidence = JSON.parse(m.content.find(c => c.type === 'text').text);
          return `${evidence.url}\nCaptured: ${evidence.capturedAt}\nEvidence: ${evidence.evidenceId}\nRegional page only. Tax and eligibility have not been verified.`;
        }).join('\n\n')}\n\nNo signup, purchase, regional egress verification or currency conversion was performed.` }];
      return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content, stopReason: reads.length < config.approvedUrls.length ? 'toolUse' : 'stop',
        usage: { input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    };
    return models;
  },
  browser: async options => {
    // Pause a free read after at least one capture, making restart/steering repeatable.
    while (options.url === config.approvedUrls[1] && existsSync(join(directory, 'hold-browser'))) {
      if (options.signal.aborted) { await delay(1500); options.signal.throwIfAborted(); }
      await delay(50);
    }
    return readPublicPage(options);
  },
});
await worker.recover();
const server = workerServer(worker, process.env.KIKKA_WORKER_TOKEN);
server.listen(Number(process.env.KIKKA_WORKER_PORT ?? 3102), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  server.close(); await worker.close(); process.exit(0);
});
