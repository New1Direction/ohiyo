import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const freePolicy = Object.freeze({ provider: 'opencode-free', modelId: 'glm-5.3-flash-free',
  inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxOutputTokens: 4096 });
export const inferenceEndpoint = 'https://opencode.ai/inference/openai/v1/chat/completions';

// Pi's OpenAI adapter requires a nonempty key. This sentinel never leaves the
// process: rebuild the actual HTTP request with ONLY public protocol headers.
export function freeModels() {
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(createProvider({
    id: freePolicy.provider, name: 'OpenCode free development research',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    auth: { apiKey: { name: 'Unauthenticated', resolve: async () => ({ auth: { apiKey: 'not-a-credential' } }) } },
    models: [{ id: freePolicy.modelId, name: 'GLM 5.3 Flash Free', api: 'openai-completions',
      provider: freePolicy.provider, baseUrl: 'https://opencode.ai/inference/openai/v1',
      reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false,
        supportsReasoningEffort: false, supportsStrictMode: false } }],
    api: openAICompletionsApi(),
  }));
  return models;
}

export function unauthenticatedTransport(transport = fetch) {
  let dispatched = false;
  return async (input, init) => {
    const request = new Request(input, init);
    if (dispatched) throw new Error('Automatic model retransmission is forbidden.');
    if (request.url !== inferenceEndpoint || request.method !== 'POST') throw new Error('Unapproved inference route.');
    const body = await request.text();
    const payload = JSON.parse(body);
    if (payload.model !== freePolicy.modelId || payload.stream !== true || !Number.isInteger(payload.max_tokens)
      || payload.max_tokens < 1 || payload.max_tokens > freePolicy.maxOutputTokens) throw new Error('Unapproved inference payload.');
    dispatched = true;
    return transport(inferenceEndpoint, { method: 'POST', body, signal: request.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      redirect: 'error', credentials: 'omit' });
  };
}
