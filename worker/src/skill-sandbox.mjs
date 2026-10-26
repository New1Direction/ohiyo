import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

// Fixed validator, NOT model-supplied code. Guidance never runs as JavaScript.
// An empty environment and Node's deny-by-default permissions prevent IO or tools.
const validator = `
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
let input = ''; for await (const part of process.stdin) input += part;
const s = JSON.parse(input);
const bounded = (v,n) => typeof v==='string' && v.trim().length>0 && Buffer.byteLength(v)<=n;
if (Object.keys(s).sort().join(',')!=='description,instructions,name' || !bounded(s.name,80)
  || !bounded(s.description,500) || !bounded(s.instructions,6000)) process.exit(1);
// Prove the sandbox denies the capabilities the candidate cannot acquire.
for (const action of [()=>readFileSync('/etc/passwd'), ()=>spawnSync(process.execPath,['-e',''])]) {
  try { action(); process.exit(1); } catch(e) { if(e.code!=='ERR_ACCESS_DENIED') process.exit(1); }
}
await new Promise((resolve,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port:9});
  socket.once('connect',()=>{socket.destroy();reject(new Error('Network allowed'));});
  socket.once('error',e=>e.code==='ERR_ACCESS_DENIED'?resolve():reject(e));
});
process.stdout.write(JSON.stringify({passed:true,scope:'structural-only',installed:false}));
`;

export async function testSkill(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 8000) throw new Error('Invalid skill candidate.');
  // Older Node permissions do not deny networking. Never silently weaken isolation.
  if (Number(process.versions.node.split('.')[0]) < 26) throw new Error('Sandbox checks require Node 26 or newer.');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--permission', '--max-old-space-size=32', '--input-type=module', '-e', validator],
      { cwd: tmpdir(), env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 3000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024) { exceeded = true; child.kill('SIGKILL'); } });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Sandbox unavailable.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) return reject(new Error('Sandbox checks failed.'));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid sandbox acknowledgement.')); }
    });
    child.stdin.end(content);
  });
}
