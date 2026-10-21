// Disposable full-stack UI verification only. No live model service is called.
// Uses the real Pi loop, private Burrow credential API and public-page browser.
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KikkaWorker } from '../../src/runtime.mjs';
import { workerServer } from '../../src/server.mjs';
import { credentialResolver } from '../../src/routing.mjs';

const directory = process.env.KIKKA_WORKER_DIRECTORY;
if (!directory || !process.env.KIKKA_WORKER_TOKEN) throw new Error('Explicit disposable worker state and service token required.');
const worker = new KikkaWorker({ directory, policy: { provider: 'burrow-routing' }, routingEnabled: true,
  approvedUrls: ['https://example.com/'], resolveCredential: credentialResolver(process.env.KIKKA_ROUTING_ACCESS_URL, process.env.KIKKA_WORKER_TOKEN),
  inferenceTransport: async (url, init) => {
    const payload = JSON.parse(init.body);
    // Known dummy fixture credentials only. A real key must never enter this fixture.
    if (!['Bearer routing-fixture-funded', 'Bearer routing-fixture-personal'].includes(init.headers.Authorization)) {
      throw new Error('Only fixture credentials may be used in this test entry point.');
    }
    const tool = payload.messages.findLast(m => m.role === 'tool');
    const annual = payload.messages.some(m => m.role === 'user' && JSON.stringify(m).includes('annual'));
    let text;
    if (tool) {
      const evidence = JSON.parse(tool.content);
      text = `INFERENCE FIXTURE — not live model research.\n${annual ? 'Revision: annual billing unavailable in this source; no annual price inferred.' : 'Initial result: public-page evidence captured.'}\nSource: ${evidence.url}\nCaptured: ${evidence.capturedAt}\nTitle: ${evidence.title}\nEvidence: ${evidence.evidenceId}\nNo subscription prices or eligibility are claimed.`;
    }
    const delta = text ? { content: text } : { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-read', type: 'function',
      function: { name: 'read_public_page', arguments: '{"url":"https://example.com/"}' } }] };
    const chunk = { id: 'routing-fixture', model: payload.model,
      choices: [{ index: 0, delta, finish_reason: text ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 73, completion_tokens: 11, total_tokens: 84 } };
    await appendFile(join(directory, 'fixture-trace.jsonl'), `${JSON.stringify({ capturedAt: new Date().toISOString(),
      kind: 'INFERENCE FIXTURE, NOT LIVE MODEL', endpoint: url, request: payload, response: chunk })}\n`, { mode: 0o600 });
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
await worker.recover();
const server = workerServer(worker, process.env.KIKKA_WORKER_TOKEN);
server.listen(Number(process.env.KIKKA_WORKER_PORT ?? 3104), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  server.close(); await worker.close(); process.exit(0);
});
