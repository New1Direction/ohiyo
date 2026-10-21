import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { KikkaWorker } from './runtime.mjs';
import { credentialResolver } from './routing.mjs';
import { SubscriptionAccounts } from './subscription-oauth.mjs';
import { ComputerProvider } from './computer-provider.mjs';
import { ImOrbComputerBackend } from './imorb-computer.mjs';
import { Crawl4aiEngine } from './crawl4ai-engine.mjs';

export function workerServer(worker, token, { subscriptionAccounts } = {}) {
  if (!token || token.length < 32) throw new Error('A private worker token of at least 32 characters is required.');
  const subscriptions = subscriptionAccounts ?? new SubscriptionAccounts({ directory: resolve(worker.directory, 'subscription-accounts'), key: token });
  worker.subscriptionAccounts = subscriptions;
  const server = createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401); res.end(); return; }
    try {
      if (req.method !== 'POST' || req.url !== '/command') throw new Error('Unknown operation.');
      let bytes = 0; const chunks = [];
      // Admission includes bounded request, current context, routine and pinned routes.
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 64000) throw new Error('Request too large.'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let output;
      switch (body.operation) {
        case 'subscription': {
          const provider = body.provider ?? 'claude';
          if (!['claude', 'chatgpt'].includes(provider)) throw new Error('Unknown connection.');
          output = await subscriptions.call(body.owner, provider, body.action, body); break;
        }
        case 'start': output = await worker.start(body.admission); break;
        case 'computer': output = await worker.computer(body); break;
        case 'status': output = await worker.status(body.run); break;
        case 'watch': output = await worker.events(body.run); break;
        case 'control': await worker.control(body.run, body.command); output = { acknowledged: true }; break;
        case 'evidence': {
          const image = await worker.evidence(body.run, body.evidence);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(image); return;
        }
        default: throw new Error('Unknown operation.');
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(output));
    } catch {
      // Do not leak filesystem paths, URLs containing tokens or provider errors.
      res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Worker could not acknowledge this operation. Reconcile saved status before retrying.' }));
    }
  });
  server.on('close', () => { void subscriptions.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const config = JSON.parse(await readFile(process.env.KIKKA_WORKER_CONFIG, 'utf8'));
  const routingEnabled = process.env.KIKKA_MODEL_ROUTING === '1';
  if (!Array.isArray(config.approvedUrls) || config.approvedUrls.length < 1 || config.approvedUrls.length > 20) throw new Error('Invalid public page allowlist.');
  if (!routingEnabled && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing. No live model work was started.');
  if (!routingEnabled && (config.policy?.provider !== 'openai' || config.policy?.modelId !== 'gpt-4o-mini'
    || !Number.isFinite(config.policy.inputUsdPerMillion) || config.policy.inputUsdPerMillion < 0.15
    || !Number.isFinite(config.policy.outputUsdPerMillion) || config.policy.outputUsdPerMillion < 0.6
    || config.policy.maxOutputTokens !== 4096)) throw new Error('Invalid bounded worker policy.');
  const worker = new KikkaWorker({ ...config, directory: resolve(process.env.KIKKA_WORKER_DIRECTORY),
    computerFactory: config.computer ? () => {
      const backend = new ImOrbComputerBackend({ binary: config.computer.binary,
        home: config.computer.home, repo: config.computer.repo, size: config.computer.size });
      if (config.computer.browser?.enabled === true) backend.engines.push(new Crawl4aiEngine({ transport: backend }));
      return new ComputerProvider({ directory: resolve(process.env.KIKKA_WORKER_DIRECTORY, 'computers'), grants: config.computer.grants,
        resolveGrants: () => JSON.parse(readFileSync(process.env.KIKKA_WORKER_CONFIG, 'utf8')).computer?.grants ?? [],
        idleMs: config.computer.idleMs, backend });
    } : undefined,
    policy: routingEnabled ? { provider: 'burrow-routing' } : config.policy, routingEnabled,
    resolveCredential: routingEnabled ? credentialResolver(process.env.KIKKA_ROUTING_ACCESS_URL, process.env.KIKKA_WORKER_TOKEN) : undefined });
  const server = workerServer(worker, process.env.KIKKA_WORKER_TOKEN);
  await worker.recover();
  server.listen(Number(process.env.KIKKA_WORKER_PORT ?? 3102), '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
    server.close(); await worker.close(); process.exit(0);
  });
}
