import { currentToken, launchBrowser, register, log, uniq, PASS, ORIGIN } from "./harness.mjs";

// Multi-device E2E: B signs in on a SECOND device (fresh context = new Signal identity
// + device id). A message A sends afterwards fans out to BOTH of B's devices, and both
// decrypt it. (The 2nd device doesn't get pre-join history — same as Signal.)
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `ma_${u}`,
  B = `mb_${u}`;
const browser = await launchBrowser();
let failed = false;

async function login(page, username) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill("#kc-password", PASS);
  await page.press("#kc-password", "Enter");
}

try {
  // ── A registers + a space ──
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Am");
  await pageA.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Am HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // ── B registers (device 1) + a space ──
  const ctxB1 = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB1 = await ctxB1.newPage();
  pageB1.on("pageerror", (e) => console.error("  B1 ERR:", e.message));
  await register(pageB1, B, "Bm");
  await pageB1.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageB1.fill("#kc-space-name", "Bm HQ");
  await pageB1.click('button:has-text("Let\'s go")');
  await pageB1.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  const bId = await pageB1.evaluate(() => window.__kikkacordUser?.id);
  log(`A + B registered (B on device 1)`);

  // ── A opens an encrypted DM with B and sends the first secret ──
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Find people"]');
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`button[aria-label="Message @${B}"]`, { timeout: 6000 });
  await pageA.click(`button[aria-label="Message @${B}"]`);
  await pageA.waitForSelector('input[placeholder="Say something…"]', { timeout: 8000 });
  await pageA.click('button[aria-label="Turn on end-to-end encryption"]');
  await pageA.waitForSelector("text=/Switched to end-to-end encrypted/", { timeout: 6000 });
  const secret1 = `solo-${u}`;
  let composer = pageA.locator('input[placeholder="Say something…"]');
  await composer.fill(secret1);
  await composer.press("Enter");
  await pageA.waitForSelector(`text=${secret1}`, { timeout: 8000 });

  // ── B device 1 decrypts it ──
  await pageB1.reload({ waitUntil: "domcontentloaded" });
  await pageB1.click('button[aria-label="Direct Messages"]');
  await pageB1.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await pageB1.click('button:has-text("Direct Message")');
  await pageB1.waitForSelector(`text=${secret1}`, { timeout: 10000 });
  log("B device 1 decrypted A's first message ✓");

  // ── B signs in on a SECOND device (fresh context → new identity + device id) ──
  const ctxB2 = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const pageB2 = await ctxB2.newPage();
  pageB2.on("pageerror", (e) => console.error("  B2 ERR:", e.message));
  await login(pageB2, B);
  await pageB2.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
  log("B signed in on device 2");

  // Wait until A can see BOTH of B's device bundles (device 2 published its keys).
  const tokenA = await currentToken(pageA);
  let devices = 0;
  for (let i = 0; i < 16; i++) {
    const bundles = await (
      await fetch(`${API}/users/${bId}/prekey-bundles`, { headers: { Authorization: `Bearer ${tokenA}` } })
    ).json();
    devices = Array.isArray(bundles) ? bundles.length : 0;
    if (devices >= 2) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (devices < 2) throw new Error(`B's 2nd device never published keys (devices=${devices})`);
  log(`B now has ${devices} devices registered in the directory ✓`);

  // B device 2 opens the DM (won't see secret1 — no pre-join history, like Signal).
  await pageB2.click('button[aria-label="Direct Messages"]');
  await pageB2.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await pageB2.click('button:has-text("Direct Message")');

  // ── A sends a SECOND message; fan-out now reaches BOTH of B's devices ──
  const secret2 = `multi-${u}`;
  composer = pageA.locator('input[placeholder="Say something…"]');
  await composer.fill(secret2);
  await composer.press("Enter");
  await pageA.waitForSelector(`text=${secret2}`, { timeout: 8000 });

  const seen = async (page, label) => {
    try {
      await page.waitForSelector(`text=${secret2}`, { timeout: 10000 });
      log(`${label} decrypted secret2 ✓`);
      return true;
    } catch {
      const txt = await page.evaluate(() => document.body.innerText).catch(() => "");
      console.log(`  ${label} did NOT see secret2 — placeholder present: ${txt.includes("Encrypted message")}`);
      return false;
    }
  };
  const b1ok = await seen(pageB1, "B1");
  const b2ok = await seen(pageB2, "B2");
  if (!b1ok || !b2ok) throw new Error(`multi-device decrypt failed (B1=${b1ok}, B2=${b2ok})`);
  log("BOTH of B's devices decrypted the new message (multi-device fan-out) ✓");

  console.log(
    "\n✅ MULTI-DEVICE E2E PASSED (2nd device of the same account receives & decrypts forward-secret messages)"
  );
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
