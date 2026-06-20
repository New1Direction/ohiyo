import { launchBrowser, ORIGIN, register, shot, settle, log, uniq } from "./harness.mjs";

const u = uniq();
const A = `sv_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, A, "Sven");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Save HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // send a message
  const composer = page.locator('input[placeholder*="Say something"]');
  await composer.fill("keep this one for later");
  await composer.press("Enter");
  await page.waitForSelector('[data-message-id]:not([data-message-id^="temp-"]) >> text=keep this one for later', { timeout: 8000 });

  // ── save it via the 🔖 action ──
  const saveMsg = page.locator('[data-message-id]:not([data-message-id^="temp-"])', { hasText: "keep this one for later" });
  await saveMsg.hover();
  await saveMsg.getByRole("button", { name: "Save message" }).first().click();
  await page.waitForSelector("text=/Saved/", { timeout: 6000 });
  log("saved a message (toast) ✓");

  // ── open Saved panel → it's there ──
  await page.click('button[aria-label="Saved messages"]');
  await page.waitForSelector("text=🔖 Saved messages", { timeout: 5000 });
  await page.waitForSelector("text=keep this one for later", { timeout: 6000 });
  log("Saved panel shows the bookmark ✓");
  await shot(page, "35-saved");

  // ── remove it ──
  await page.locator('button[aria-label="Remove from saved"]').first().click();
  await page.waitForSelector("text=Nothing saved yet", { timeout: 6000 });
  log("removed from saved → empty ✓");

  console.log("\n✅ SAVED MESSAGES FLOW PASSED (save · view · jump-source · remove)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
