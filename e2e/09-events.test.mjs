import { launchBrowser, ORIGIN, register, shot, settle, log, uniq, PASS } from "./harness.mjs";

const u = uniq();
const A = `va_${u}`, B = `vb_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Avi");
  await pageA.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Event HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  await pageA.click('button[aria-label="Invite people"]');
  await pageA.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 6000 });
  const link = await pageA.inputValue('input[aria-label="Invite link"]');
  await pageA.keyboard.press("Escape");

  // B joins
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(() => localStorage.clear());
  await pageB.goto(link, { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("text=Create an account", { timeout: 8000 });
  await pageB.click("text=Create an account");
  await pageB.fill('input[autocomplete="username"]', B);
  await pageB.fill('input[autocomplete="nickname"]', "Bex");
  await pageB.fill("#kc-password", PASS);
  await pageB.click('button:has-text("Create my account")');
  await pageB.waitForSelector('button:has-text("Accept invite")', { timeout: 12000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A + B in Event HQ");

  // ── A creates an event ──
  await pageA.click('button[aria-label="Events"]');
  await pageA.waitForSelector("text=📅 Events", { timeout: 5000 });
  await pageA.fill('input[aria-label="Event title"]', "Game night");
  await pageA.fill('input[aria-label="Event time"]', "2026-06-20T20:00");
  await pageA.click('button:has-text("Add event")');
  await pageA.waitForSelector("text=Game night", { timeout: 6000 });
  log("A created an event ✓");
  await shot(pageA, "33-events");

  // ── B opens events, sees it, RSVPs ──
  await pageB.click('button[aria-label="Events"]');
  await pageB.waitForSelector("text=Game night", { timeout: 6000 });
  log("B sees the event ✓");
  await pageB.locator('button:has-text("I\'m in")').first().click();
  await pageB.waitForSelector('button:has-text("✓ Going")', { timeout: 6000 });
  log("B RSVP'd ✓");

  // ── A's open panel updates live via gateway ──
  await pageA.waitForSelector("text=1 person going", { timeout: 8000 });
  log("A's events panel shows '1 person going' LIVE (gateway) ✓");
  await shot(pageA, "34-events-rsvp");

  console.log("\n✅ EVENTS FLOW PASSED (create · live delivery · RSVP · live count)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
