import { launchBrowser, register, shot, log, uniq } from "./harness.mjs";

// End-to-end encrypted DMs: A toggles encryption, sends a secret. B decrypts it.
// CRITICAL: the server must store only ciphertext — verified via the REST API.
const API = "http://localhost:3000/api/v1";
const u = uniq();
const A = `ea_${u}`,
  B = `eb_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  // ── A registers (publishes its E2E public key on login) ──
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Ann");
  await pageA.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Ann HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // ── B registers (also publishes its key, and is searchable) ──
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await register(pageB, B, "Bea");
  await pageB.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageB.fill("#kc-space-name", "Bea HQ");
  await pageB.click('button:has-text("Let\'s go")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A + B registered (E2E keys auto-published — no key handling)");

  // ── A opens a DM with B ──
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Find people"]');
  await pageA.waitForSelector('input[aria-label="Search people"]', { timeout: 6000 });
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`button:has-text("@${B}")`, { timeout: 6000 });
  await pageA.click(`button:has-text("@${B}")`);
  await pageA.waitForSelector('input[placeholder="Say something…"]', { timeout: 8000 });
  log("A opened DM with B");

  // ── A clicks the lock → end-to-end encrypted mode (banner + darker chat) ──
  await pageA.click('button[aria-label="Turn on end-to-end encryption"]');
  await pageA.waitForSelector("text=/Switched to end-to-end encrypted/", { timeout: 6000 });
  await pageA.waitForSelector(".kc-e2e", { timeout: 4000 }); // chat shifted darker
  log("A clicked the lock → encrypted mode, banner + darker chat ✓");
  await shot(pageA, "35-e2e-on");

  // ── A sends a secret message (sees plaintext locally) ──
  const secret = `top-secret-${u}`;
  const composer = pageA.locator('input[placeholder="Say something…"]');
  await composer.fill(secret);
  await composer.press("Enter");
  await pageA.waitForSelector(`text=${secret}`, { timeout: 8000 });
  log("A sent an encrypted message");

  // ── B reloads, opens the DM, sees the DECRYPTED plaintext ──
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await pageB.click('button[aria-label="Direct Messages"]');
  await pageB.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await pageB.click('button:has-text("Direct Message")');
  await pageB.waitForSelector(`text=${secret}`, { timeout: 10000 });
  log("B opened the DM and DECRYPTED A's message ✓");
  await shot(pageB, "36-e2e-decrypted");

  // ── PROOF: the server stored only CIPHERTEXT (it cannot read the message) ──
  const tokenA = await pageA.evaluate(() => localStorage.getItem("token"));
  const dms = await (
    await fetch(`${API}/users/@me/dms`, { headers: { Authorization: `Bearer ${tokenA}` } })
  ).json();
  const dmId = dms[0]?.id;
  if (!dmId) throw new Error("no DM channel found via API");
  const msgs = await (
    await fetch(`${API}/channels/${dmId}/messages`, { headers: { Authorization: `Bearer ${tokenA}` } })
  ).json();
  const stored = msgs[msgs.length - 1]?.content ?? "";
  if (stored.includes(secret)) throw new Error(`server stored PLAINTEXT! content="${stored}"`);
  if (!/^v1\./.test(stored)) throw new Error(`server content is not our ciphertext envelope: "${stored}"`);
  log(`server stores ciphertext only: "${stored.slice(0, 30)}…" (NOT the plaintext) ✓`);

  console.log(
    "\n✅ E2E DM FLOW PASSED (one-click toggle → encrypt → peer decrypts; server sees only ciphertext)"
  );
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
