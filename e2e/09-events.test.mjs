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
  await pageA.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Event HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
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
  await pageB.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A + B in Event HQ");

  // ── A creates an event for tomorrow evening (and is down as Going) ──
  await pageA.click('.channel-sidebar button[aria-haspopup="menu"]');
  await pageA.click('.channel-sidebar [role="menuitem"]:has-text("Events")');
  await pageA.waitForSelector("text=📅 Events", { timeout: 5000 });
  await pageA.click('button:has-text("New event")');
  await pageA.fill('input[aria-label="Event title"]', "Game night");
  const tomorrow = await pageA.evaluate(() => {
    const d = new Date(Date.now() + 86_400_000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T20:00`;
  });
  await pageA.fill('input[aria-label="Starts"]', tomorrow);
  await pageA.click('button:has-text("Create event")');
  await pageA.waitForSelector('article[aria-label="Game night"]', { timeout: 6000 });
  log("A created an event ✓");
  await shot(pageA, "33-events");

  // ── B opens events, finds it in the agenda, says Interested ──
  await pageB.click('.channel-sidebar button[aria-haspopup="menu"]');
  await pageB.click('.channel-sidebar [role="menuitem"]:has-text("Events")');
  await pageB.click('button[aria-pressed]:has-text("Agenda")');
  await pageB.click('section button:has-text("Game night")');
  log("B sees the event ✓");
  const answers = 'article[aria-label="Game night"] [role="group"][aria-label="Your answer"]';
  await pageB.click(`${answers} button:has-text("Interested")`);
  await pageB.waitForSelector(`${answers} button[aria-pressed="true"]:has-text("Interested")`, { timeout: 6000 });
  log("B said Interested ✓");

  // ── A's open card updates live via the gateway ──
  await pageA.waitForSelector(`${answers} button:has-text("Interested"):has-text("1")`, { timeout: 8000 });
  log("A's card shows 1 interested LIVE (gateway) ✓");
  await shot(pageA, "34-events-rsvp");

  console.log("\n✅ EVENTS FLOW PASSED (create · live delivery · Interested · live count)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
