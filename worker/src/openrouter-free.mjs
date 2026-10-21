import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const openRouterPolicy = Object.freeze({ provider: 'openrouter-free',
  modelId: 'xingchen-agi/xing4.0-29b-a4b:free', inputUsdPerMillion: 0,
  outputUsdPerMillion: 0, maxOutputTokens: 4096 });
export const openRouterEndpoint = 'https://openrouter.ai/api/v1/chat/completions';
export const selectedEndpoint = 'Phala | xingchen-agi/xing4.0-29b-a4b-20261015:free';
export const providerRestrictions = Object.freeze({ only: Object.freeze(['phala']), order: Object.freeze(['phala']), allow_fallbacks: false,
  require_parameters: true, data_collection: 'deny', zdr: true,
  max_price: Object.freeze({ prompt: 0, completion: 0, request: 0, image: 0 }) });
const modelEndpoint = `https://openrouter.ai/api/v1/models/${openRouterPolicy.modelId}/endpoints`;
const noAmbientAuth = { env: async () => undefined, fileExists: async () => false };

export function openRouterModels() {
  const models = createModels({ authContext: noAmbientAuth });
  models.setProvider(createProvider({ id: openRouterPolicy.provider,
    name: 'OpenRouter free development research', baseUrl: 'https://openrouter.ai/api/v1',
    // Real authentication belongs exclusively to the host-pinned transport.
    auth: { apiKey: { name: 'Dedicated test credential', resolve: async () => ({ auth: { apiKey: 'managed-by-burrow-transport' } }) } },
    models: [{ id: openRouterPolicy.modelId, name: 'Xing4.0 29B A4B (free, Phala only)',
      provider: openRouterPolicy.provider, baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions',
      reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false,
        supportsReasoningEffort: false, supportsStrictMode: false, supportsUsageInStreaming: true } }],
    api: openAICompletionsApi(),
  }));
  return models;
}

// Public metadata only, no key, inference, fallback or billing operation.
export async function verifyOpenRouterSelection(transport = fetch) {
  const get = async url => {
    const response = await transport(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`OpenRouter eligibility metadata unavailable: HTTP ${response.status}.`);
    return response.json();
  };
  const [catalog, listing, zdr, providers] = await Promise.all([
    get(`https://openrouter.ai/api/v1/model/${openRouterPolicy.modelId}`), get(modelEndpoint),
    get('https://openrouter.ai/api/v1/endpoints/zdr'), get('https://openrouter.ai/api/frontend/v1/all-providers'),
  ]);
  const model = catalog.data;
  const endpoints = listing.data?.endpoints?.filter(e => e.provider_name === 'Phala');
  const endpoint = endpoints?.[0];
  const policy = providers.data?.find(p => p.slug === 'phala')?.dataPolicy;
  const zero = pricing => pricing && pricing.prompt === '0' && pricing.completion === '0'
    && Object.values(pricing).every(value => value !== null && Number.isFinite(Number(value)) && Number(value) === 0);
  const tools = value => ['tools', 'tool_choice', 'max_tokens'].every(p => value?.supported_parameters?.includes(p));
  if (model?.id !== openRouterPolicy.modelId || !zero(model.pricing) || !tools(model)
    || listing.data?.id !== model.id || endpoints?.length !== 1 || endpoint.name !== selectedEndpoint
    || endpoint.model_id !== model.id || endpoint.tag !== 'phala' || endpoint.status !== 0
    || !zero(endpoint.pricing) || !tools(endpoint) || !endpoint.supports_tool_choice?.auto
    || endpoint.max_completion_tokens < openRouterPolicy.maxOutputTokens
    || endpoint.supports_implicit_caching !== false
    || !zdr.data?.some(e => e.name === selectedEndpoint && e.model_id === model.id && e.tag === 'phala')
    || !policy || ['training', 'trainingOpenRouter', 'retainsPrompts', 'safetyRetention', 'canPublish', 'requiresUserIDs']
      .some(field => policy[field] !== false)) {
    throw new Error('The pinned OpenRouter free/tool/ZDR route is not eligible. No inference is authorized.');
  }
  return { capturedAt: new Date().toISOString(), model, endpoint, dataPolicy: policy,
    source: modelEndpoint, restrictions: providerRestrictions,
    policySources: ['https://openrouter.ai/docs/guides/features/zdr', 'https://redpill.ai/privacy'],
    caveats: 'ZDR covers prompts and outputs, not connection/account metadata. RedPill permits six-month IP/header logs. No TEE attestation is verified by Burrow.' };
}

export function openRouterPayload(payload) {
  // Construct, rather than merge, the request. Presets, routers, plugins,
  // hosted tools, model fallbacks, user IDs and caller overrides cannot enter.
  return { model: openRouterPolicy.modelId, messages: payload.messages,
    ...(payload.tools ? { tools: payload.tools, tool_choice: 'auto' } : {}),
    max_tokens: 4096, stream: true, stream_options: { include_usage: true },
    provider: providerRestrictions, plugins: [], transforms: [], reasoning: { enabled: false } };
}

export function openRouterTransport(key, transport = fetch) {
  if (typeof key !== 'string' || key.length < 20 || /\s/.test(key)) throw new Error('A dedicated server-side OpenRouter test key is required.');
  let dispatched = false;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== openRouterEndpoint || request.method !== 'POST') throw new Error('Unapproved OpenRouter inference route.');
    if (dispatched) throw new Error('Automatic model retransmission is forbidden.');
    const payload = JSON.parse(await request.text());
    if (JSON.stringify(payload) !== JSON.stringify(openRouterPayload(payload))
      || !Array.isArray(payload.messages) || payload.tools?.some(tool => tool.type !== 'function'
        || tool.function?.name !== 'read_public_page')) throw new Error('Unapproved OpenRouter inference payload.');
    dispatched = true;
    const response = await transport(openRouterEndpoint, { method: 'POST', body: JSON.stringify(payload), signal: request.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
        'X-OpenRouter-Cache': 'false' },
      redirect: 'error', credentials: 'omit' });
    if (response.status >= 300 && response.status < 400) throw new Error('OpenRouter inference redirects are forbidden.');
    return response;
  };
}
