import { launchBrowser, ORIGIN, register, shot, settle, log, uniq, PASS } from "./harness.mjs";

// Read receipts: A DMs B. Before B reads, A's message shows "Delivered".
// When B opens the DM (acks), A's indicator flips to "Seen" live over the gateway.
const u = uniq();
const A = `ra_${u}`, B = `rb_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  // ── A: register + clear onboarding ──
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Ann");
  await pageA.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Ann HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // ── B: register + clear onboarding (so B is searchable + has a session) ──
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await register(pageB, B, "Bea");
  await pageB.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageB.fill("#kc-space-name", "Bea HQ");
  await pageB.click('button:has-text("Let\'s go")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A + B both registered");

  // ── A opens a DM with B via Find People ──
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Find people"]');
  await pageA.waitForSelector('input[aria-label="Search people"]', { timeout: 6000 });
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`button:has-text("@${B}")`, { timeout: 6000 });
  await pageA.click(`button:has-text("@${B}")`);
  await pageA.waitForSelector('input[placeholder="Say something…"]', { timeout: 8000 });
  log("A opened DM with B");

  // ── A sends a message → "Delivered" (B hasn't read) ──
  const msg = `seen-check-${u}`;
  const composer = pageA.locator('input[placeholder="Say something…"]');
  await composer.fill(msg);
  await composer.press("Enter");
  await pageA.waitForSelector(`text=${msg}`, { timeout: 8000 });
  await pageA.waitForFunction(
    () => document.querySelector(".kc-receipt")?.textContent?.trim() === "Delivered",
    { timeout: 8000 }
  );
  log('A sees "Delivered" before B reads ✓');
  await shot(pageA, "33-receipt-delivered");

  // ── B reloads (Ready now includes the DM), opens it → reads ──
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await pageB.click('button[aria-label="Direct Messages"]');
  // B's DM label falls back to "Direct Message" (no dmUsers hydration on this path).
  await pageB.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await pageB.click('button:has-text("Direct Message")');
  await pageB.waitForSelector(`text=${msg}`, { timeout: 8000 });
  log("B opened the DM and read A's message");

  // ── A's indicator flips to "Seen" live ──
  await pageA.waitForFunction(
    () => document.querySelector(".kc-receipt")?.textContent?.trim() === "Seen",
    { timeout: 10000 }
  );
  log('A sees "Seen" after B reads (live) ✓');
  await shot(pageA, "34-receipt-seen");

  console.log("\n✅ READ RECEIPTS FLOW PASSED (DM delivery · Delivered → Seen live)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
