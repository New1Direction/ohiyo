// Real Pi Durable + private HTTP bridge. Only model completions are scripted;
// travel capabilities always call the real Burrow server and its SQLite ledger.
import { existsSync, writeFileSync } from 'node:fs';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { KikkaWorker } from '../../src/runtime.mjs';
import { workerServer } from '../../src/server.mjs';
import { travelTransport } from '../../src/travel.mjs';

const [base, directory, port, pauseFile] = process.argv.slice(2);
const token = 'fixture-only-worker-token-not-a-secret';
const transport = travelTransport(`${base}/api/v1/burrow/internal/travel`, token);
const worker = new KikkaWorker({ directory, approvedUrls: [],
  policy: { provider: 'openai', modelId: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, maxOutputTokens: 4096 },
  browser: async () => { throw new Error('Travel must not browse'); },
  travelTransport: async (...args) => {
    const result = await transport(...args);
    if (pauseFile && args[0].operation === 'select' && !existsSync(pauseFile)) {
      writeFileSync(pauseFile, 'quote committed before worker crash');
      await new Promise(() => {});
    }
    return result;
  },
  modelsFactory: () => {
    const models = createModels(); models.setProvider(openaiProvider());
    models.completeSimple = async (_model, input) => {
      const results = input.messages.filter(m => m.role === 'toolResult');
      const last = results.length ? JSON.parse(results.at(-1).content[0].text) : null;
      let name = 'travel_research', args = {};
      if (last?.stage === 'comparing') {
        name = 'travel_select';
        const rates = [...last.comparison.options].sort((a, b) => a.rate.total.minor - b.rate.total.minor);
        args = { rate_id: rates[0].rate.rate_id, reason: 'Lowest admitted provider total; inside the stored area and refund limits.' };
      } else if (last?.stage === 'quoting') name = 'travel_book';
      else if (last && !last.terminal) name = 'travel_reconcile';
      return { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-4o-mini', timestamp: Date.now(),
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: last?.terminal ? [{ type: 'text', text: 'See the authoritative saved fixture result.' }]
          : [{ type: 'toolCall', id: `travel-${results.length}`, name, arguments: args }],
        stopReason: last?.terminal ? 'stop' : 'toolUse' };
    };
    return models;
  },
});
const server = workerServer(worker, token);
await worker.recover();
server.listen(Number(port), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  server.close(); await worker.close(); process.exit(0);
});
