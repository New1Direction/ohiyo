import { launchBrowser, register, log, uniq } from "./harness.mjs";

// Gate: "the composer is sacred" — unsent text must survive a channel switch.
const u = uniq();
const browser = await launchBrowser();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `dr_${u}`, "Dee");
  await page.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await page.fill("#kc-space-name", "Draft HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  const DRAFT = "a half-written thought for #general";
  const composer = page.locator('input[placeholder*="Say something"]');

  // type a draft in #general (do NOT send)
  await composer.fill(DRAFT);

  // make a second channel and switch to it
  await page.click('button[aria-label="Create channel"]');
  await page.fill('input[placeholder="new-channel"]', "random");
  await page.locator('input[placeholder="new-channel"]').press("Enter");
  await page.waitForSelector('button:has-text("random")', { timeout: 6000 });
  await page.click('button:has-text("random")');
  await page.waitForSelector('input[placeholder*="Say something to #random"]', { timeout: 6000 });

  // #random composer must be empty (draft didn't leak)
  await page.waitForFunction(
    () => (document.querySelector('input[placeholder*="Say something"]')?.value ?? null) === "",
    null, { timeout: 4000 }
  );
  log("draft did not leak into #random ✓");

  // switch back → the #general draft is restored verbatim
  await page.click('button:has-text("general")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 6000 });
  await page.waitForFunction(
    (expected) => (document.querySelector('input[placeholder*="Say something"]')?.value ?? "") === expected,
    DRAFT, { timeout: 4000 }
  );
  log("draft restored in #general ✓");

  console.log("\n✅ DRAFTS FLOW PASSED (per-channel drafts · no leak · restored on return)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
