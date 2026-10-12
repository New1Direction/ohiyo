import { currentToken, launchBrowser, register, log, uniq, PASS, ORIGIN } from "./harness.mjs";

// Delete account, from Settings → Account:
//   • A wrong password deletes nothing, and says so.
//   • With the password and the username typed out, the account goes at once: this
//     device lands on sign-in saying so, the old token is dead, and signing in fails.
//   • Every message A sent is gone; B's stay. A's space now belongs to B.
//   • A's encryption keys are gone from this device.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `da_${u}`,
  B = `db_${u}`;
const browser = await launchBrowser();
let failed = false;

async function api(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

async function fillDelete(page, password, username) {
  await page.fill('form[aria-label="Delete account"] input[aria-label="Password"]', password);
  await page.fill('input[aria-label="Type your username to confirm"]', username);
  await page.click('form[aria-label="Delete account"] button[type="submit"]');
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Da", "Da HQ");
  const tokenA = await currentToken(pageA);
  const aId = await pageA.evaluate(() => window.__kikkacordUser?.id);

  const ctxB = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const pageB = await ctxB.newPage();
  await onboard(pageB, B, "Db", "Db HQ");
  const tokenB = await currentToken(pageB);
  const bId = await pageB.evaluate(() => window.__kikkacordUser?.id);

  // B joins A's space; both talk in #general.
  const space = (await api(tokenA, "/servers")).body.find((s) => s.name === "Da HQ");
  const general = space.channels.find((c) => c.name === "general").id;
  const invite = await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" });
  if ((await api(tokenB, `/invites/${invite.body.code}`, { method: "POST", body: "{}" })).status !== 200) throw new Error("B couldn't join");
  const say = (token, content) => api(token, `/channels/${general}/messages`, { method: "POST", body: JSON.stringify({ content }) });
  await say(tokenA, `from-a-${u}`);
  await say(tokenB, `from-b-${u}`);
  const hadKeys = await pageA.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("kc:sig:")));
  if (!hadKeys) throw new Error("A had no encryption keys to begin with");
  log("A owns a space B is in; both have talked");

  // ── A wrong password deletes nothing ──
  await pageA.click('button[aria-label="Settings"]');
  await pageA.locator('button:has-text("Account")').first().click();
  await pageA.click('button:has-text("Delete account…")');
  await pageA.waitForSelector("text=Every message you sent is deleted, for everyone.", { timeout: 6000 });
  await fillDelete(pageA, "not-my-password", A);
  await pageA.waitForSelector("text=/That isn't your password\\. Nothing was deleted\\./", { timeout: 8000 });
  if ((await api(tokenA, "/users/@me")).status !== 200) throw new Error("a wrong password ended A's session");
  log("a wrong password is refused and nothing is deleted ✓");

  // ── The real thing ──
  await fillDelete(pageA, PASS, A);
  await pageA.waitForSelector("text=/Your account was deleted/", { timeout: 12000 });
  log("A lands on sign-in: \"Your account was deleted.\" ✓");

  if ((await api(tokenA, "/users/@me")).status !== 401) throw new Error("A's token still works");
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: A, password: PASS }),
  });
  if (login.status !== 401) throw new Error("A can still sign in");
  log("A's session is dead and A can't sign in ✓");

  const messages = (await api(tokenB, `/channels/${general}/messages?limit=50`)).body ?? [];
  const texts = messages.map((m) => m.content);
  if (texts.includes(`from-a-${u}`)) throw new Error("A's message is still there");
  if (!texts.includes(`from-b-${u}`)) throw new Error("B's message went too");
  if (messages.some((m) => m.author?.id === aId)) throw new Error("something A sent is still there");
  log("everything A sent is gone; B's message stays ✓");

  const after = (await api(tokenB, "/servers")).body.find((s) => s.id === space.id);
  if (!after) throw new Error("A's space was deleted although B is in it");
  if (after.owner_id !== bId) throw new Error(`A's space went to ${after.owner_id}, not B`);
  log("A's space now belongs to B ✓");

  const leftKeys = await pageA.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("kc:sig:") || k.startsWith("kc:sk:") || k === "kc:e2e-keypair")
  );
  if (leftKeys.length > 0) throw new Error(`A's keys are still on the device: ${leftKeys.slice(0, 3).join(", ")}`);
  log("A's encryption keys are gone from this device ✓");

  console.log("\n✅ DELETE ACCOUNT E2E PASSED (gone at once; messages deleted; the space handed to B; keys cleared)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
