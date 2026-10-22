// Install this directory at /opt/burrow-browser. No secrets in argv, stdout or models.
import { readFile } from 'node:fs/promises';
let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 64000) process.exit(1); }
try {
  const { endpoint, body } = JSON.parse(input);
  if (!['/status', '/execute', '/cancel', '/control'].includes(endpoint)) throw new Error('Unsupported endpoint');
  const token = (await readFile('/run/burrow-browser/token', 'utf8')).trim();
  if (token.length < 32 || /\s/.test(token)) throw new Error('Invalid service token');
  const response = await fetch(`http://127.0.0.1:8765${endpoint}`, {
    method: endpoint === '/status' ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(endpoint === '/status' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(50000),
  });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 7_000_000) throw new Error('Response too large'); chunks.push(chunk); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify({ ok: response.ok, data }));
} catch { process.exitCode = 1; }
