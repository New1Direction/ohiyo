#!/usr/bin/env node
/**
 * Lightweight Ohiyo load smoke for message send + gateway connection setup.
 * Defaults are intentionally small; raise USERS / MESSAGES_PER_USER for staging.
 */
const API = process.env.E2E_API || "https://ohiyo.fly.dev/api/v1";
const ORIGIN = process.env.KIKKA_ORIGIN || "https://app.ohiyo.gg";
const USERS = Number(process.env.USERS || 5);
const MESSAGES_PER_USER = Number(process.env.MESSAGES_PER_USER || 10);
const uniq = Date.now().toString(36);

async function req(path, opts = {}, token) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

async function main() {
  const t0 = performance.now();
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const username = `load_${uniq}_${i}`;
    const auth = await req("/auth/register", { method: "POST", body: JSON.stringify({ username, password: "supersecret123", display_name: `Load ${i}` }) });
    users.push({ username, ...auth });
  }

  const server = await req("/servers", { method: "POST", body: JSON.stringify({ name: `Load ${uniq}` }) }, users[0].token);
  const channel = server.channels.find((c) => c.channel_type === "text") || server.channels[0];

  let wsOpened = 0;
  const sockets = [];
  if (typeof WebSocket !== "undefined") {
    for (const u of users) {
      try {
        const { ticket } = await req("/ws/ticket", { method: "POST" }, u.token);
        const wsUrl = `${ORIGIN.replace(/^http/, "ws")}/gateway?ticket=${encodeURIComponent(ticket)}`;
        const ws = new WebSocket(wsUrl);
        sockets.push(ws);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
          ws.addEventListener("open", () => { clearTimeout(timer); wsOpened += 1; resolve(); }, { once: true });
          ws.addEventListener("error", reject, { once: true });
        });
      } catch (e) {
        console.warn("gateway open failed:", e.message);
      }
    }
  } else {
    console.warn("global WebSocket unavailable in this Node; message load only");
  }

  const sends = [];
  for (const u of users) {
    for (let i = 0; i < MESSAGES_PER_USER; i++) {
      sends.push(req(`/channels/${channel.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: `load ${uniq} ${u.username} ${i}`, attachment_ids: [] }),
      }, u.token));
    }
  }
  const before = performance.now();
  await Promise.all(sends);
  const after = performance.now();
  for (const ws of sockets) try { ws.close(); } catch {}

  const total = USERS * MESSAGES_PER_USER;
  console.log(JSON.stringify({
    api: API,
    users: USERS,
    gateway_connections_opened: wsOpened,
    messages_sent: total,
    message_send_seconds: Number(((after - before) / 1000).toFixed(3)),
    messages_per_second: Number((total / ((after - before) / 1000)).toFixed(2)),
    total_seconds: Number(((after - t0) / 1000).toFixed(3)),
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
