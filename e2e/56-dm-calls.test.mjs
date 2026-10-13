import { launchBrowser, register, shot, log, uniq, openDm, settle } from "./harness.mjs";

// Calls in DMs, like Discord: A calls B from the DM's header, B's screen rings with
// Accept / Decline, B accepts and both are in the call. A hangs up, which ends a one-to-one
// call for both, and the chat says "Call ended · …". Then A calls again and hangs up before
// B answers: B's ring stops and the chat says "Missed call from Ann".
const u = uniq();
const A = `dca_${u}`;
const B = `dcb_${u}`;

async function signUpWithSpace(page, username, displayName, spaceName) {
  await register(page, username, displayName);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", spaceName);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
}

const browser = await launchBrowser({ fakeMedia: true });
let failed = false;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone", "camera"] });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone", "camera"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));

  await signUpWithSpace(pageA, A, "Ann", "Ann HQ");
  await signUpWithSpace(pageB, B, "Bea", "Bea HQ");

  // A opens a DM with B and says hi, so the chat shows up for B too.
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Find people"]');
  await pageA.waitForSelector('input[aria-label="Search people"]', { timeout: 6000 });
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`button[aria-label="Message @${B}"]`, { timeout: 6000 });
  await pageA.click(`button[aria-label="Message @${B}"]`);
  const composerA = pageA.locator('textarea[placeholder="Say something…"]');
  await composerA.waitFor({ timeout: 8000 });
  await composerA.fill("hi Bea");
  await composerA.press("Enter");
  await pageA.waitForSelector("text=hi Bea", { timeout: 8000 });
  await pageB.click('button[aria-label="Direct Messages"]');
  await openDm(pageB, "Ann", 12000);
  await pageB.waitForSelector("text=hi Bea", { timeout: 10000 });
  log("A and B have a DM open");

  // ── A calls; B's screen rings ──
  await pageA.click('button[aria-label="Start a voice call"]');
  await pageA.waitForSelector("text=Ringing…", { timeout: 12000 });
  const card = pageB.locator('[role="dialog"][aria-label^="Incoming call"]');
  await card.waitFor({ state: "visible", timeout: 12000 });
  await pageB.waitForSelector("text=Ann is calling", { timeout: 8000 });
  log("A sees Ringing…, and B's screen rings with who is calling ✓");
  await shot(pageB, "56-dm-calls-incoming-dark");

  // ── B accepts; both are in the call ──
  await pageB.click('button[aria-label="Accept"]');
  await card.waitFor({ state: "detached", timeout: 10000 });
  await pageA.waitForSelector("text=Ringing…", { state: "detached", timeout: 15000 });
  await pageA.locator(".kc-call-live-pill").waitFor({ state: "visible", timeout: 12000 });
  await pageB.locator(".kc-call-live-pill").waitFor({ state: "visible", timeout: 12000 });
  await pageA.waitForSelector("text=Bea", { timeout: 10000 });
  log("B accepted: the ring stopped and both are in the call ✓");
  await shot(pageA, "56-dm-calls-in-call-dark");

  // ── A hangs up: a one-to-one call ends for both, and the chat logs it ──
  await pageA.click('button[aria-label="Leave call"]');
  await pageA.locator(".kc-call-live-pill").waitFor({ state: "detached", timeout: 10000 });
  await pageB.locator(".kc-call-live-pill").waitFor({ state: "detached", timeout: 15000 });
  await pageA.waitForSelector("text=/Call ended · /", { timeout: 12000 });
  await pageB.waitForSelector("text=/Call ended · /", { timeout: 12000 });
  log("A hung up: the call ended for both, and both chats say Call ended ✓");
  await settle(pageB, 300);
  await shot(pageB, "56-dm-calls-log-dark");

  // ── A calls again and hangs up before B answers: a missed call ──
  await pageA.click('button[aria-label="Start a voice call"]');
  await card.waitFor({ state: "visible", timeout: 12000 });
  await pageB.setViewportSize({ width: 390, height: 844 });
  await settle(pageB, 400);
  await shot(pageB, "56-dm-calls-incoming-phone");
  await pageB.setViewportSize({ width: 1280, height: 860 });
  await pageA.click('button[aria-label="Leave call"]');
  await card.waitFor({ state: "detached", timeout: 12000 });
  await pageB.waitForSelector("text=Missed call from Ann", { timeout: 12000 });
  await pageA.waitForSelector("text=No answer", { timeout: 12000 });
  log("A hung up first: B's ring stopped, B sees Missed call from Ann and A sees No answer ✓");

  await pageB.locator('button[aria-label="Settings"]').first().click();
  await pageB.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await pageB.click('button[aria-label="Use theme: Ohiyo Light"]');
  await pageB.keyboard.press("Escape");
  await settle(pageB, 300);
  await shot(pageB, "56-dm-calls-log-light");

  console.log("\n✅ DM CALLS PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ DM CALLS FAILED:", err?.message ?? err);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
