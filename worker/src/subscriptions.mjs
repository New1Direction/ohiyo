// Subscription sign-in stays inside each unmodified official client.
// This broker never reads, exports or treats its credential files as API keys.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const issue = () => new Error('Sign-in could not be confirmed. Refresh the connection before trying again.');
export class NativeConnections {
  constructor({ directory, binary, provider = 'claude', lifetime = 600_000 }) {
    if (!['claude', 'chatgpt'].includes(provider)) throw issue();
    if (binary && (!directory || !isAbsolute(binary))) throw new Error('An absolute official client path is required.');
    this.provider = provider; this.execution = provider === 'claude' ? 'claude-code' : 'codex';
    this.directory = directory; this.binary = binary; this.lifetime = lifetime;
    this.pending = new Map(); this.locks = new Map();
  }
  async call(owner, action, { attempt, code } = {}) {
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(owner)
      || !['status', 'connect', 'complete', 'disconnect'].includes(action)) throw issue();
    // Serialize mutations per owner, not across accounts. Polling never starts a login.
    const previous = this.locks.get(owner) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.perform(owner, action, { attempt, code }));
    this.locks.set(owner, next);
    try { return await next; } finally { if (this.locks.get(owner) === next) this.locks.delete(owner); }
  }
  profile(owner) { return join(this.directory, createHash('sha256').update(owner).digest('hex')); }
  env(owner) {
    const profile = this.profile(owner);
    // No inherited provider keys, OAuth tokens, SDK configuration or user projects.
    return { PATH: process.env.PATH, HOME: profile, TERM: 'dumb',
      ...(this.provider === 'claude' ? { CLAUDE_CONFIG_DIR: profile } : { CODEX_HOME: profile }),
      ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}) };
  }
  async launch(owner, args) {
    await mkdir(this.profile(owner), { recursive: true, mode: 0o700 });
    if (this.provider === 'chatgpt') args = ['-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"', ...args];
    const child = spawn(this.binary, args, { cwd: this.profile(owner), env: this.env(owner), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); // A closed login prompt must not crash the worker.
    return child;
  }
  async stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  async command(owner, args) {
    const child = await this.launch(owner, args);
    return new Promise((resolve, reject) => {
      let text = '', size = 0;
      const timer = setTimeout(() => { void this.stop(child); reject(issue()); }, 10_000);
      const stop = () => { clearTimeout(timer); reject(issue()); };
      child.on('error', stop);
      const receive = chunk => {
        size += chunk.length;
        if (size > 16_384) { void this.stop(child); stop(); } else text += chunk;
      };
      child.stdout.on('data', receive);
      if (this.provider === 'chatgpt') child.stderr.on('data', receive);
      else child.stderr.resume(); // Never log provider output or token echoes.
      child.stdin.end();
      child.on('close', exit => { clearTimeout(timer); resolve({ exit, text }); });
    });
  }
  async account(owner) {
    const { text } = await this.command(owner, this.provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']);
    let account;
    if (this.provider === 'chatgpt') {
      const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
      if (/^Logged in using ChatGPT\s*$/m.test(clean)) account = { loggedIn: true };
      else if (/^Not logged in\s*$/m.test(clean)) account = { loggedIn: false };
      else throw issue(); // API-key or unknown auth modes are not subscriptions.
    } else { try { account = JSON.parse(text); } catch { throw issue(); } }
    if (typeof account.loggedIn !== 'boolean') throw issue();
    // Allowlisted metadata only. Never relay the raw CLI response.
    return { state: account.loggedIn ? 'connected' : 'disconnected',
      email: typeof account.email === 'string' ? account.email.slice(0, 254) : null,
      plan: typeof account.subscriptionType === 'string' ? account.subscriptionType.slice(0, 80) : null,
      execution: this.execution, usableForResearch: false };
  }
  view(job) {
    return { state: job.state, attempt: job.id, authorizationUrl: job.url ?? null,
      expiresAt: job.expiresAt, userCode: job.userCode ?? null, execution: this.execution, usableForResearch: false };
  }
  async perform(owner, action, { attempt, code }) {
    if (!this.binary) {
      if (action !== 'status') throw issue();
      return { state: 'unavailable', execution: this.execution, usableForResearch: false };
    }
    let job = this.pending.get(owner);
    if (job && job.expiresAt <= Date.now() && !['failed', 'expired', 'complete'].includes(job.state)) {
      job.state = 'expired'; await this.stop(job.child);
    }
    if (action === 'disconnect') {
      if (job) { clearTimeout(job.timer); await this.stop(job.child); this.pending.delete(owner); }
      await this.command(owner, this.provider === 'claude' ? ['auth', 'logout'] : ['logout']);
      const account = await this.account(owner);
      if (account.state !== 'disconnected') throw issue();
      return account;
    }
    if (action === 'complete') {
      if (this.provider !== 'claude') throw issue(); // Enter Codex's code on OpenAI's page, never here.
      if (!job || job.id !== attempt || !['awaiting_sign_in', 'verifying'].includes(job.state)) throw issue();
      if (job.state === 'verifying') return this.view(job); // Never send a possibly consumed code twice.
      if (typeof code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(code)) throw issue();
      job.state = 'verifying';
      job.child.stdin.write(`${code}\n`);
      return this.view(job);
    }
    if (job) {
      if (['awaiting_sign_in', 'verifying'].includes(job.state)) return this.view(job);
      if (action === 'status' && ['failed', 'expired'].includes(job.state)) return this.view(job);
      await this.stop(job.child);
      this.pending.delete(owner);
    }
    const account = await this.account(owner);
    if (action === 'status' || account.state === 'connected') return account;
    if ([...this.pending.values()].filter(j => ['awaiting_sign_in', 'verifying'].includes(j.state)).length >= 8) throw issue();
    const child = await this.launch(owner, this.provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth']);
    job = { id: randomUUID(), child, state: 'awaiting_sign_in', expiresAt: Date.now() + this.lifetime };
    this.pending.set(owner, job);
    return new Promise((resolve, reject) => {
      let output = '', settled = false;
      const startup = setTimeout(() => { job.state = 'failed'; void this.stop(child); reject(issue()); }, 20_000);
      job.timer = setTimeout(() => { job.state = 'expired'; void this.stop(child); }, this.lifetime);
      job.timer.unref();
      const receive = chunk => {
        output += chunk;
        if (output.length > 16_384) { job.state = 'failed'; void this.stop(child); return; }
        if (this.provider === 'chatgpt') {
          const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
          const code = clean.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}(?=[\s\u001b])/);
          if (/https:\/\/auth\.openai\.com\/codex\/device(?=[\s\u001b])/.test(clean) && code) {
            job.url = 'https://auth.openai.com/codex/device'; job.userCode = code[0];
            if (!settled) { settled = true; clearTimeout(startup); resolve(this.view(job)); }
          }
          return;
        }
        for (const match of output.matchAll(/https:\/\/[^\s\u001b]+(?=[\s\u001b])/g)) {
          let url;
          try { url = new URL(match[0]); } catch { continue; }
          if (!['claude.com', 'claude.ai'].includes(url.hostname) || url.username || url.password
            || url.port || !['/cai/oauth/authorize', '/oauth/authorize'].includes(url.pathname)
            || !['state', 'client_id', 'code_challenge'].every(key => url.searchParams.get(key))
            || url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('response_type') !== 'code') continue;
          job.url = url.href;
          if (!settled) { settled = true; clearTimeout(startup); resolve(this.view(job)); }
        }
      };
      child.stdout.on('data', receive); child.stderr.on('data', receive);
      child.on('error', () => { job.state = 'failed'; clearTimeout(startup); clearTimeout(job.timer); reject(issue()); });
      child.on('close', exit => {
        clearTimeout(startup); clearTimeout(job.timer);
        if (job.state !== 'expired') job.state = exit === 0 ? 'complete' : 'failed';
        output = ''; job.url = null; job.userCode = null;
        if (!settled) reject(issue());
      });
    });
  }
  async close() {
    const jobs = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(jobs.map(job => { clearTimeout(job.timer); return this.stop(job.child); }));
  }
}
