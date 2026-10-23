// Fixed helper executed INSIDE the disposable computer, never on the worker host.
// A shell grant authorizes the whole container, not a filesystem jail inside it.
import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';

const input = JSON.parse(await Bun.stdin.text());
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/burrow-code-home',
  LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
if (input.probe === true) {
  const result = Bun.spawnSync(['git', '--version'], { env });
  if (result.exitCode !== 0) throw new Error('Git is not installed');
  process.stdout.write(JSON.stringify({ ready: true }));
} else {
  const { action, identity } = input;
  if (!identity || ['account', 'workspace_id', 'task_id', 'root_goal_id', 'request_id'].some(k => !identity[k])) throw new Error('Missing identity');
  const argv = action?.args?.argv;
  if (action?.operation !== 'shell' || !Array.isArray(argv) || !argv.length || argv.length > 32
    || argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new Error('Invalid command');
  const root = '/orb/state/burrow-computer/files';
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new Error('Workspace root is not a real directory');
  env.HOME = `${root}/../home`;
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  const result = await new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let bytes = 0, truncated = false, timedOut = false, spawnError = false, escalation;
    const collect = chunks => chunk => {
      const keep = Math.max(0, Math.min(chunk.length, 65536 - bytes));
      if (keep) chunks.push(chunk.subarray(0, keep));
      bytes += keep;
      if (keep < chunk.length) truncated = true;
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    const killGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Already exited. */ } } };
    // Less than the transport/provider deadline, so a normal timeout can be acknowledged.
    const deadline = setTimeout(() => {
      timedOut = true; killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), 500);
    }, 45000);
    child.on('error', () => { spawnError = true; });
    // Descendants can retain the pipes after the command exits, preventing close.
    child.on('exit', () => killGroup('SIGKILL'));
    child.on('close', (exit_code, signal) => {
      clearTimeout(deadline); clearTimeout(escalation);
      // Commands may not leave background jobs running after their receipt.
      killGroup('SIGKILL');
      resolve({ argv, exit_code, signal, timed_out: timedOut, spawn_error: spawnError,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        truncated, cwd: root });
    });
  });
  process.stdout.write(JSON.stringify(result));
}
