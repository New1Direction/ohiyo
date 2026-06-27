import { launchBrowser, register, shot, settle, log, uniq } from "./harness.mjs";

const u = uniq();
const A = `fw_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, A, "Fia");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Fwd HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // second channel to forward into
  await page.click('button[aria-label="Create channel"]');
  await page.fill('input[placeholder="new-channel"]', "archive");
  await page.locator('input[placeholder="new-channel"]').press("Enter");
  await page.waitForSelector('button:has-text("archive")', { timeout: 6000 });

  // send a message in #general
  const composer = page.locator('input[placeholder*="Say something"]');
  await composer.fill("a keepsake worth forwarding");
  await composer.press("Enter");
  await page.waitForSelector("text=a keepsake worth forwarding", { timeout: 8000 });
  await page.waitForFunction(() => {
    return [...document.querySelectorAll("[data-message-id]")].some(
      (el) => !el.getAttribute("data-message-id")?.startsWith("temp-") && el.textContent?.includes("a keepsake worth forwarding")
    );
  }, null, { timeout: 8000 });

  // ── forward it to #archive ──
  const fwdMsg = page.locator('[data-message-id]:not([data-message-id^="temp-"])', { hasText: "a keepsake worth forwarding" });
  await fwdMsg.hover();
  await fwdMsg.getByRole("button", { name: "Forward message" }).first().click();
  await page.waitForSelector("text=↪ Forward", { timeout: 5000 });
  await shot(page, "37-forward");
  await page.getByRole("dialog").getByRole("button", { name: /archive/ }).first().click();
  await page.waitForSelector("text=/Forwarded/", { timeout: 6000 });
  log("forwarded (toast) ✓");

  // ── open #archive → forwarded message with attribution ──
  await page.click('button:has-text("archive")');
  await page.waitForSelector('input[placeholder*="Say something to #archive"]', { timeout: 6000 });
  await page.waitForSelector("text=a keepsake worth forwarding", { timeout: 6000 });
  await page.waitForSelector("text=/Forwarded from/", { timeout: 6000 });
  log("#archive shows the forwarded message with 'Forwarded from Fia' ✓");
  await shot(page, "38-forwarded");

  console.log("\n✅ FORWARD FLOW PASSED (forward action · pick channel · attributed repost)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
