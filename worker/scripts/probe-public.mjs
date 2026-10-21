// Free browser capability probe, NOT a model/agent acceptance run.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readPublicPage } from '../src/browser.mjs';

const config = JSON.parse(await readFile(new URL('../research.example.json', import.meta.url), 'utf8'));
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const rows = [];
for (const url of config.approvedUrls) {
  const attemptedAt = new Date().toISOString();
  try {
    const result = await readPublicPage({ url, approvedUrls: config.approvedUrls,
      evidenceDirectory: join(output, new URL(url).pathname.split('/')[1]) });
    rows.push({ status: 'captured', attemptedAt, ...result });
  } catch (error) { rows.push({ status: 'unverifiable', url, attemptedAt, reason: error.message }); }
  console.log(JSON.stringify({ url, status: rows.at(-1).status, reason: rows.at(-1).reason }));
}
await writeFile(join(output, 'probe.json'), JSON.stringify({ kind: 'free browser-only probe; no model run',
  geographicEgressVerified: false, rows }, null, 2));
