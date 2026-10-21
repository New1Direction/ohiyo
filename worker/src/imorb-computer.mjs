import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { COMPUTER_CONTRACT_VERSION, COMPUTER_STATES, ComputerNotDispatched, validateComputerCapabilities } from './computer-contract.mjs';

const fileHelper = readFileSync(new URL('./imorb-files.mjs', import.meta.url), 'utf8');
const features = ['files.read', 'files.write', 'files.ensure_directory'];
const actionKey = i => JSON.stringify([i.account, i.workspace_id, i.task_id, i.root_goal_id, i.request_id]);

/** Direct ImOrb host resource API. Never calls `host agent`, submit, or a model.
 * Inspected ImOrb revision: 15762f1c0e8d29504ed18fff390be60b6b60ded2.
 * Optional engines implement the SAME backend status/execute/cancel/live_view
 * signatures from computer-contract.mjs, constructed with this transport by host code.
 */
export class ImOrbComputerBackend {
  constructor({ binary, home, repo, size = 'small', engines = [], command, dockerCommand = ['docker'], env = {} }) {
    if (!isAbsolute(binary ?? '') || !isAbsolute(home ?? '') || !isAbsolute(repo ?? '') || !['small', 'medium', 'large'].includes(size)) throw new Error('Absolute ImOrb binary, private home and committed repository are required.');
    this.command = command ?? [binary]; this.home = home; this.repo = realpathSync(repo); this.size = size; this.engines = engines; this.running = new Map();
    this.dockerCommand = dockerCommand;
    // No model credentials, ambient cloud tokens, agent settings or ORB_SECRET_*.
    this.env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/nonexistent', ORBD_HOME: home,
      ...(env.DOCKER_HOST ? { DOCKER_HOST: env.DOCKER_HOST } : {}) };
  }
  setNamespace(namespace) { this.namespace = namespace; }
  run(args, options) { return this.runCommand(this.command, ['host', ...args], options); }
  async runCommand(command, args, { input = '', signal, timeoutMs = 30000 } = {}) {
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    if (bounded.aborted) throw new ComputerNotDispatched();
    return new Promise((resolve, reject) => {
      const child = spawn(command[0], [...command.slice(1), ...args], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'], signal: bounded });
      let spawned = false;
      child.once('spawn', () => { spawned = true; });
      const chunks = []; let size = 0;
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 8_000_000) child.kill(); else chunks.push(chunk); });
      // Drain but never expose CLI stderr: it can contain provider secrets and paths.
      child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(input);
      child.on('error', error => reject(!spawned && !child.pid && ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)
        ? new ComputerNotDispatched() : new Error('ImOrb transport unavailable or interrupted.')));
      child.on('close', code => code === 0 && size <= 8_000_000 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('ImOrb did not acknowledge the operation.')));
    });
  }
  async containers() {
    if (!this.namespace) throw new Error('Computer namespace required.');
    const names = await this.runCommand(this.dockerCommand, ['ps', '-a', '--filter', 'label=orbd.host=1', '--filter', `name=orbd-${this.namespace}`, '--format', '{{.Names}}']);
    return names.trim().split('\n').filter(name => name.startsWith(`orbd-${this.namespace}`)
      && /^orbd-[a-z0-9-]{1,32}$/.test(name)).map(name => name.slice(5));
  }
  async registry() {
    const rows = JSON.parse(await this.run(['list', '--json']));
    if (!Array.isArray(rows) || rows.some(r => typeof r.name !== 'string' || typeof r.state !== 'string')) throw new Error('Invalid ImOrb registry.');
    return rows;
  }
  async inspect(a) {
    const row = (await this.registry()).find(r => r.name === a.computer_id);
    if (!row) return null;
    // The provider has a dedicated ORBD_HOME and deterministic owned names.
    // A different source under an owned name is not silently adopted or destroyed.
    if (row.repo !== this.repo) throw new Error('ImOrb resource provenance mismatch.');
    return row;
  }
  async list() {
    const registered = (await this.registry()).filter(r => this.namespace && r.name.startsWith(this.namespace) && r.repo === this.repo).map(r => r.name);
    // Upstream destroy can erase its registry even if docker rm failed. Include
    // namespace-owned container leftovers so startup/idle cleanup can find them.
    return [...new Set([...registered, ...await this.containers()])].map(computer_id => ({ computer_id, namespace: this.namespace }));
  }
  async open(a) {
    if (!this.namespace || !a.computer_id.startsWith(this.namespace)) throw new Error('Invalid ImOrb allocation namespace.');
    const previous = await this.inspect(a);
    if (!previous) {
      // ImOrb create is resumable by deterministic name. After an interrupted
      // create, inspect/reconcile its registry rather than invent another name.
      await this.run(['create', a.computer_id, '--repo', this.repo, '--size', this.size, '--no-snapshot'], { timeoutMs: 180000 });
    } else if (previous.state === 'Suspended') await this.run(['wake', a.computer_id], { timeoutMs: 150000 });
    else if (previous.state === 'Stopped') await this.run(['start', a.computer_id], { timeoutMs: 150000 });
    else if (previous.state !== 'Running') {
      return { state: 'unavailable', capabilities: this.baseCapabilities(), reason: 'ImOrb provisioning was interrupted. Inspect its saved provisioning step before continuing.' };
    }
    return this.status(a);
  }
  baseCapabilities() {
    return { contract_version: COMPUTER_CONTRACT_VERSION, features: [...features], persistence: { workspace: false, profile: false },
      limitations: ['Pinned ImOrb has no external workspace/profile reattachment API. Container restart retains files; replacement/release does not. Re-authentication is required.',
        'No browser, LCU or short-lived live-view engine is installed by this provider.'] };
  }
  async engineStatus(engine, allocation) {
    let timer;
    try {
      const result = await Promise.race([engine.status(allocation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Engine health check timed out.')), 5000);
      })]);
      if (!COMPUTER_STATES.includes(result?.state)) throw new Error('Unknown computer engine state.');
      validateComputerCapabilities(result.capabilities);
      return result;
    } finally { clearTimeout(timer); }
  }
  async status(a) {
    const row = await this.inspect(a);
    const capabilities = this.baseCapabilities();
    if (!row || row.state !== 'Running') return { state: 'unavailable', capabilities, reason: 'ImOrb is stopped, missing or unavailable; reconnect or explicitly replace it.' };
    // Probe real file support; a registry record alone does not prove exec works.
    await this.run(['exec', a.computer_id, 'bun', '--version']);
    for (const engine of this.engines) {
      try {
        const result = await this.engineStatus(engine, a);
        if (result.state !== 'ready') { capabilities.limitations.push(result.reason ?? 'Optional computer engine unavailable.'); continue; }
        capabilities.features.push(...result.capabilities.features);
        capabilities.limitations.push(...result.capabilities.limitations);
        // Core provisioner cannot promise persistent reattachment just because
        // a browser engine persists data inside this container.
      } catch { capabilities.limitations.push('Optional computer engine unavailable or contract version mismatch.'); }
    }
    capabilities.features = [...new Set(capabilities.features)].filter(f => !['persistent_profile', 'persistent_workspace'].includes(f));
    return { state: 'ready', capabilities, reason: null };
  }
  async reconnect(a) {
    if (!await this.inspect(a)) return { state: 'unavailable', capabilities: this.baseCapabilities(), reason: 'ImOrb disappeared. Explicit replacement will lose container-local state.' };
    return this.open(a);
  }
  async release(a) {
    if (!this.namespace || !a.computer_id.startsWith(this.namespace)) throw new Error('Cannot release a foreign computer.');
    if (await this.inspect(a)) await this.run(['destroy', a.computer_id]);
    if ((await this.containers()).includes(a.computer_id)) {
      await this.runCommand(this.dockerCommand, ['rm', '-f', `orbd-${a.computer_id}`]);
    }
    if (await this.inspect(a) || (await this.containers()).includes(a.computer_id)) throw new Error('ImOrb release is not acknowledged.');
  }
  async execute(a, identity, action, { signal }) {
    const controller = new AbortController();
    const bounded = AbortSignal.any([controller.signal, signal]);
    this.running.set(actionKey(identity), controller);
    try {
      if (features.includes(action.operation)) {
        const raw = await this.run(['exec', a.computer_id, 'bun', '-e', fileHelper], { signal: bounded,
          input: JSON.stringify({ identity, action }) });
        return JSON.parse(raw);
      }
      let discoveryUncertain = false;
      for (const engine of this.engines) {
        let state;
        try { state = await this.engineStatus(engine, a); }
        catch (error) { if (!(error instanceof ComputerNotDispatched)) discoveryUncertain = true; continue; }
        if (action.operation === 'screenshot' && !state.capabilities.features.includes(`${action.args.surface}.screenshot`)) continue;
        if (state.state === 'ready' && state.capabilities.features.includes(action.operation === 'screenshot' ? 'screenshot'
          : action.operation.startsWith('desktop.') ? 'desktop.lcu' : action.operation)) return engine.execute(a, identity, action, { signal: bounded });
      }
      // A health request may itself have crossed the transport boundary. Only
      // positively unavailable engines (or no engine) establish non-dispatch.
      if (discoveryUncertain) throw new Error('Computer engine availability has an unknown outcome.');
      throw new ComputerNotDispatched();
    } finally { this.running.delete(actionKey(identity)); }
  }
  async cancel(a, identity) {
    this.running.get(actionKey(identity))?.abort();
    await Promise.all(this.engines.map(engine => engine.cancel?.(a, identity)));
    // Killing host exec cannot prove remote effects stopped. Provider retains
    // uncertain effects; cancellation never implies rollback or safe replay.
  }
  async live_view(a, identity, options) {
    for (const engine of this.engines) {
      let state;
      try { state = await this.engineStatus(engine, a); } catch { continue; }
      if (state.state === 'ready' && state.capabilities.features.includes('live_view')) return engine.live_view(a, identity, options);
    }
    throw new Error('No expiring scoped remote-view service is installed. ImOrb portal tokens are not suitable short-lived sessions.');
  }
}
