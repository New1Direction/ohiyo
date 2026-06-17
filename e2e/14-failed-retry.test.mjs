import { launchBrowser, register, log, uniq } from "./harness.mjs";

// Gate: "every message has a clear state" — a send that fails must stay visible
// in a failed state with a working Retry (not silently vanish).
const u = uniq();
const browser = await launchBrowser();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `rt_${u}`, "Rae");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Resilience HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // Force the next message POST to fail at the network layer.
  let blockSends = true;
  await page.route(/\/api\/v1\/channels\/.*\/messages$/, (route) =>
    blockSends && route.request().method() === "POST" ? route.abort("failed") : route.continue()
  );

  const composer = page.locator('input[placeholder*="Say something"]');
  await composer.fill("this should fail first");
  await composer.press("Enter");

  // The message stays visible with a failed affordance (not deleted).
  await page.waitForSelector("text=/Couldn.t send/", { timeout: 8000 });
  await page.waitForSelector("text=this should fail first", { timeout: 4000 });
  log("send failed → message kept in failed state with ⚠ Couldn't send ✓");

  // Stop blocking, then retry — it should go through and clear the failed state.
  blockSends = false;
  await page.getByRole("button", { name: "Retry" }).first().click();
  await page.waitForFunction(() => !/Couldn.t send/.test(document.body.innerText), { timeout: 8000 });
  await page.waitForSelector("text=this should fail first", { timeout: 6000 });
  log("retry succeeded → failed state cleared, message sent ✓");

  console.log("\n✅ FAILED/RETRY FLOW PASSED (pending → failed → retry → sent)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
