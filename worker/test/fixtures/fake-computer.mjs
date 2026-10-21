import { COMPUTER_CONTRACT_VERSION } from '../../src/computer-contract.mjs';

// Deterministic external-computer stand-in. No network, paid requests or model loop.
export class FakeComputerBackend {
  constructor() { this.resources = new Map(); this.storage = new Map(); this.calls = []; this.lost = false; this.failAfterEffect = false; }
  capabilities() { return { contract_version: COMPUTER_CONTRACT_VERSION,
    features: ['browser.navigate', 'browser.read', 'browser.tabs', 'screenshot', 'files.read', 'files.write', 'files.ensure_directory', 'live_view', 'persistent_profile', 'persistent_workspace'],
    persistence: { workspace: true, profile: true }, limitations: [] }; }
  async open(a) {
    this.lost = false; this.resources.set(a.computer_id, structuredClone(a));
    if (!this.storage.has(a.persistent_state_key)) this.storage.set(a.persistent_state_key, { files: {}, url: null, cookies: {} });
    return this.status(a);
  }
  async status() { return { state: this.lost ? 'unavailable' : 'ready', capabilities: this.capabilities() }; }
  async reconnect(a) { this.lost = false; return this.resources.has(a.computer_id) ? this.status(a) : this.open(a); }
  async release(a) { this.resources.delete(a.computer_id); }
  async list() { return [...this.resources.values()]; }
  async execute(a, identity, action, { signal }) {
    signal.throwIfAborted();
    if (this.lost) throw new Error('Disconnected');
    this.calls.push({ ...identity, action });
    const state = this.storage.get(a.persistent_state_key);
    if (action.operation === 'files.write') state.files[action.args.path] = action.args.content;
    if (action.operation === 'files.read') return { text: state.files[action.args.path] ?? '' };
    if (action.operation === 'browser.navigate') state.url = action.args.url;
    if (action.operation === 'browser.read') return { url: state.url, text: 'Public-page fixture, not live inventory.' };
    if (action.operation === 'screenshot') return { content: [{ type: 'text', text: 'Fake provider: no real screenshot.' }] };
    if (this.failAfterEffect) { this.failAfterEffect = false; this.lost = true; throw new Error('Acknowledgement lost after effect'); }
    return { accepted: true };
  }
  async cancel() {}
  async live_view(_a, _identity, { mode }) { return { session_id: 'fake-session', access_url: 'https://view.example.test/scoped?token=fake', expires_at: new Date(Date.now() + 60000).toISOString(), mode }; }
}
