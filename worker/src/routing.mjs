import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import dns from 'node:dns/promises';
import https from 'node:https';
import { Readable, Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import { isPublicAddress, validateApprovedUrl } from './browser.mjs';
import { openRouterEndpoint, openRouterPolicy, openRouterPayload } from './openrouter-free.mjs';
import { subscriptionProvider, subscriptionProviders } from './subscription-oauth.mjs';

export const roles = ['general', 'research', 'review', 'summary'];
export function validateRouting(routing) {
  if (!routing || Object.keys(routing).length !== roles.length) throw new Error('All role routes must be pinned.');
  for (const role of roles) {
    const route = routing[role];
    if (!route) throw new Error('Missing role route.');
    const url = validateApprovedUrl(route.endpoint, [route.endpoint]);
    const subscription = subscriptionProvider(route);
    if (subscription) {
      const known = subscriptionProviders[subscription].getModels().find(m => m.id === route.providerModelId);
      if (!known || route.canonicalModel !== `subscription/${subscription}/${known.id}` || route.fundedBy !== 'you'
        || route.inputUsdPerMillion !== 0 || route.outputUsdPerMillion !== 0
        || route.contextWindow !== known.contextWindow || route.maxOutputTokens !== Math.min(known.maxTokens, 4096)) throw new Error('Invalid subscription route.');
    }
    if (url.search || (!subscription && !url.pathname.endsWith('/chat/completions')) || url.hostname === 'opencode.ai'
      || !['ohiyo', 'you'].includes(route.fundedBy)
      || ['canonicalModel', 'providerModelId', 'connectionId', 'connectionRevision'].some(k =>
        typeof route[k] !== 'string' || !route[k].trim() || route[k].length > 250)
      || !Number.isSafeInteger(route.contextWindow) || route.contextWindow < 1 || route.contextWindow > 2_000_000
      || !Number.isSafeInteger(route.maxOutputTokens) || route.maxOutputTokens < 1 || route.maxOutputTokens > 65536
      || ['inputUsdPerMillion', 'outputUsdPerMillion'].some(k => !Number.isFinite(route[k]) || route[k] < 0)
      || Object.keys(route).some(k => !['canonicalModel', 'providerModelId', 'connectionId', 'connectionRevision',
        'fundedBy', 'endpoint', 'contextWindow', 'maxOutputTokens', 'inputUsdPerMillion', 'outputUsdPerMillion'].includes(k))) {
      throw new Error('Invalid pinned route; no provider fallback is authorized.');
    }
    if (url.hostname === 'openrouter.ai' && (route.endpoint !== openRouterEndpoint
      || route.providerModelId !== openRouterPolicy.modelId || route.inputUsdPerMillion !== 0
      || route.outputUsdPerMillion !== 0 || route.maxOutputTokens !== openRouterPolicy.maxOutputTokens)) {
      throw new Error('Only the previously selected OpenRouter acceptance route is authorized.');
    }
  }
}

export function routeModel(role, route) {
  const subscription = subscriptionProvider(route);
  if (subscription) {
    const native = subscriptionProviders[subscription].getModels().find(m => m.id === route.providerModelId);
    return { ...native, id: route.canonicalModel, provider: `burrow-${role}`, maxTokens: route.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
  return { id: route.canonicalModel, name: route.canonicalModel, provider: `burrow-${role}`,
    api: 'openai-completions', baseUrl: route.endpoint.slice(0, -'/chat/completions'.length),
    reasoning: false, input: ['text'], contextWindow: route.contextWindow, maxTokens: route.maxOutputTokens,
    cost: { input: route.inputUsdPerMillion, output: route.outputUsdPerMillion,
      cacheRead: route.inputUsdPerMillion, cacheWrite: route.inputUsdPerMillion },
    compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false,
      supportsReasoningEffort: false, supportsStrictMode: false, supportsUsageInStreaming: true } };
}

export function routedModels(routing) {
  validateRouting(routing);
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  for (const role of roles) {
    const model = routeModel(role, routing[role]);
    const subscription = subscriptionProvider(routing[role]);
    if (subscription) {
      const native = subscriptionProviders[subscription];
      const upstream = { ...model, id: routing[role].providerModelId };
      models.setProvider({ ...native, id: model.provider,
        auth: { apiKey: { name: 'Private Burrow subscription', resolve: async () => ({ auth: { apiKey: 'managed-by-burrow' } }) } }, getModels: () => [model],
        stream: (_m, context, options) => native.stream(upstream, context, options),
        streamSimple: (_m, context, options) => native.streamSimple(upstream, context, options) });
      continue;
    }
    models.setProvider(createProvider({ id: model.provider, name: `Burrow ${role}`, baseUrl: model.baseUrl,
      auth: { apiKey: { name: 'Private Burrow credential', resolve: async () => ({ auth: { apiKey: 'managed-by-burrow' } }) } },
      models: [model], api: openAICompletionsApi() }));
  }
  return models;
}

export function routedPayload(route, payload) {
  if (route.endpoint === openRouterEndpoint) return openRouterPayload(payload);
  return { model: route.providerModelId, messages: payload.messages,
    ...(payload.tools ? { tools: payload.tools, tool_choice: 'auto' } : {}),
    max_tokens: route.maxOutputTokens, stream: true, stream_options: { include_usage: true } };
}

// Pin the actual TLS socket to a public DNS result, not merely a preflight check.
// This is a transport, not another agent or an endpoint discovery mechanism.
export async function publicInference(url, init) {
  const parsed = validateApprovedUrl(url, [url]);
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  signal.throwIfAborted();
  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Non-public inference host.');
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.request(parsed, { method: 'POST', headers: init.headers, agent: false, signal,
      family: pinned.family, lookup: (_host, options, cb) => options.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family) }, res => {
      // Never follow even a same-host redirect. No credential can leave its pinned endpoint.
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume(); reject(new Error('Inference redirects are forbidden.')); return;
      }
      let size = 0;
      const bounded = new Transform({ transform(chunk, _encoding, cb) {
        size += chunk.length; cb(size > 8_388_608 ? new Error('Inference response too large.') : null, chunk);
      } });
      res.on('error', error => bounded.destroy(error));
      bounded.on('error', () => res.destroy());
      resolve(new Response(Readable.toWeb(res.pipe(bounded)), { status: res.statusCode,
        headers: { 'Content-Type': res.headers['content-type'] ?? 'application/octet-stream' } }));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

export function routedTransport(route, key, transport = publicInference) {
  if (typeof key !== 'string' || !key || key.length > 16384 || /\s/.test(key)) throw new Error('A private route credential is required.');
  let dispatched = false;
  return async (input, init) => {
    const request = new Request(input, init);
    if (dispatched || request.url !== route.endpoint || request.method !== 'POST') throw new Error('Unapproved inference dispatch.');
    const payload = JSON.parse(await request.text());
    if (JSON.stringify(payload) !== JSON.stringify(routedPayload(route, payload)) || !Array.isArray(payload.messages)
      || payload.tools?.some(t => t.type !== 'function' || t.function?.name !== 'read_public_page')) {
      throw new Error('Unapproved inference parameters.');
    }
    dispatched = true;
    const response = await transport(route.endpoint, { method: 'POST', body: JSON.stringify(payload), signal: request.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
        ...(route.endpoint === openRouterEndpoint ? { 'X-OpenRouter-Cache': 'false' } : {}) }, redirect: 'error', credentials: 'omit' });
    if (response.status >= 300 && response.status < 400) throw new Error('Inference redirects are forbidden.');
    return response;
  };
}

// Native provider adapters keep their own wire format. Still permit only one
// dispatch, to the pinned provider; no redirects, ambient auth or SDK retries.
export function subscriptionTransport(route, transport = publicInference) {
  if (!subscriptionProvider(route)) throw new Error('Invalid subscription route.');
  let dispatched = false;
  return async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    url.searchParams.delete('beta');
    if (dispatched || url.href !== route.endpoint || request.method !== 'POST') throw new Error('Unapproved subscription dispatch.');
    const body = Buffer.from(await request.arrayBuffer());
    const encoding = request.headers.get('content-encoding');
    if (body.length > 1_000_000 || encoding && encoding !== 'zstd') throw new Error('Invalid subscription request.');
    const decoded = encoding === 'zstd' ? zlib.zstdDecompressSync(body, { maxOutputLength: 1_000_000 }) : body;
    const payload = JSON.parse(decoded.toString());
    if (payload.model !== route.providerModelId) throw new Error('Invalid subscription request.');
    // The pinned HTTPS transport streams SSE directly without decompression.
    request.headers.set('accept-encoding', 'identity');
    dispatched = true;
    const response = await transport(request.url, { method: 'POST', body, headers: Object.fromEntries(request.headers), signal: request.signal,
      redirect: 'error', credentials: 'omit' });
    if (response.status >= 300 && response.status < 400) throw new Error('Inference redirects are forbidden.');
    return response;
  };
}

export function credentialResolver(endpoint, token) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/api/v1/burrow/internal/model-access' || !token || token.length < 32) throw new Error('A private loopback model-access endpoint is required.');
  return async body => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('The pinned connection is no longer authorized.');
    const result = await response.json();
    if (typeof result.key !== 'string') throw new Error('No model credential was authorized.');
    return result.key;
  };
}
