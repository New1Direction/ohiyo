import { createHash } from 'node:crypto';
import { COMPUTER_CONTRACT_VERSION, validateComputerIdentity } from './computer-contract.mjs';

export const CRAWL4AI_VERSION = '0.9.5';
if (COMPUTER_CONTRACT_VERSION !== '1.1.0') throw new Error('Browser engine requires ComputerProvider 1.1.0.');
const operations = ['browser.navigate', 'browser.read', 'browser.tabs', 'screenshot'];
const key = i => JSON.stringify([i.account, i.workspace_id, i.task_id, i.root_goal_id, i.request_id]);
const matches = (a, b) => ['account', 'workspace_id', 'computer_id', 'generation'].every(k => a?.[k] === b?.[k]);

/** Resource engine only. The transport is the existing fixed-argv ImOrb host
 * transport, never host agent/submit. Authentication stays inside the ImOrb.
 * No retries: even GET/navigation may consume a one-time link.
 */
export class Crawl4aiEngine {
  constructor({ transport }) { this.transport = transport; }
  async request(allocation, endpoint, body, signal) {
    const raw = await this.transport.run(['exec', allocation.computer_id, 'bun', '/opt/burrow-browser/relay.mjs'], {
      input: JSON.stringify({ endpoint, body }), signal, timeoutMs: 55000,
    });
    const reply = JSON.parse(raw);
    if (!reply.ok) throw new Error('Browser service did not acknowledge this operation. Reconcile before retrying effects.');
    return reply.data;
  }
  async status(allocation) {
    const empty = { contract_version: COMPUTER_CONTRACT_VERSION, features: [], persistence: { workspace: false, profile: false }, limitations: [] };
    // Transport failures must propagate: swallowing a post-write health failure
    // as definite unavailability would violate ComputerNotDispatched semantics.
    const result = await this.request(allocation, '/status', { allocation });
    if (!matches(allocation, result.binding) || result.crawl4ai_version !== CRAWL4AI_VERSION || result.state !== 'ready') {
      return { state: 'unavailable', capabilities: { ...empty, limitations: ['Browser binding, CDP readiness or pinned crawl4ai version mismatch.'] } };
    }
    return { state: 'ready', capabilities: { ...empty,
      features: ['browser.cdp', 'browser.navigate', 'browser.read', 'browser.tabs', 'browser.screenshot', 'screenshot'],
      limitations: ['No live view. Replacement profile continuity depends on ImOrb volume support.',
        'Research prices are advisory, never booking amounts. Unknown layouts require extraction by the existing Pi model loop.'] } };
  }
  async execute(allocation, identity, action, { signal }) {
    validateComputerIdentity(identity);
    if (identity.account !== allocation.account || identity.workspace_id !== allocation.workspace_id
      || !operations.includes(action.operation) || (action.operation === 'screenshot' && action.args.surface !== 'browser')) {
      throw new Error('Browser operation or ownership rejected before dispatch.');
    }
    if (signal.aborted) throw signal.reason;
    const id = key(identity);
    const abort = () => { void this.cancel(allocation, identity).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const binding = Object.fromEntries(['account', 'workspace_id', 'computer_id', 'generation'].map(k => [k, allocation[k]]));
      const owner = Object.fromEntries(['account', 'workspace_id', 'task_id', 'root_goal_id', 'request_id'].map(k => [k, identity[k]]));
      const output = await this.request(allocation, '/execute', { allocation: binding, identity: owner, action }, signal);
      if (!output || !Array.isArray(output.artifacts) || output.artifacts.length > 3) throw new Error('Invalid browser evidence.');
      for (const artifact of output.artifacts) {
        if (!['markdown', 'json', 'screenshot'].includes(artifact.kind)
          || key(artifact.identity) !== id || !Number.isFinite(Date.parse(artifact.fetched_at))
          || !['https:'].includes(new URL(artifact.source_url).protocol)) throw new Error('Browser artifact scope or provenance mismatch.');
        if (artifact.kind === 'screenshot') {
          if (artifact.media_type !== 'image/png' || typeof artifact.base64 !== 'string' || artifact.base64.length > 4_000_000) throw new Error('Invalid screenshot artifact.');
          const bytes = Buffer.from(artifact.base64, 'base64');
          if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Expected a PNG screenshot.');
          artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
        } else if (typeof artifact.content !== 'string' || artifact.content.length > 100000) throw new Error('Browser material exceeds limits.');
      }
      return output;
    } finally { signal.removeEventListener('abort', abort); }
  }
  async cancel(allocation, identity) {
    validateComputerIdentity(identity);
    if (identity.account !== allocation.account || identity.workspace_id !== allocation.workspace_id) throw new Error('Browser cancellation scope mismatch.');
    return this.request(allocation, '/cancel', {
      allocation: Object.fromEntries(['account', 'workspace_id', 'computer_id', 'generation'].map(k => [k, allocation[k]])),
      identity: Object.fromEntries(['account', 'workspace_id', 'task_id', 'root_goal_id', 'request_id'].map(k => [k, identity[k]])),
    });
  }
  async browserControl(allocation, identity, command) {
    validateComputerIdentity(identity);
    if (identity.account !== allocation.account || identity.workspace_id !== allocation.workspace_id) throw new Error('Private browser scope mismatch.');
    return this.request(allocation, '/control', {
      allocation: Object.fromEntries(['account', 'workspace_id', 'computer_id', 'generation'].map(k => [k, allocation[k]])),
      identity: Object.fromEntries(['account', 'workspace_id', 'task_id', 'root_goal_id', 'request_id'].map(k => [k, identity[k]])),
      command,
    });
  }
  async live_view() { throw new Error('No scoped expiring browser view service is installed.'); }
}
