/** Canonical Burrow ComputerProvider contract. Engine adapters MUST import this module.
 * Breaking changes require a major version. Additive operations/capabilities require a minor version.
 * No engine-specific tools, credentials, model loops, booking or payment operations belong here.
 */
export const COMPUTER_CONTRACT_VERSION = '1.0.0';
export const COMPUTER_STATES = Object.freeze(['provisioning', 'ready', 'unavailable', 'reconnecting', 'replacing', 'released']);
export const REPLAY_CLASSES = Object.freeze(['read_only', 'idempotent_effect', 'non_idempotent_effect']);

// Each operation names a capability and its minimum effect classification. Engines
// advertise only implemented capabilities; registration never implies availability.
export const COMPUTER_OPERATIONS = Object.freeze({
  'browser.navigate': { capability: 'browser.navigate', replay: 'non_idempotent_effect', fields: ['url', 'tab_id'] },
  'browser.read': { capability: 'browser.read', replay: 'read_only', fields: ['tab_id'] },
  'browser.tabs': { capability: 'browser.tabs', replay: 'read_only', fields: [] },
  screenshot: { capability: 'screenshot', replay: 'read_only', fields: ['surface', 'target'] },
  'files.read': { capability: 'files.read', replay: 'read_only', fields: ['path'] },
  'files.write': { capability: 'files.write', replay: 'non_idempotent_effect', fields: ['path', 'content'] },
  'files.ensure_directory': { capability: 'files.ensure_directory', replay: 'idempotent_effect', fields: ['path'] },
  shell: { capability: 'shell', replay: 'non_idempotent_effect', fields: ['argv'] },
  'desktop.click': { capability: 'desktop.lcu', replay: 'non_idempotent_effect', fields: ['window_id', 'x', 'y'] },
  'desktop.type': { capability: 'desktop.lcu', replay: 'non_idempotent_effect', fields: ['window_id', 'text'] },
  'desktop.read_window': { capability: 'desktop.lcu', replay: 'read_only', fields: ['window_id'] },
  'desktop.app_launch': { capability: 'desktop.lcu', replay: 'non_idempotent_effect', fields: ['app'] },
});

/** Every call, including lifecycle, carries authenticated identity, never inferred from a model.
 * @typedef {{account:string, workspace_id:string, task_id:string, root_goal_id:string, request_id:string}} ComputerIdentity
 * @typedef {{contract_version:'1.0.0', features:string[], persistence:{workspace:boolean, profile:boolean}, limitations:string[]}} ComputerCapabilities
 * @typedef {{session_id:string, access_url:string, expires_at:string, mode:'read_only'|'interactive'}} LiveView
 * @typedef {{operation:string, args:object, replay_class:'read_only'|'idempotent_effect'|'non_idempotent_effect', invariant?:string}} ComputerAction
 * @typedef {{state:string, computer_id:string|null, generation:number, capabilities:ComputerCapabilities, reason:string|null}} ComputerStatus
 *
 * Public ComputerProvider methods (identity is the first argument):
 * open(identity), status(identity), capabilities(identity), reconnect(identity),
 * replace(identity), release(identity,{workspace?:boolean}),
 * execute(identity,action,{signal?}), stop(identity), live_view(identity,{mode}).
 * Receipts contain all identity fields, contract_version, computer_id, generation,
 * replay_class, dispatch/ack timestamps and status complete|uncertain|unavailable|stopped.
 * Uncertain effects remain unresolved across reconnect, replacement and restart.
 * Live-view secrets expire, are returned only to authenticated owners, never to the model/journal.
 *
 * Backend methods (host-only, not model tools):
 * open(allocation), status(allocation), reconnect(allocation), release(allocation),
 * list(), execute(allocation,identity,action,{signal}), cancel(allocation,identity),
 * live_view(allocation,identity,{mode}).
 * allocation includes account, workspace_id, deterministic computer_id, generation,
 * persistent_state_key, and storage root. list() must be scoped to this provider namespace.
 * open/reconnect/release must reconcile deterministic IDs before reissuing lifecycle work.
 * execute must never internally replay effects after dispatch uncertainty.
 * Returned status is validated by the host; a backend cannot grant a task permissions.
 */

export const canonicalComputerJson = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

export function validateComputerIdentity(identity) {
  for (const key of ['account', 'workspace_id', 'task_id', 'root_goal_id', 'request_id']) {
    if (typeof identity?.[key] !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(identity[key])) throw new Error(`Invalid computer identity: ${key}.`);
  }
}

export function validateComputerAction(action, policy = {}) {
  const spec = COMPUTER_OPERATIONS[action?.operation];
  if (!spec || !REPLAY_CLASSES.includes(action.replay_class)) throw new Error('Unsupported computer operation or replay class.');
  if (!action.args || Array.isArray(action.args) || Object.keys(action.args).some(k => !spec.fields.includes(k))) throw new Error('Invalid computer arguments.');
  let replay = spec.replay;
  // A GET/navigation can consume a one-time token or submit an action. Only an
  // exact operator-reviewed URL can be downgraded; the model cannot declare it safe.
  if (action.operation === 'browser.navigate') {
    const url = new URL(action.args.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('An approved HTTPS navigation is required.');
    if (!policy.allowed_urls?.includes(url.href)) throw new Error('URL is outside this computer grant.');
    if (action.replay_class === 'read_only' && policy.read_only_urls?.includes(url.href)) replay = 'read_only';
  }
  if (action.replay_class !== replay) throw new Error('Replay classification violates the operation policy.');
  if (replay === 'idempotent_effect' && action.invariant !== 'mkdir_exists_v1') throw new Error('A tested idempotency invariant is required.');
  if (action.operation.startsWith('files.')) {
    if (typeof action.args.path !== 'string' || action.args.path.length > 512 || !/^[a-zA-Z0-9_./ -]+$/.test(action.args.path)
      || action.args.path.startsWith('/') || action.args.path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('A relative workspace path is required.');
    if (action.operation === 'files.write' && (typeof action.args.content !== 'string' || Buffer.byteLength(action.args.content) > 65536)) throw new Error('File content exceeds the bounded text contract.');
  }
  if (action.operation === 'shell' && (!policy.shell || !Array.isArray(action.args.argv) || !action.args.argv.length
    || action.args.argv.length > 32 || action.args.argv.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0')))) throw new Error('Shell capability is not authorized or argv is invalid.');
  if (['desktop.click', 'desktop.type', 'desktop.read_window'].includes(action.operation)
    && (!Number.isSafeInteger(action.args.window_id) || action.args.window_id <= 0)) throw new Error('A current window ID is required.');
  if (action.operation === 'desktop.click' && ![action.args.x, action.args.y].every(n => Number.isInteger(n) && n >= 0 && n < 16384)) throw new Error('Invalid click coordinates.');
  if (action.operation === 'desktop.type' && (typeof action.args.text !== 'string' || !action.args.text || action.args.text.length > 8000)) throw new Error('Invalid input text.');
  if (action.operation === 'desktop.app_launch' && !policy.apps?.includes(action.args.app)) throw new Error('App is outside this computer grant.');
  if (action.operation === 'screenshot' && !['browser', 'desktop'].includes(action.args.surface)) throw new Error('Select a screenshot surface.');
  for (const key of ['tab_id', 'target']) if (action.args[key] !== undefined && (typeof action.args[key] !== 'string' || action.args[key].length > 160)) throw new Error('Invalid target identity.');
  return spec;
}

export function validateComputerCapabilities(value) {
  if (value?.contract_version !== COMPUTER_CONTRACT_VERSION || !Array.isArray(value.features)
    || !value.features.every(f => typeof f === 'string' && /^[a-z_.]+$/.test(f))
    || typeof value.persistence?.workspace !== 'boolean' || typeof value.persistence?.profile !== 'boolean'
    || !Array.isArray(value.limitations) || !value.limitations.every(l => typeof l === 'string')) throw new Error('Computer engine contract mismatch.');
  return value;
}
