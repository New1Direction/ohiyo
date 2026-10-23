import { readFileSync } from 'node:fs';
import { COMPUTER_CONTRACT_VERSION, ComputerNotDispatched } from './computer-contract.mjs';

const helper = readFileSync(new URL('./imorb-shell.mjs', import.meta.url), 'utf8');

/** Optional engine on the existing isolated computer, with no model loop or host shell. */
export class CodingEngine {
  constructor({ transport }) { this.transport = transport; }
  async status(allocation) {
    const result = JSON.parse(await this.transport.run(['exec', allocation.computer_id, 'bun', '-e', helper],
      { input: JSON.stringify({ probe: true }) }));
    if (result.ready !== true) throw new Error('Coding tools unavailable');
    return { state: 'ready', capabilities: { contract_version: COMPUTER_CONTRACT_VERSION,
      features: ['shell'], persistence: { workspace: false, profile: false }, limitations: [
        'Commands run inside the disposable computer, with a 45-second deadline and 64 KiB combined output limit.',
        'Shell access authorizes the whole container. No model/provider credentials are forwarded.',
        'Transport interruption cannot prove remote cancellation; uncertain commands are never automatically replayed.',
        'Background services, interactive terminals and replacement persistence are not supported.',
      ] } };
  }
  async execute(allocation, identity, action, { signal }) {
    if (action.operation !== 'shell' || signal?.aborted) throw new ComputerNotDispatched();
    const raw = await this.transport.run(['exec', allocation.computer_id, 'bun', '-e', helper],
      { input: JSON.stringify({ identity, action }), signal, timeoutMs: 55000 });
    const result = JSON.parse(raw);
    if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || !(result.exit_code === null || Number.isInteger(result.exit_code))
      || typeof result.timed_out !== 'boolean' || typeof result.truncated !== 'boolean'
      || typeof result.spawn_error !== 'boolean') throw new Error('Command acknowledgement invalid');
    // Nonzero exit is an acknowledged command result, not transport uncertainty.
    return result;
  }
}
