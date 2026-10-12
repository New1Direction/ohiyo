import { currentToken, launchBrowser, register, log, uniq, PASS, ORIGIN } from "./harness.mjs";

// Two tabs of one browser share one stored session. Changing the password in tab 1 ends
// every other session and stores a new one for tab 1. Tab 2, still on the old one, was
// refused and cleared what was stored, so tab 1 was signed out at its next reload.
//   • Tab 2 carries on with the new session instead of going to sign-in.
//   • Tab 1 stays signed in after a reload.
const u = uniq();
const A = `tabs_${u}`;
const NEW_PASS = "two-tabs-pass-88";
const browser = await launchBrowser();
let failed = false;

const composer = 'input[placeholder*="Say something to #general"]';
const offline = /Reconnecting you now|Connecting…|Signed out|You were signed out on this device/;

try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 820 } });
  const tab1 = await ctx.newPage();
  tab1.on("pageerror", (e) => console.error("  T1 ERR:", e.message));
  await register(tab1, A, "Tabs");
  await tab1.waitForSelector("#kc-space-name", { timeout: 12000 });
  await tab1.fill("#kc-space-name", "Tabs HQ");
  await tab1.click('button:has-text("Let\'s go")');
  await tab1.waitForSelector(composer, { timeout: 12000 });

  const tab2 = await ctx.newPage();
  tab2.on("pageerror", (e) => console.error("  T2 ERR:", e.message));
  await tab2.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await tab2.waitForSelector(composer, { timeout: 15000 });
  const before = await currentToken(tab1);
  log("A is signed in in two tabs");

  // ── Change the password in tab 1 ──
  await tab1.click('button[aria-label="Settings"]');
  await tab1.locator('button:has-text("Account")').first().click();
  await tab1.waitForSelector('form[aria-label="Change password"]', { timeout: 8000 });
  await tab1.fill('input[aria-label="Current password"]', PASS);
  await tab1.fill('input[aria-label="New password"]', NEW_PASS);
  await tab1.fill('input[aria-label="New password again"]', NEW_PASS);
  await tab1.click('form[aria-label="Change password"] button[type="submit"]');
  await tab1.waitForSelector("text=/Password changed/", { timeout: 10000 });
  const fresh = await currentToken(tab1);
  if (!fresh || fresh === before) throw new Error("tab 1 didn't store a new session");
  log("password changed in tab 1");

  // Tab 2's old session ends: it notices, then carries on with the new one.
  await tab2.waitForFunction((re) => new RegExp(re).test(document.body.innerText), offline.source, { timeout: 20000 });
  await tab2.waitForFunction(
    ({ re, sel }) => !new RegExp(re).test(document.body.innerText) && !!document.querySelector(sel),
    { re: offline.source, sel: composer },
    { timeout: 20000 },
  );
  const hello = `tab-two-${u}`;
  await tab2.fill(composer, hello);
  await tab2.press(composer, "Enter");
  await tab2.waitForSelector(`text=${hello}`, { timeout: 10000 });
  if ((await currentToken(tab2)) !== fresh) throw new Error("the stored session isn't tab 1's new one");
  log("tab 2 carried on with the new session and sends ✓");

  // ── Tab 1 is still signed in after a reload ──
  await tab1.reload({ waitUntil: "domcontentloaded" });
  await tab1.waitForSelector(`text=${hello}`, { timeout: 15000 });
  log("tab 1 stays signed in after a reload ✓");

  console.log("\n✅ PASSWORD CHANGE WITH TWO TABS PASSED (both tabs carry on)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
