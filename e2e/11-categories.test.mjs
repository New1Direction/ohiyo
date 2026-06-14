import { launchBrowser, register, shot, settle, log, uniq } from "./harness.mjs";

const u = uniq();
const A = `ct_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, A, "Cat");
  await page.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await page.fill("#kc-space-name", "Cat HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // create a channel "lounge" (uncategorized)
  await page.click('button[aria-label="Create channel"]');
  await page.fill('input[placeholder="new-channel"]', "lounge");
  await page.locator('input[placeholder="new-channel"]').press("Enter");
  await page.waitForSelector('button:has-text("lounge")', { timeout: 6000 });
  log("created #lounge");

  // ── create a category + assign lounge to it ──
  await page.click('button[aria-label="Manage categories"]');
  await page.waitForSelector("text=📁 Categories", { timeout: 5000 });
  await page.fill('input[aria-label="Category name"]', "Hangout");
  await page.click('button:has-text("Add")');
  await page.waitForSelector('button[aria-label="Delete Hangout"]', { timeout: 6000 });
  log("created category Hangout ✓");
  await page.selectOption('select[aria-label="Category for lounge"]', { label: "Hangout" });
  await settle(page, 400);
  await shot(page, "36-categories");
  await page.keyboard.press("Escape");

  // ── sidebar shows the collapsible category with lounge under it ──
  const sidebar = page.locator(".channel-sidebar");
  await sidebar.locator('button:has-text("Hangout")').first().waitFor({ timeout: 6000 });
  await sidebar.locator('button:has-text("lounge")').first().waitFor({ timeout: 6000 });
  log("sidebar shows Hangout category with #lounge inside ✓");

  // ── collapse hides lounge; expand shows it again ──
  await sidebar.locator('button:has-text("Hangout")').first().click();
  await page.waitForFunction(() => {
    const sb = document.querySelector(".channel-sidebar");
    return sb && ![...sb.querySelectorAll("button")].some((b) => (b.textContent || "").includes("lounge"));
  }, { timeout: 6000 });
  log("collapsing the category hides #lounge ✓");
  await sidebar.locator('button:has-text("Hangout")').first().click();
  await sidebar.locator('button:has-text("lounge")').first().waitFor({ timeout: 6000 });
  log("expanding shows #lounge again ✓");

  console.log("\n✅ CATEGORIES FLOW PASSED (create · assign · grouped render · collapse/expand)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
