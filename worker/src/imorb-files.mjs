// Executed as a fixed Bun program INSIDE an ImOrb. stdin holds the canonical
// identity/action envelope; no model-supplied code, shell interpolation or host paths.
import { mkdir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const { action, identity } = JSON.parse(await Bun.stdin.text());
for (const k of ['account', 'workspace_id', 'task_id', 'root_goal_id', 'request_id']) if (!identity[k]) throw new Error('Missing computer identity');
const parts = action.args.path.split('/');
if (!parts.length || parts.some(p => !p || p === '.' || p === '..') || action.args.path.startsWith('/')) throw new Error('Invalid workspace path');
const root = '/orb/state/burrow-computer/files';
await mkdir(root, { recursive: true, mode: 0o700 });
if (await realpath(root) !== root) throw new Error('Workspace root is not a real directory');
let parent = root;
for (const part of parts.slice(0, -1)) {
  parent = join(parent, part);
  if (action.operation !== 'files.read') await mkdir(parent, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Symlink traversal is not supported');
}
const path = join(parent, parts.at(-1));
let output;
if (action.operation === 'files.ensure_directory') {
  await mkdir(path, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Existing path is not a directory');
  output = { path: action.args.path, invariant: 'mkdir_exists_v1' };
} else if (action.operation === 'files.read' || action.operation === 'files.write') {
  if (action.operation === 'files.write' && (typeof action.args.content !== 'string' || Buffer.byteLength(action.args.content) > 65536)) throw new Error('Text file too large');
  const flags = action.operation === 'files.read' ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT;
  const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Expected a regular file');
    if (action.operation === 'files.write') {
      await file.truncate(0);
      await file.writeFile(action.args.content); await file.sync();
      output = { path: action.args.path, sha256: createHash('sha256').update(action.args.content).digest('hex') };
    } else {
      if ((await file.stat()).size > 65536) throw new Error('Text file too large');
      const buffer = Buffer.alloc(65537); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw new Error('Text file too large');
      const bytes = buffer.subarray(0, bytesRead);
      output = { path: action.args.path, text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  } finally { await file.close(); }
} else throw new Error('Unsupported file operation');
process.stdout.write(JSON.stringify({ ...output, identity }));
