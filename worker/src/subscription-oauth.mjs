// Burrow owns account isolation and storage; Pi owns provider OAuth and inference.
import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

export const subscriptionProviders = { claude: anthropicProvider(), chatgpt: openaiCodexProvider() };
export const subscriptionEndpoint = provider => provider === 'claude'
  ? 'https://api.anthropic.com/v1/messages' : 'https://chatgpt.com/backend-api/codex/responses';
export function subscriptionProvider(route) {
  return ['claude', 'chatgpt'].find(p => route?.connectionId === `subscription-${p}` && route.endpoint === subscriptionEndpoint(p));
}
const problem = () => new Error('Reconnect this account before starting new work.');

export class SubscriptionAccounts {
  constructor({ directory, key, providers = subscriptionProviders, lifetime = 600_000 }) {
    if (!directory || typeof key !== 'string' || key.length < 32) throw problem();
    this.directory = directory; this.key = createHash('sha256').update(`burrow-subscriptions:${key}`).digest();
    this.providers = providers; this.lifetime = lifetime; this.pending = new Map(); this.locks = new Map();
  }
  async open() {
    this.opening ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const path = join(this.directory, 'accounts.sqlite');
      this.db = new DatabaseSync(path);
      await chmod(path, 0o600);
      this.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS accounts(owner TEXT,provider TEXT,revision TEXT,credential BLOB,PRIMARY KEY(owner,provider))');
    })();
    await this.opening;
  }
  serial(owner, fn) {
    const next = (this.locks.get(owner) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(owner, next);
    return next.finally(() => { if (this.locks.get(owner) === next) this.locks.delete(owner); });
  }
  identity(owner, provider) {
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(owner)
      || !['claude', 'chatgpt'].includes(provider) || !Object.hasOwn(this.providers, provider)) throw problem();
    return createHash('sha256').update(owner).digest('hex');
  }
  read(owner, provider) {
    const id = this.identity(owner, provider);
    const row = this.db.prepare('SELECT * FROM accounts WHERE owner=? AND provider=?').get(id, provider);
    if (!row) return null;
    const blob = Buffer.from(row.credential);
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${id}:${provider}:${row.revision}`)); decipher.setAuthTag(blob.subarray(12, 28));
    return { revision: row.revision, credential: JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString()) };
  }
  save(owner, provider, credential, revision = randomUUID()) {
    if (credential?.type !== 'oauth' || !credential.access || !credential.refresh || !Number.isFinite(credential.expires)) throw problem();
    const id = this.identity(owner, provider), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${id}:${provider}:${revision}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
    this.db.prepare('INSERT OR REPLACE INTO accounts VALUES(?,?,?,?)').run(id, provider, revision, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
  }
  catalog(provider) {
    return this.providers[provider].getModels().filter(m => m.input.includes('text')).map(m => ({
      id: `subscription/${provider}/${m.id}`, providerModelId: m.id, name: m.name,
      contextWindow: m.contextWindow, maxOutputTokens: Math.min(m.maxTokens, 4096),
      inputUsdPerMillion: 0, outputUsdPerMillion: 0,
    }));
  }
  view(owner, provider) {
    const saved = this.read(owner, provider), job = this.pending.get(`${owner}:${provider}`);
    return { state: saved ? 'connected' : job?.state ?? 'disconnected', usableForResearch: !!saved,
      models: this.catalog(provider), ...(saved ? { revision: saved.revision } : job ? {
        attempt: job.id, authorizationUrl: job.url ?? null, userCode: job.userCode ?? null, expiresAt: job.expiresAt,
      } : {}) };
  }
  async call(owner, provider, action, { attempt, code, model } = {}) {
    this.identity(owner, provider); await this.open();
    return this.serial(owner, async () => {
      const id = `${owner}:${provider}`, job = this.pending.get(id);
      if (action === 'status') return this.view(owner, provider);
      if (action === 'route') {
        const saved = this.read(owner, provider), entry = this.catalog(provider).find(m => m.id === model);
        if (!saved || !entry) throw problem();
        return { canonicalModel: entry.id, providerModelId: entry.providerModelId, connectionId: `subscription-${provider}`,
          connectionRevision: saved.revision, endpoint: subscriptionEndpoint(provider), fundedBy: 'you',
          contextWindow: entry.contextWindow, maxOutputTokens: entry.maxOutputTokens, inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
      }
      if (action === 'disconnect') {
        job?.abort.abort(); if (job) clearTimeout(job.timer); this.pending.delete(id);
        this.db.prepare('DELETE FROM accounts WHERE owner=? AND provider=?').run(this.identity(owner, provider), provider);
        return this.view(owner, provider);
      }
      if (action === 'complete') {
        if (provider !== 'claude' || !job || job.id !== attempt || !['awaiting_sign_in', 'verifying'].includes(job.state)) throw problem();
        if (job.state === 'verifying') return this.view(owner, provider);
        if (typeof code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(code) || !job.resolveCode) throw problem();
        job.state = 'verifying'; job.resolveCode(code); job.resolveCode = null;
        return this.view(owner, provider);
      }
      if (action !== 'connect') throw problem();
      if (this.read(owner, provider) || job && ['awaiting_sign_in', 'verifying'].includes(job.state)) return this.view(owner, provider);
      if ([...this.pending.values()].filter(j => ['awaiting_sign_in', 'verifying'].includes(j.state)).length >= 8) throw problem();
      const abort = new AbortController();
      const next = { id: randomUUID(), state: 'awaiting_sign_in', abort, expiresAt: Date.now() + this.lifetime };
      this.pending.set(id, next);
      next.timer = setTimeout(() => { next.state = 'expired'; next.url = null; next.userCode = null; abort.abort(); }, this.lifetime);
      next.timer.unref();
      let ready;
      const published = new Promise(resolve => { ready = resolve; });
      const interaction = { signal: abort.signal,
        prompt: prompt => {
          if (prompt.type === 'select') return Promise.resolve(provider === 'claude' ? 'copy_code' : 'device_code');
          return new Promise((resolve, reject) => {
            next.resolveCode = resolve; ready();
            abort.signal.addEventListener('abort', () => reject(problem()), { once: true });
          });
        },
        notify: event => {
          if (event.type === 'auth_url') {
            const url = new URL(event.url);
            if (url.protocol !== 'https:' || url.username || url.password || url.port
              || !['claude.ai', 'claude.com', 'platform.claude.com'].includes(url.hostname)) throw problem();
            next.url = url.href;
          }
          if (event.type === 'device_code') {
            if (event.verificationUri !== 'https://auth.openai.com/codex/device') throw problem();
            next.url = event.verificationUri; next.userCode = event.userCode; ready();
          }
        } };
      next.completion = this.providers[provider].auth.oauth.login(interaction, { agentName: 'Burrow' }).then(credential =>
        this.serial(owner, async () => {
          if (this.pending.get(id) === next && !abort.signal.aborted) {
            this.save(owner, provider, credential); this.pending.delete(id);
          }
        })).catch(() => { if (next.state !== 'expired') next.state = 'failed'; })
        .finally(() => { clearTimeout(next.timer); next.url = null; next.userCode = null; ready(); });
      await Promise.race([published, new Promise(resolve => { const t = setTimeout(resolve, 20_000); t.unref(); published.then(() => clearTimeout(t)); })]);
      return this.view(owner, provider);
    });
  }
  async auth(owner, route, signal) {
    const provider = subscriptionProvider(route); this.identity(owner, provider); await this.open();
    return this.serial(owner, async () => {
      const saved = this.read(owner, provider);
      if (!saved || saved.revision !== route.connectionRevision || !this.catalog(provider).some(m => m.id === route.canonicalModel && m.providerModelId === route.providerModelId)) throw problem();
      let { credential } = saved;
      if (credential.expires <= Date.now() + 60_000) {
        signal?.throwIfAborted();
        // A provider can rotate the refresh token before Stop arrives. Persist
        // its replacement even when the caller cancels; never start inference.
        credential = await this.providers[provider].auth.oauth.refresh(credential, AbortSignal.timeout(30_000));
        this.save(owner, provider, credential, saved.revision);
      }
      signal?.throwIfAborted();
      return this.providers[provider].auth.oauth.toAuth(credential);
    });
  }
  async close() {
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.abort.abort(); }
    await Promise.all([...this.pending.values()].map(j => j.completion));
    await Promise.allSettled([...this.locks.values()]); this.pending.clear();
    this.db?.close(); this.db = null; this.opening = null;
  }
}
