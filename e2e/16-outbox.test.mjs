import { launchBrowser, register, log, uniq } from "./harness.mjs";

// Gate: "offline-first queue" — an unsent message survives a channel switch and
// is auto-re-sent when connectivity returns.
const u = uniq();
const browser = await launchBrowser();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `ob_${u}`, "Otto");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Outbox HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // a second channel to switch to
  await page.click('button[aria-label="Create channel"]');
  await page.fill('input[placeholder="new-channel"]', "random");
  await page.locator('input[placeholder="new-channel"]').press("Enter");
  await page.waitForSelector('button:has-text("random")', { timeout: 6000 });

  // simulate offline: block message POSTs
  let block = true;
  await page.route(/\/api\/v1\/channels\/.*\/messages$/, (route) =>
    block && route.request().method() === "POST" ? route.abort("failed") : route.continue()
  );

  const composer = page.locator('input[placeholder*="Say something"]');
  await composer.fill("queued while offline");
  await composer.press("Enter");
  await page.waitForSelector("text=/Couldn.t send/", { timeout: 8000 });
  log("send failed → queued in the outbox ✓");

  // switch away and back — the queued message must still be there (persisted)
  await page.click('button:has-text("random")');
  await page.waitForSelector('input[placeholder*="Say something to #random"]', { timeout: 6000 });
  await page.click('button:has-text("general")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 6000 });
  await page.waitForSelector("text=queued while offline", { timeout: 6000 });
  await page.waitForSelector("text=/Couldn.t send/", { timeout: 4000 });
  log("queued message survived a channel switch (persisted outbox) ✓");

  // connectivity returns → the outbox auto-flushes and the message sends
  block = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => !/Couldn.t send/.test(document.body.innerText), { timeout: 8000 });
  await page.waitForSelector("text=queued while offline", { timeout: 6000 });
  log("connectivity returned → outbox auto-flushed, message sent ✓");

  console.log("\n✅ OUTBOX FLOW PASSED (queue · survive switch · auto-flush on reconnect)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
