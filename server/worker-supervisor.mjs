import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit allowlist, not a filtered copy of the API environment. In particular
// NODE_OPTIONS, JWT, object-store and model-provider credentials never cross it.
export function workerEnvironment(env) {
  if (env.KIKKA_RUNTIME !== 'pi' || env.KIKKA_MODEL_ROUTING !== '1'
    || !env.KIKKA_USER_ID?.trim() || !env.KIKKA_WORKER_TOKEN || env.KIKKA_WORKER_TOKEN.length < 32
    || !isAbsolute(env.KIKKA_WORKER_CONFIG ?? '') || !isAbsolute(env.KIKKA_ROUTING_CONFIG ?? '')) {
    throw new Error('Embedded worker requires Pi, routed model access, a private token and explicit configuration paths.');
  }
  const port = env.KIKKA_WORKER_PORT ?? '3102';
  const apiPort = (env.BIND_ADDR ?? '0.0.0.0:3000').split(':').at(-1);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535
    || !/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65535
    || Number(port) === Number(apiPort)
    || env.KIKKA_WORKER_URL !== `http://127.0.0.1:${port}/command`
    || env.KIKKA_ROUTING_ACCESS_URL !== `http://127.0.0.1:${apiPort}/api/v1/burrow/internal/model-access`
    || (env.KIKKA_WORKER_DIRECTORY && env.KIKKA_WORKER_DIRECTORY !== '/data/kikka')) {
    throw new Error('Embedded worker requires private loopback endpoints and /data/kikka persistence.');
  }
  const config = JSON.parse(readFileSync(env.KIKKA_WORKER_CONFIG, 'utf8'));
  if (config.computer || env.KIKKA_TRAVEL_URL) throw new Error('Embedded school worker does not enable computer, coding or travel.');
  return {
    KIKKA_WORKER_CONFIG: env.KIKKA_WORKER_CONFIG,
    KIKKA_WORKER_DIRECTORY: '/data/kikka',
    KIKKA_WORKER_TOKEN: env.KIKKA_WORKER_TOKEN,
    KIKKA_WORKER_PORT: port,
    KIKKA_MODEL_ROUTING: '1',
    KIKKA_ROUTING_ACCESS_URL: env.KIKKA_ROUTING_ACCESS_URL,
  };
}

// Both children have their own process groups, including Litestream's API child.
// A peer exit (even exit 0) is fatal; never restart work with an uncertain outcome.
// tini is the outer subreaper for descendants orphaned during group shutdown.
export function supervise({ workerCommand, apiCommand, workerEnv, apiEnv, shutdownMs = 5000 }) {
  return new Promise(resolveExit => {
    const children = [];
    let stopping = false, remaining = 0, exitCode = 1, timer;
    const signalGroup = (child, signal) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const finish = () => {
      clearTimeout(timer);
      // A wrapper may have exited before its descendants. Do not leave them alive.
      for (const child of children) signalGroup(child, 'SIGKILL');
      process.removeListener('SIGTERM', term);
      process.removeListener('SIGINT', interrupt);
      resolveExit(exitCode);
    };
    const stop = code => {
      if (stopping) return;
      stopping = true; exitCode = code;
      for (const child of children) signalGroup(child, 'SIGTERM');
      timer = setTimeout(() => {
        for (const child of children) signalGroup(child, 'SIGKILL');
      }, shutdownMs);
    };
    const term = () => stop(143), interrupt = () => stop(130);
    process.on('SIGTERM', term);
    process.on('SIGINT', interrupt);
    for (const [command, env] of [[workerCommand, workerEnv], [apiCommand, apiEnv]]) {
      const child = spawn(command[0], command.slice(1), { env, detached: true, stdio: 'inherit' });
      children.push(child); remaining++;
      child.once('error', () => stop(1));
      child.once('close', () => {
        stop(1);
        if (--remaining === 0) finish();
      });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const workerEnv = workerEnvironment(process.env);
    process.exitCode = await supervise({
      workerCommand: [process.execPath, '/opt/ohiyo-worker/src/server.mjs'],
      apiCommand: ['sh', resolve(dirname(fileURLToPath(import.meta.url)), 'docker-entrypoint.sh')],
      workerEnv,
      apiEnv: { ...process.env, KIKKA_EMBEDDED_WORKER: '0' },
    });
  } catch {
    console.error('Embedded worker startup failed; verify private configuration. No automatic retry was attempted.');
    process.exitCode = 1;
  }
}
