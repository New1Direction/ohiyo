import { launchBrowser, register, log, uniq } from "./harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Gate: "media never causes layout shift" — an image must render and reserve its
// exact aspect-ratio space from server-provided dimensions before the pixels load.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "img-600x400.png");
const u = uniq();
const browser = await launchBrowser();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `im_${u}`, "Iris");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Image HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  await page.setInputFiles('input[aria-label="Attach files"]', FIXTURE);
  await page.waitForTimeout(2200); // upload completes
  await page.locator('input[placeholder*="Say something"]').press("Enter");

  await page.waitForSelector(".kc-img-frame", { timeout: 10000 });
  log("image attachment renders (attachments parsed correctly) ✓");

  // 600x400 capped at 400x300 → 400x267; the frame reserves that before load.
  const frame = await page.locator(".kc-img-frame").first().evaluate((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
  if (Math.abs(frame.w - 400) > 4 || Math.abs(frame.h - 267) > 4) {
    throw new Error(`reserved frame ${frame.w}x${frame.h}, expected ~400x267`);
  }
  log(`space reserved at correct aspect (${frame.w}x${frame.h}) — no layout shift ✓`);

  console.log("\n✅ IMAGES FLOW PASSED (upload · attachments render · dimensioned reserved space)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
