// Resource-protocol fixture, NOT a real ImOrb. Runs the actual fixed file helper
// under Bun with a temporary resource root; it never starts an agent or Docker.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const home = process.env.ORBD_HOME;
await mkdir(home, { recursive: true });
const registry = join(home, 'registry.json');
const containerFile = join(home, 'containers.json');
let rows;
try { rows = JSON.parse(await readFile(registry, 'utf8')); } catch { rows = []; }
let containers;
try { containers = JSON.parse(await readFile(containerFile, 'utf8')); } catch { containers = []; }
const [host, operation, name, ...args] = process.argv.slice(2);
if (host === 'docker') {
  if (operation === 'ps') {
    const prefix = [name, ...args].find(arg => arg.startsWith('name='))?.slice(5);
    process.stdout.write(containers.filter(n => prefix && `orbd-${n}`.startsWith(prefix)).map(n => `orbd-${n}\n`).join(''));
  } else if (operation === 'rm' && name === '-f') {
    if (existsSync(join(home, 'fail-docker-rm'))) process.exit(1);
    containers = containers.filter(n => `orbd-${n}` !== args[0]);
  } else throw new Error('Unsupported Docker fixture command');
  await writeFile(containerFile, JSON.stringify(containers)); process.exit(0);
}
if (host !== 'host') throw new Error('Expected resource command');
// Match upstream host::validate_name, including its 32-character limit.
if (operation !== 'list' && (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name ?? '') || name.includes('--'))) throw new Error('Invalid ImOrb name');
if (operation === 'list') process.stdout.write(JSON.stringify(rows));
else if (operation === 'create') {
  if (rows.some(r => r.name === name)) throw new Error('Duplicate computer');
  rows.push({ name, repo: args[args.indexOf('--repo') + 1], state: 'Running' });
  containers.push(name);
} else if (operation === 'destroy') {
  if (!existsSync(join(home, 'leave-container'))) containers = containers.filter(n => n !== name);
  rows = rows.filter(r => r.name !== name); await rm(join(home, name), { recursive: true, force: true });
} else if (['start', 'wake'].includes(operation)) {
  rows.find(r => r.name === name).state = 'Running';
} else if (operation === 'exec') {
  if (!rows.some(r => r.name === name && r.state === 'Running')) throw new Error('Computer missing');
  if (args[0] !== 'bun') throw new Error('No shell permitted in fixture');
  const input = await new Promise(resolve => { let data = ''; process.stdin.on('data', c => { data += c; }); process.stdin.on('end', () => resolve(data)); });
  const code = args[2]?.replace("'/orb/state/burrow-computer/files'", JSON.stringify(join(home, name, 'files')));
  const result = spawnSync(process.execPath, args[1] === '--version' ? ['--version'] : ['--eval', code], { input, encoding: 'utf8' });
  if (result.status !== 0) process.exit(1);
  if (existsSync(join(home, 'lose-exec-ack'))) {
    // Test fault: request bytes were received and the actual file helper already
    // committed its effect, but no acknowledgement reaches the caller.
    await writeFile(join(home, 'received-exec.json'), input);
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
  process.stdout.write(result.stdout);
} else throw new Error('No agent or other CLI command allowed');
await writeFile(registry, JSON.stringify(rows));
await writeFile(containerFile, JSON.stringify(containers));
