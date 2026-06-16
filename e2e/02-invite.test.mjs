import { launchBrowser, ORIGIN, SHOTS } from "./harness.mjs";
const URL = ORIGIN;

const uniq = Date.now().toString(36).slice(-6);
const A = `inviter_${uniq}`;
const B = `joiner_${uniq}`;
const PASS = "supersecret123";
const log = (...a) => console.log("•", ...a);
const settle = (p, ms = 350) => p.waitForTimeout(ms);

async function shot(page, name) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  await settle(page, 200);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function register(page, username) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Create an account", { timeout: 10000 });
  await page.click("text=Create an account");
  await page.waitForSelector("text=Join Ohiyo");
  await page.fill('input[autocomplete="username"]', username);
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Create my account")');
}

const browser = await launchBrowser();
let failed = false;
try {
  // ── User A: register → create server → open invite link ──────────
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => { console.error("  A PAGEERROR:", e.message); });
  await register(pageA, A);
  await pageA.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Test HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A: created Test HQ, in #general");

  await pageA.click('button[aria-label="Invite people"]');
  await pageA.waitForSelector("text=Invite people", { timeout: 5000 });
  await pageA.waitForSelector('input[aria-label="Invite link"]', { timeout: 6000 });
  // wait until the link is populated (not empty)
  await pageA.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 6000 });
  const inviteLink = await pageA.inputValue('input[aria-label="Invite link"]');
  log("A: invite link =", inviteLink);
  await shot(pageA, "11-invite-modal");
  if (!inviteLink.includes("?invite=")) throw new Error("invite link malformed");

  // copy button feedback
  await pageA.click('button:has-text("Copy")').catch(() => {});
  await pageA.keyboard.press("Escape");

  // ── User B: open invite link → register → accept → join ──────────
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => { console.error("  B PAGEERROR:", e.message); });
  await pageB.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(() => localStorage.clear());
  // navigate to the actual invite URL
  await pageB.goto(inviteLink, { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector('input[autocomplete="username"]', { timeout: 8000 });
  log("B: invite link routed to auth (logged out)");
  await pageB.click("text=Create an account");
  await pageB.fill('input[autocomplete="username"]', B);
  await pageB.fill("#kc-password", PASS);
  await pageB.click('button:has-text("Create my account")');

  // After registering, the invite-accept screen should appear (code persisted in URL)
  await pageB.waitForSelector("text=You're invited to", { timeout: 12000 });
  await pageB.waitForSelector("text=Test HQ", { timeout: 5000 });
  log("B: invite-accept screen shows Test HQ ✓");
  await shot(pageB, "12-invite-accept");

  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  // confirm the server name is visible (joined Test HQ)
  await pageB.waitForSelector("text=Test HQ", { timeout: 6000 });
  log("B: JOINED Test HQ and landed in #general ✓");
  // URL should be cleaned of the invite param
  const urlB = pageB.url();
  if (urlB.includes("invite=")) throw new Error("invite param not cleared after join");
  log("B: invite param cleared from URL ✓");
  await shot(pageB, "13-joined-server");

  // B sends a message; A should receive it live (shared membership)
  const composerB = pageB.locator('input[placeholder*="Say something"]');
  await composerB.fill(`hi from ${B}!`);
  await composerB.press("Enter");
  await pageB.waitForSelector(`text=hi from ${B}!`, { timeout: 8000 });
  await pageA.waitForSelector(`text=hi from ${B}!`, { timeout: 8000 });
  log("A received B's message live (shared server membership) ✓");

  // ── Find people → DM (A searches for B) ──────────────────────────
  await pageA.click('[title="Direct Messages"]');
  await pageA.waitForSelector('button[aria-label="Find people"]', { timeout: 5000 });
  await pageA.click('button[aria-label="Find people"]');
  await pageA.waitForSelector('input[aria-label="Search people"]', { timeout: 5000 });
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`text=@${B}`, { timeout: 6000 });
  log("A: search found B ✓");
  await shot(pageA, "14-find-people");
  await pageA.click(`button:has-text("@${B}")`);
  // DM opens → composer visible, find-people modal closed
  await pageA.waitForSelector('input[placeholder*="Say something"]', { state: "visible", timeout: 8000 });
  await pageA.waitForSelector('input[aria-label="Search people"]', { state: "detached", timeout: 5000 });
  log("A: opened a DM with B ✓");
  await shot(pageA, "15-dm-open");

  console.log("\n✅ INVITE + FIND-PEOPLE FLOW PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
