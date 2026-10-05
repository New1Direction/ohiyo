import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Settings on a phone. Under 560px the sidebar used to shrink to a rail of eight identical
// dots (every label hidden) and the only "Back to Ohiyo" button was hidden with them, so a
// phone user could not tell the tabs apart or leave Settings.
const browser = await launchBrowser();
let failed = false;
const DIALOG = '[role="dialog"][aria-labelledby="kc-settings-dialog-title"]';

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `sp_${uniq()}`, "Settings Sam");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Pocket");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something"]', { timeout: 12000 });

  await page.locator('button[aria-label="Open channels"]').first().click();
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector(DIALOG, { timeout: 6000 });
  await settle(page, 400);

  // Every tab says what it is.
  const tabs = await page.locator(`${DIALOG} .kc-settings-nav__item`).evaluateAll((items) =>
    items.map((item) => {
      const label = item.querySelector(".kc-settings-nav__text span");
      const box = label.getBoundingClientRect();
      return { text: label.textContent.trim(), shown: box.width > 0 && box.height > 0 && getComputedStyle(label).visibility !== "hidden" };
    }),
  );
  const unlabeled = tabs.filter((t) => !t.shown).map((t) => t.text);
  if (tabs.length < 8 || unlabeled.length) throw new Error(`settings tabs with no visible name on a phone: ${unlabeled.join(", ") || "(no tabs)"}`);
  log(`phone settings: all ${tabs.length} tabs show their names ✓`);

  // Nothing sticks out sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`settings is ${overflow}px wider than the phone`);

  // A tab further along can be reached and opens its page.
  await page.locator(`${DIALOG} .kc-settings-nav__item`, { hasText: "Plugins" }).click();
  await page.waitForSelector("text=Small extras you can switch on or off", { timeout: 6000 });
  const activeInView = await page.locator(`${DIALOG} .kc-settings-nav__item--active`).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth;
  });
  if (!activeInView) throw new Error("the open tab is scrolled out of view");
  log("phone settings: a tab further along opens and stays in view ✓");
  await shot(page, "31-settings-phone");

  // And there is a way out.
  const back = page.locator(`${DIALOG} button`, { hasText: "Back to Ohiyo" });
  if (!(await back.isVisible())) throw new Error("no visible way to leave Settings on a phone");
  await back.click();
  await page.waitForSelector(DIALOG, { state: "detached", timeout: 4000 });
  await page.waitForSelector('input[placeholder*="Say something"]', { state: "visible", timeout: 4000 });
  log("phone settings: Back to Ohiyo is there and returns to the chat ✓");

  console.log("\n✅ SETTINGS ON A PHONE PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ SETTINGS ON A PHONE FAILED:", err?.message ?? err);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
