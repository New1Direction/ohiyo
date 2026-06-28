#!/usr/bin/env node
/**
 * One-command Discord Server Template → Ohiyo migration.
 *
 * Usage:
 *   OHIYO_TOKEN=<jwt> node scripts/migrate-discord-template.mjs https://discord.new/abc123
 *   E2E_API=https://ohiyo.fly.dev/api/v1 OHIYO_TOKEN=<jwt> scripts/migrate-discord-template.mjs abc123
 *
 * The template API reconstructs channel hierarchy, categories, roles, best-effort
 * server-level permissions, permission-overwrite snapshots, server icon, and custom
 * emoji assets when Discord exposes them in the template payload.
 */

const template = process.argv[2];
if (!template || template === "-h" || template === "--help") {
  console.error(`Usage: OHIYO_TOKEN=<jwt> ${process.argv[1]} <discord-template-url-or-code>\n\nOptional env:\n  E2E_API / OHIYO_API  Ohiyo API base (default: https://ohiyo.fly.dev/api/v1)`);
  process.exit(template ? 0 : 2);
}

const token = process.env.OHIYO_TOKEN || process.env.KIKKA_TOKEN;
if (!token) {
  console.error("Missing OHIYO_TOKEN (use a signed-in owner's JWT; do not paste it into chat).");
  process.exit(2);
}

const api = (process.env.E2E_API || process.env.OHIYO_API || "https://ohiyo.fly.dev/api/v1").replace(/\/$/, "");

const started = Date.now();
const res = await fetch(`${api}/imports/discord/template`, {
  method: "POST",
  headers: {
    "authorization": `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ template }),
});

const text = await res.text();
let body;
try { body = text ? JSON.parse(text) : null; } catch { body = text; }

if (!res.ok) {
  console.error(`Discord template migration failed (${res.status}):`);
  console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  process.exit(1);
}

const report = body.report || {};
const server = body.server || {};
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`Ohiyo migration complete in ${seconds}s`);
console.log(`Server: ${server.name || "(unknown)"} (${server.id || "no-id"})`);
console.log(`Categories: ${report.categories ?? 0}`);
console.log(`Channels: ${report.channels ?? 0}`);
console.log(`Roles needing review: ${(report.roles_needing_review || []).length}`);
console.log(`Permission overwrites preserved: ${report.permission_overwrites ?? 0}`);
console.log(`Emojis imported: ${report.emojis ?? 0}`);
console.log(`Attachments imported: ${report.attachments ?? 0}`);
if (Array.isArray(report.parked) && report.parked.length) {
  console.log("Review notes:");
  for (const note of report.parked) console.log(`- ${note}`);
}
