import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { COMPUTER_CONTRACT_VERSION, COMPUTER_STATES, ComputerNotDispatched, canonicalComputerJson as canonical,
  validateComputerAction, validateComputerCapabilities, validateComputerIdentity } from './computer-contract.mjs';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const emptyCapabilities = () => ({ contract_version: COMPUTER_CONTRACT_VERSION, features: [], persistence: { workspace: false, profile: false }, limitations: ['No computer attached.'] });

// A broken engine may ignore AbortSignal. Do not let it pin the Pi worker;
// losing acknowledgement still leaves effects uncertain, never safe to replay.
async function acknowledged(work, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      abort = () => reject(new Error('Computer acknowledgement interrupted.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** Shared per-workspace computer allocation and action journal, not a task runtime.
 * Burrow supplies grants and authenticated identities; Pi supplies stable tool IDs.
 * The backend supplies resources and engines, never task authority or model calls.
 */
export class ComputerProvider {
  constructor({ directory, backend, grants, resolveGrants, idleMs = 900000, now = Date.now }) {
    if (!Number.isSafeInteger(idleMs) || idleMs < 1000) throw new Error('Invalid computer idle timeout.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lease = new DatabaseSync(join(directory, 'owner.sqlite'));
    try { this.lease.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER)'); }
    catch (error) { this.lease.close(); throw error; }
    this.db = new DatabaseSync(join(directory, 'computers.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS allocations(scope TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(task_key TEXT PRIMARY KEY, scope TEXT NOT NULL, identity TEXT NOT NULL, active INTEGER NOT NULL, stopped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, scope TEXT NOT NULL, identity TEXT NOT NULL, fingerprint TEXT NOT NULL,
        replay_class TEXT NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL, dispatched_at TEXT NOT NULL, response TEXT);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT);
      CREATE TABLE IF NOT EXISTS browser_control(scope TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL, phase TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_returned_sessions(scope TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(scope,session_id));
      UPDATE actions SET state='uncertain' WHERE state='dispatching' AND replay_class='non_idempotent_effect';`);
    this.backend = backend; this.grants = structuredClone(grants ?? []); this.resolveGrants = resolveGrants;
    this.idleMs = idleMs; this.now = now; this.queues = new Map(); this.active = new Map();
    this.namespace = `bk-${hash(directory).slice(0, 12)}-`;
    backend.setNamespace?.(this.namespace);
  }
  currentGrants() {
    // Host-owned synchronous snapshot: no yield between the last policy check
    // and durable dispatch. Missing/unreadable policy fails closed.
    const grants = this.resolveGrants ? this.resolveGrants() : this.grants;
    if (!Array.isArray(grants)) throw new Error('Computer permission policy unavailable.');
    return grants;
  }
  authorize(identity) {
    validateComputerIdentity(identity);
    const grant = this.currentGrants().find(g => g.account === identity.account && g.workspace_id === identity.workspace_id);
    if (!grant) throw new Error('Computer workspace is not authorized for this account.');
    const taskKey = hash([identity.account, identity.task_id, identity.root_goal_id]);
    const member = this.db.prepare('SELECT * FROM members WHERE task_key=?').get(taskKey);
    const scope = hash([identity.account, identity.workspace_id]);
    if (member && member.scope !== scope) throw new Error('Task computer workspace cannot change.');
    return { grant, scope, taskKey, member };
  }
  serialized(scope, action) {
    const pending = (this.queues.get(scope) ?? Promise.resolve()).then(action);
    const tail = pending.catch(() => {});
    this.queues.set(scope, tail);
    void tail.then(() => { if (this.queues.get(scope) === tail) this.queues.delete(scope); });
    return pending;
  }
  record(data) {
    this.db.prepare('INSERT INTO events(data) VALUES(?)').run(JSON.stringify({ contract_version: COMPUTER_CONTRACT_VERSION, at: new Date(this.now()).toISOString(), ...data }));
  }
  allocation(scope) { const row = this.db.prepare('SELECT data FROM allocations WHERE scope=?').get(scope); return row && JSON.parse(row.data); }
  privateBrowser(scope) { return this.db.prepare('SELECT * FROM browser_control WHERE scope=?').get(scope); }
  isPrivate(identity) { return !!this.privateBrowser(hash([identity.account, identity.workspace_id])); }
  requireAgentControl(scope) {
    if (this.privateBrowser(scope)) throw new ComputerNotDispatched();
  }
  async waitForAgent(identity, { signal, stopped = () => false } = {}) {
    // Permission wait only: no task submission, retries, model calls or budget.
    const { scope } = this.authorize(identity);
    while (this.privateBrowser(scope) && !stopped()) {
      await delay(100, undefined, { signal });
      this.authorize(identity);
    }
  }
  save(scope, allocation) { this.db.prepare('INSERT OR REPLACE INTO allocations VALUES(?,?)').run(scope, JSON.stringify(allocation)); return allocation; }
  attach(identity, scope, taskKey) {
    this.db.prepare('INSERT INTO members(task_key,scope,identity,active) VALUES(?,?,?,1) ON CONFLICT(task_key) DO UPDATE SET active=1')
      .run(taskKey, scope, JSON.stringify(identity));
  }
  view(allocation) {
    return allocation ? { contract_version: COMPUTER_CONTRACT_VERSION, computer_id: allocation.computer_id, generation: allocation.generation,
      state: allocation.state, reason: allocation.reason, capabilities: allocation.capabilities, last_used: allocation.last_used }
      : { contract_version: COMPUTER_CONTRACT_VERSION, computer_id: null, generation: 0, state: 'released', reason: 'No computer attached.', capabilities: emptyCapabilities() };
  }
  async destructiveLifecycle(identity, operation, options, work) {
    const { taskKey, scope } = this.authorize(identity);
    const id = hash([taskKey, identity.request_id]);
    const fingerprint = hash({ identity, operation, options });
    const prior = this.db.prepare('SELECT * FROM lifecycle WHERE id=?').get(id);
    if (prior && prior.fingerprint !== fingerprint) throw new Error('Lifecycle request terms changed.');
    if (prior) return prior.response ? JSON.parse(prior.response) : { ...this.view(this.allocation(scope)),
      status: 'uncertain', reason: 'Lifecycle acknowledgement lost. Inspect current status; do not repeat this destructive request.' };
    this.db.prepare('INSERT INTO lifecycle VALUES(?,?,NULL)').run(id, fingerprint);
    this.record({ ...identity, operation, replay_class: 'non_idempotent_effect', phase: 'requested' });
    const result = await work();
    this.db.prepare('UPDATE lifecycle SET response=? WHERE id=?').run(JSON.stringify(result), id);
    return result;
  }
  async open(identity) {
    const { scope, taskKey, member } = this.authorize(identity);
    this.requireAgentControl(scope);
    if (member?.stopped) return this.view(this.allocation(scope));
    return this.serialized(scope, async () => {
      this.requireAgentControl(scope);
      if (this.authorize(identity).member?.stopped) return this.view(this.allocation(scope));
      this.attach(identity, scope, taskKey);
      let allocation = this.allocation(scope);
      if (!allocation || allocation.state === 'released') {
        const generation = (allocation?.generation ?? 0) + 1;
        allocation = { account: identity.account, workspace_id: identity.workspace_id, computer_id: `${this.namespace}${hash([scope, generation]).slice(0, 16)}`,
          generation, persistent_state_key: scope, namespace: this.namespace, state: 'provisioning', capabilities: emptyCapabilities(), reason: null, last_used: this.now() };
        this.save(scope, allocation);
      }
      if (allocation.state === 'ready') { allocation.last_used = this.now(); this.save(scope, allocation); return this.view(allocation); }
      return this.refresh(scope, allocation, 'open', identity);
    });
  }
  async refresh(scope, allocation, method, identity) {
    allocation.request_identity = identity;
    this.save(scope, allocation);
    this.record({ ...identity, operation: method, computer_id: allocation.computer_id, phase: 'requested',
      replay_class: method === 'status' ? 'read_only' : 'idempotent_effect', invariant: method === 'status' ? undefined : 'deterministic_resource_id_v1' });
    try {
      const result = await acknowledged(() => this.backend[method](allocation), AbortSignal.timeout(240000));
      if (!COMPUTER_STATES.includes(result.state)) throw new Error('Unknown computer state.');
      validateComputerCapabilities(result.capabilities);
      allocation.state = result.state; allocation.capabilities = result.capabilities;
      allocation.reason = result.reason ?? null; allocation.last_used = this.now();
    } catch {
      allocation.state = 'unavailable'; allocation.reason = 'Computer unavailable. Pi task state is retained; reconnect or replace the resource.';
      allocation.capabilities = emptyCapabilities();
    }
    this.save(scope, allocation); this.record({ ...identity, operation: method, ...this.view(allocation) });
    return this.view(allocation);
  }
  async status(identity) {
    const { scope } = this.authorize(identity);
    const allocation = this.allocation(scope);
    if (!allocation || allocation.state === 'released') return this.view(allocation);
    return this.serialized(scope, () => {
      this.authorize(identity);
      const current = this.allocation(scope);
      return current.state === 'released' ? this.view(current) : this.refresh(scope, current, 'status', identity);
    });
  }
  async capabilities(identity) { return (await this.status(identity)).capabilities; }
  async reconnect(identity) {
    const { scope } = this.authorize(identity);
    this.requireAgentControl(scope);
    return this.serialized(scope, async () => {
      this.requireAgentControl(scope);
      if (this.authorize(identity).member?.stopped) return this.view(this.allocation(scope));
      const allocation = this.allocation(scope);
      if (!allocation || allocation.state === 'released') return this.view(allocation);
      allocation.state = 'reconnecting'; this.save(scope, allocation);
      return this.refresh(scope, allocation, 'reconnect', identity);
    });
  }
  async replace(identity) {
    return this.destructiveLifecycle(identity, 'replace', {}, () => this.replaceResource(identity));
  }
  async replaceResource(identity) {
    const { scope, taskKey } = this.authorize(identity);
    this.requireAgentControl(scope);
    return this.serialized(scope, async () => {
      this.requireAgentControl(scope);
      if (this.authorize(identity).member?.stopped) return this.view(this.allocation(scope));
      const previous = this.allocation(scope);
      if (previous && previous.state !== 'released') {
        previous.state = 'replacing'; this.save(scope, previous);
        // Do not allocate a second resource until release of the first is acknowledged.
        try { await acknowledged(() => this.backend.release(previous), AbortSignal.timeout(60000)); }
        catch { previous.state = 'unavailable'; previous.reason = 'Replacement blocked: release outcome needs reconciliation.'; this.save(scope, previous); return this.view(previous); }
      }
      this.authorize(identity);
      const generation = (previous?.generation ?? 0) + 1;
      const allocation = { account: identity.account, workspace_id: identity.workspace_id, computer_id: `${this.namespace}${hash([scope, generation]).slice(0, 16)}`,
        generation, persistent_state_key: scope, namespace: this.namespace, state: 'replacing', capabilities: emptyCapabilities(), reason: null, last_used: this.now() };
      this.save(scope, allocation); this.attach(identity, scope, taskKey);
      const result = await this.refresh(scope, allocation, 'open', identity);
      this.record({ ...identity, operation: 'replacement_persistence', computer_id: allocation.computer_id, generation,
        persistence: result.capabilities.persistence, limitations: result.capabilities.limitations });
      return result;
    });
  }
  async execute(identity, action, { signal: parentSignal } = {}) {
    const { scope, taskKey, grant, member } = this.authorize(identity);
    this.requireAgentControl(scope);
    const spec = validateComputerAction(action, grant);
    if (!grant.features?.includes(spec.capability)) throw new Error('Computer operation is outside the workspace permission grant.');
    if (member?.stopped || (member && !member.active)) return { ...identity, status: 'stopped' };
    return this.serialized(scope, async () => {
      this.requireAgentControl(scope);
      const current = this.authorize(identity);
      validateComputerAction(action, current.grant);
      if (!current.grant.features?.includes(spec.capability)) throw new Error('Computer operation is outside the workspace permission grant.');
      const id = hash([taskKey, identity.request_id]);
      const fingerprint = hash({ identity, action });
      const prior = this.db.prepare('SELECT * FROM actions WHERE id=?').get(id);
      if (prior && prior.fingerprint !== fingerprint) throw new Error('Action identity already has different terms.');
      if (prior?.state === 'complete') return JSON.parse(prior.response);
      const unresolved = this.db.prepare("SELECT 1 FROM actions WHERE scope=? AND state IN ('uncertain','dispatching') AND replay_class='non_idempotent_effect' LIMIT 1").get(scope);
      if (prior?.state === 'uncertain' || (unresolved && action.replay_class !== 'read_only')) return { ...identity, status: 'uncertain', reason: 'An external effect may have happened. No effect will be replayed; observations remain available.' };
      const allocation = this.allocation(scope);
      if (!allocation || allocation.state !== 'ready') return { ...identity, status: 'unavailable', reason: 'Open or reconnect the computer before issuing actions.' };
      if (!allocation.capabilities.features.includes(spec.capability)) return { ...identity, status: 'unavailable', reason: 'The attached computer does not implement this capability.' };
      if (action.replay_class === 'idempotent_effect' && !allocation.capabilities.features.includes('files.ensure_directory')) throw new Error('Idempotency invariant unavailable.');
      const stopped = this.db.prepare('SELECT stopped,active FROM members WHERE task_key=?').get(taskKey);
      if (stopped?.stopped || !stopped?.active || parentSignal?.aborted) return { ...identity, status: 'stopped' };
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(60000)]);
      const tags = { ...identity, contract_version: COMPUTER_CONTRACT_VERSION, computer_id: allocation.computer_id, generation: allocation.generation, replay_class: action.replay_class };
      const dispatched_at = new Date(this.now()).toISOString();
      this.db.prepare(`INSERT INTO actions VALUES(?,?,?,?,?,?,'dispatching',?,NULL)
        ON CONFLICT(id) DO UPDATE SET state='dispatching',dispatched_at=excluded.dispatched_at`).run(id, scope, JSON.stringify(tags), fingerprint, action.replay_class, action.operation, dispatched_at);
      this.record({ ...tags, operation: action.operation, status: 'dispatching', dispatched_at });
      allocation.last_used = this.now(); this.save(scope, allocation);
      let settle;
      const done = new Promise(resolve => { settle = resolve; });
      this.active.set(taskKey, { controller, allocation, identity, done });
      try {
        const output = await acknowledged(() => this.backend.execute(allocation, tags, action, { signal }), signal);
        // A human may have fenced the workspace while this read/write was in
        // flight. Suppress the response without claiming its effect never ran.
        if (this.privateBrowser(scope)) throw new Error('Browser control changed during execution.');
        if (!output || output.isError || JSON.stringify(output).length > 8_000_000) throw new Error('Computer action not acknowledged.');
        const receipt = { ...tags, operation: action.operation, status: 'complete', dispatched_at, acknowledged_at: new Date(this.now()).toISOString(), output };
        this.db.prepare("UPDATE actions SET state='complete',response=? WHERE id=?").run(JSON.stringify(receipt), id);
        this.record({ ...tags, operation: action.operation, status: 'complete', acknowledged_at: receipt.acknowledged_at });
        return receipt;
      } catch (error) {
        const notDispatched = error instanceof ComputerNotDispatched;
        const status = !notDispatched && action.replay_class === 'non_idempotent_effect' ? 'uncertain' : 'unavailable';
        this.db.prepare('UPDATE actions SET state=? WHERE id=?').run(status, id);
        allocation.state = 'unavailable'; allocation.reason = notDispatched
          ? 'Computer action was not dispatched. Restore the engine and reconnect before retrying.'
          : 'Computer action lost its acknowledgement. Task remains durable; uncertain effects will not be replayed.';
        this.save(scope, allocation); this.record({ ...tags, operation: action.operation, status, not_dispatched: notDispatched });
        return { ...tags, status, reason: allocation.reason };
      } finally {
        this.active.delete(taskKey);
        try { allocation.last_used = this.now(); this.save(scope, allocation); } finally { settle(); }
      }
    });
  }
  async live_view(identity, { mode = 'read_only' } = {}) {
    const { scope, grant } = this.authorize(identity);
    this.requireAgentControl(scope);
    if (!['read_only', 'interactive'].includes(mode) || !grant.features?.includes('live_view')) throw new Error('Live view is not authorized.');
    return this.serialized(scope, async () => {
      this.requireAgentControl(scope);
      const current = this.authorize(identity);
      if (!current.grant.features?.includes('live_view') || !current.member?.active) throw new Error('Live view is not authorized.');
      const allocation = this.allocation(scope);
      if (allocation?.state !== 'ready' || !allocation.capabilities.features.includes('live_view')) return { status: 'unavailable', reason: 'No scoped live-view engine is installed.' };
      const view = await acknowledged(() => this.backend.live_view(allocation, identity, { mode }), AbortSignal.timeout(10000));
      this.requireAgentControl(scope);
      const latest = this.authorize(identity);
      if (!latest.grant.features?.includes('live_view') || !latest.member?.active) throw new Error('Live view is not authorized.');
      const expiry = Date.parse(view?.expires_at);
      if (!view?.session_id || view.mode !== mode || !Number.isFinite(expiry) || expiry <= this.now() || expiry > this.now() + 300000
        || new URL(view.access_url).protocol !== 'https:') throw new Error('Invalid scoped live-view descriptor.');
      // Never persist a bearer URL/token in task/model history.
      this.record({ ...identity, operation: 'live_view', mode, session_id: view.session_id, expires_at: view.expires_at });
      return view;
    });
  }
  /** Host-only human control plane, deliberately absent from ComputerProvider
   * model tools. Frames and input never enter Pi's events, receipts or Materials.
   * Session IDs are identities, not bearer credentials: every call is authorized.
   */
  async browserControl(identity, command) {
    const { scope, taskKey, grant, member } = this.authorize(identity);
    if (!member?.active || grant.private_browser !== true || !this.backend.browserControl
      || grant.features.some(f => ['shell', 'desktop.lcu', 'live_view'].includes(f))) throw new Error('Private browser control is not authorized.');
    if (!['status', 'take_over', 'give_back', 'frame', 'input'].includes(command.action)) throw new Error('Unknown browser control action.');
    const allocation = this.allocation(scope);
    if (!allocation || allocation.state === 'released') throw new Error('No browser allocation.');
    const prior = this.privateBrowser(scope);
    if (command.action === 'status') return this.serialized(scope, async () => {
      const current = this.authorize(identity);
      if (!current.member?.active || current.grant.private_browser !== true
        || current.grant.features.some(f => ['shell', 'desktop.lcu', 'live_view'].includes(f))) throw new Error('Private browser control revoked.');
      const control = this.privateBrowser(scope);
      if (control && control.owner !== taskKey) return { phase: control.phase, session_id: null };
      const result = await acknowledged(() => this.backend.browserControl(this.allocation(scope), identity,
        { action: 'status', ...(control ? { session_id: control.session_id } : {}) }), AbortSignal.timeout(15000));
      if (result?.generation !== allocation.generation || (control && result.session_id !== control.session_id)) throw new Error('Private browser acknowledgement mismatch.');
      if (control) {
        if (result.phase === 'agent' && control.phase === 'giving_back') {
          this.db.prepare('INSERT OR IGNORE INTO browser_returned_sessions VALUES(?,?)').run(scope, control.session_id);
          this.db.prepare('DELETE FROM browser_control WHERE scope=?').run(scope);
        }
        else if (control.phase === 'input_uncertain') return { phase: control.phase, session_id: control.session_id, generation: allocation.generation };
        else if (['human', 'input_uncertain'].includes(result.phase)) this.db.prepare('UPDATE browser_control SET phase=? WHERE scope=?').run(result.phase, scope);
        else return { phase: control.phase, session_id: control.session_id, generation: allocation.generation };
      } else if (result.phase !== 'agent') throw new Error('Unreconciled private browser session.');
      return result;
    });
    if (command.action === 'take_over') {
      if (member.stopped) throw new Error('Browser takeover is unavailable.');
      if (this.db.prepare('SELECT 1 FROM browser_returned_sessions WHERE scope=? AND session_id=?').get(scope, identity.request_id)) throw new Error('Private session already returned.');
      if (prior && (prior.owner !== taskKey || prior.session_id !== identity.request_id)) throw new Error('An existing private session must be resolved first.');
      if (prior && !['taking_over', 'human'].includes(prior.phase)) throw new Error('Private session must be reconciled before takeover.');
      const views = this.db.prepare("SELECT data FROM events WHERE json_extract(data,'$.operation')='live_view' AND json_extract(data,'$.account')=? AND json_extract(data,'$.workspace_id')=? AND json_extract(data,'$.at')>?")
        .all(identity.account, identity.workspace_id, new Date(this.now() - 300000).toISOString());
      if (views.some(row => Date.parse(JSON.parse(row.data).expires_at) > this.now())) throw new Error('An earlier browser view must expire before private takeover.');
      // FULL synchronous commit fences ALL peer tasks before any await or
      // queued browser operation. A crash/revocation never releases this fence.
      if (!prior) this.db.prepare("INSERT INTO browser_control VALUES(?,?,?,'taking_over')").run(scope, taskKey, identity.request_id);
    } else if (!prior || prior.owner !== taskKey || command.session_id !== prior.session_id) throw new Error('Private browser session mismatch.');
    return this.serialized(scope, async () => {
      const current = this.authorize(identity);
      if (!current.member?.active || current.grant.private_browser !== true
        || current.grant.features.some(f => ['shell', 'desktop.lcu', 'live_view'].includes(f))) throw new Error('Private browser control revoked.');
      const control = this.privateBrowser(scope);
      if (!control || control.owner !== taskKey) throw new Error('Private browser control changed.');
      if (command.action === 'input' && control.phase !== 'human') throw new Error('Private input is fenced.');
      if (command.action === 'give_back') this.db.prepare("UPDATE browser_control SET phase='giving_back' WHERE scope=?").run(scope);
      // Commit before dispatch: a worker crash cannot silently enable another
      // input attempt, and no typed content or password hash is journaled.
      if (command.action === 'input') this.db.prepare("UPDATE browser_control SET phase='input_uncertain' WHERE scope=?").run(scope);
      const result = await acknowledged(() => this.backend.browserControl(this.allocation(scope), identity,
        { ...command, session_id: control.session_id }), AbortSignal.timeout(45000));
      // A response is never proof of revocation unless the matching generation
      // and session were acknowledged. Unknown outcomes stay fenced.
      if (result?.session_id !== control.session_id || result.generation !== allocation.generation) throw new Error('Private browser acknowledgement mismatch.');
      const latest = this.authorize(identity);
      if (!latest.member?.active || latest.grant.private_browser !== true
        || latest.grant.features.some(f => ['shell', 'desktop.lcu', 'live_view'].includes(f))) throw new Error('Private browser control revoked.');
      if (command.action === 'give_back') {
        if (result.phase !== 'agent') throw new Error('Human access revocation is not confirmed.');
        this.db.prepare('INSERT OR IGNORE INTO browser_returned_sessions VALUES(?,?)').run(scope, control.session_id);
        this.db.prepare('DELETE FROM browser_control WHERE scope=?').run(scope);
      } else if (command.action === 'take_over' || command.action === 'input') {
        if (result.phase !== 'human') throw new Error('Private control is not confirmed.');
        this.db.prepare("UPDATE browser_control SET phase='human' WHERE scope=?").run(scope);
      }
      return result;
    });
  }
  async stop(identity) {
    const { scope, taskKey } = this.authorize(identity);
    this.attach(identity, scope, taskKey);
    this.db.prepare('UPDATE members SET stopped=1 WHERE task_key=?').run(taskKey);
    const active = this.active.get(taskKey);
    active?.controller.abort();
    if (active) await acknowledged(() => this.backend.cancel(active.allocation, active.identity), AbortSignal.timeout(5000)).catch(() => {});
    // Queued actions recheck stopped before dispatch. Do not wait for another
    // task's work merely because it shares this workspace's serial queue.
    await active?.done;
    this.record({ ...identity, operation: 'stop', status: 'acknowledged', rollback: false });
  }
  async release(identity, { workspace = false } = {}) {
    return this.destructiveLifecycle(identity, 'release', { workspace }, () => this.releaseMembership(identity, { workspace }));
  }
  async releaseMembership(identity, { workspace }) {
    const { scope, taskKey } = this.authorize(identity);
    this.requireAgentControl(scope);
    if (workspace) {
      for (const row of this.db.prepare('SELECT identity FROM members WHERE scope=? AND active=1').all(scope)) await this.stop(JSON.parse(row.identity));
    } else await this.stop(identity);
    return this.serialized(scope, async () => {
      this.requireAgentControl(scope);
      if (workspace) this.db.prepare('UPDATE members SET active=0 WHERE scope=?').run(scope);
      else this.db.prepare('UPDATE members SET active=0 WHERE task_key=?').run(taskKey);
      if (this.db.prepare('SELECT 1 FROM members WHERE scope=? AND active=1 LIMIT 1').get(scope)) return this.view(this.allocation(scope));
      return this.releaseAllocation(scope, identity);
    });
  }
  async releaseAllocation(scope, identity = {}) {
    const allocation = this.allocation(scope);
    if (!allocation || allocation.state === 'released') return this.view(allocation);
    try { await acknowledged(() => this.backend.release(allocation), AbortSignal.timeout(60000)); allocation.state = 'released'; allocation.reason = 'Computer released. Durable task records are unchanged.'; }
    catch { allocation.state = 'unavailable'; allocation.reason = 'Computer release needs reconciliation; cleanup will retry.'; }
    this.save(scope, allocation); this.record({ ...identity, operation: 'release', ...this.view(allocation) });
    return this.view(allocation);
  }
  async reconcile() {
    // Called by worker startup/maintenance, not an independent agent scheduler.
    let resources;
    try { resources = await acknowledged(() => this.backend.list(), AbortSignal.timeout(30000)); }
    catch {
      for (const row of this.db.prepare('SELECT scope FROM allocations').all()) await this.serialized(row.scope, async () => {
        const allocation = this.allocation(row.scope);
        if (allocation.state !== 'released') {
          allocation.state = 'unavailable'; allocation.reason = 'Computer registry unavailable. Pi task state is retained.';
          this.save(row.scope, allocation);
        }
      });
      return;
    }
    const known = new Set(this.db.prepare('SELECT data FROM allocations').all().map(r => JSON.parse(r.data).computer_id));
    for (const resource of resources) if (resource.namespace === this.namespace && !known.has(resource.computer_id)) {
      await this.backend.release(resource); this.record({ operation: 'orphan_cleanup', computer_id: resource.computer_id });
    }
    for (const row of this.db.prepare('SELECT scope,data FROM allocations').all()) {
      await this.serialized(row.scope, async () => {
        const allocation = this.allocation(row.scope);
        // Private sessions are never destroyed merely because Kikka is idle.
        // Permission loss keeps the agent fenced; it does not give control back.
        if (this.privateBrowser(row.scope)) return;
        if (allocation.state === 'released') {
          if (resources.some(r => r.computer_id === allocation.computer_id)) await this.backend.release(allocation);
          return;
        }
        const member = this.db.prepare('SELECT identity FROM members WHERE scope=? AND active=1 LIMIT 1').get(row.scope);
        const grant = this.currentGrants().find(g => g.account === allocation.account && g.workspace_id === allocation.workspace_id);
        // An idle timeout must not silently destroy a signed-in private profile.
        // Retain it while authorized and attached; release remains explicit.
        if (!grant || !member || (grant.private_browser !== true && this.now() - allocation.last_used >= this.idleMs)) { await this.releaseAllocation(row.scope); return; }
        // Health checks do not extend the idle deadline.
        const used = allocation.last_used;
        await this.refresh(row.scope, allocation, 'status', JSON.parse(member.identity));
        allocation.last_used = used; this.save(row.scope, allocation);
      });
    }
  }
  receipt(identity) {
    const { taskKey, scope } = this.authorize(identity);
    this.requireAgentControl(scope);
    const row = this.db.prepare('SELECT response,state,identity FROM actions WHERE id=?').get(hash([taskKey, identity.request_id]));
    if (!row) throw new Error('Unknown computer receipt.');
    return row.response ? JSON.parse(row.response) : { ...JSON.parse(row.identity), status: row.state };
  }
  async close() {
    for (const active of this.active.values()) active.controller.abort();
    await Promise.all(this.queues.values());
    await this.backend.close?.(); this.db.close(); this.lease.close();
  }
}
