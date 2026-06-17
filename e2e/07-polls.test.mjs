import { launchBrowser, ORIGIN, register, shot, settle, log, uniq, PASS } from "./harness.mjs";

const u = uniq();
const A = `pa_${u}`, B = `pb_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Ann");
  await pageA.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Poll HQ");
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
  await pageB.fill('input[autocomplete="nickname"]', "Bea");
  await pageB.fill("#kc-password", PASS);
  await pageB.click('button:has-text("Create my account")');
  await pageB.waitForSelector('button:has-text("Accept invite")', { timeout: 12000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A + B both in #general");

  // ── A creates a poll ──
  await pageA.click('button[aria-label="Create a poll"]');
  await pageA.waitForSelector("text=New poll", { timeout: 5000 });
  await pageA.fill('input[aria-label="Poll question"]', "Lunch spot?");
  await pageA.fill('input[aria-label="Poll option 1"]', "Pizza");
  await pageA.fill('input[aria-label="Poll option 2"]', "Sushi");
  await pageA.click('button:has-text("Launch poll")');
  // poll appears on both sides
  await pageA.waitForSelector("text=Lunch spot?", { timeout: 8000 });
  await pageB.waitForSelector("text=Lunch spot?", { timeout: 8000 });
  log("poll created + delivered to B live ✓");
  await shot(pageA, "28-poll");

  // ── A votes Pizza ──
  await pageA.locator('button:has-text("Pizza")').first().click();
  await pageA.waitForSelector("text=/✓\\s*Pizza/", { timeout: 6000 });
  log("A voted Pizza ✓");

  // ── B votes Sushi → A sees total 2 live ──
  await pageB.locator('button:has-text("Sushi")').first().click();
  await pageB.waitForSelector("text=/✓\\s*Sushi/", { timeout: 6000 });
  await pageA.waitForSelector("text=2 votes", { timeout: 8000 });
  log("B voted Sushi → A sees 2 votes live ✓");
  await shot(pageA, "29-poll-voted");

  // ── A switches Pizza → Sushi (single-choice) ──
  await pageA.locator('button:has-text("Sushi")').first().click();
  // Pizza should drop back to 0% for A (no longer ✓)
  await pageA.waitForFunction(() => {
    const txt = document.body.innerText;
    return /✓\s*Sushi/.test(txt) && !/✓\s*Pizza/.test(txt);
  }, { timeout: 6000 });
  log("A switched vote (single-choice enforced) ✓");

  console.log("\n✅ POLLS FLOW PASSED (create · live delivery · vote · switch · live counts)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
