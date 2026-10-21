import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

/** Optional fixture demo uses the actual Python service's execute path.
 * npm tests require no Python installation; enable only after browser setup. */
export class PythonBrowserFixture {
  constructor() {
    this.calls = []; this.pending = new Map(); this.sequence = 0;
    this.child = spawn(new URL('../../browser-engine/.venv/bin/python', import.meta.url).pathname,
      [new URL('./python-browser-service.py', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (!line.startsWith('BURROW_FIXTURE ')) return;
      const reply = JSON.parse(line.slice(15));
      this.pending.get(reply.id)?.resolve(JSON.stringify(reply)); this.pending.delete(reply.id);
    });
    const failed = () => { for (const entry of this.pending.values()) entry.reject(new Error('Python fixture transport ended')); this.pending.clear(); };
    this.child.once('error', failed); this.child.once('exit', failed);
  }
  async run(_argv, { input }) {
    if (this.disconnected) throw new Error('Simulated ImOrb transport disconnect');
    const request = JSON.parse(input); const id = this.sequence++;
    if (request.endpoint === '/execute') this.calls.push(request.body);
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(JSON.stringify({ id, ...request }) + '\n');
    return result;
  }
  async close() { const exited = once(this.child, 'exit'); this.child.stdin.end(); await exited; }
}
