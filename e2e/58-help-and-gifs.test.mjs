import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Help & feedback, and a GIF tab that's only there when it works.
//   • Settings has "Help & feedback" at the foot of its sidebar. It shows the live service
//     status from this home, a prefilled bug report, and the Terms and Privacy pages.
//   • The command palette (Ctrl/⌘K) opens the same page.
//   • This stack has no KLIPY key, so the composer's picker offers emoji and no GIFs tab (the old
//     tab searched Tenor, whose API Google shut down).
//   • Screenshots of Help at desktop and phone width, dark and light, are kept to look at.
const browser = await launchBrowser();
let failed = false;
const DIALOG = '[role="dialog"][aria-labelledby="kc-settings-dialog-title"]';

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
}

// The status line has answered: either all is well or it names what isn't.
async function statusAnswered(page) {
  const help = page.locator(`${DIALOG} [data-help-status]`);
  await help.waitFor({ timeout: 6000 });
  const answered = await page
    .waitForFunction(
      () => /All systems normal|aren't working/.test(document.querySelector("[data-help-status]")?.textContent ?? ""),
      undefined,
      { timeout: 8000 },
    )
    .then(() => true, () => false);
  if (!answered) throw new Error(`the status line never answered: ${await help.textContent()}`);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(page, `hlp_${uniq()}`, "Helpy", "Help HQ");

  // No KLIPY key here: the picker offers emoji, and no GIFs tab.
  await page.click('button[aria-label="Emoji and GIFs"]');
  await settle(page, 300);
  const gifTab = await page.locator('button:text-is("GIFs")').count();
  if (gifTab !== 0) throw new Error("a GIFs tab shows on a home with no GIF search");
  log("no KLIPY key: the picker offers no GIFs tab ✓");
  await page.click('button[aria-label="Emoji and GIFs"]');

  // Settings → Help & feedback.
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.waitForSelector(DIALOG, { timeout: 6000 });
  await page.locator(`${DIALOG} button`, { hasText: "Help & feedback" }).click();
  await statusAnswered(page);
  const bug = await page.locator(`${DIALOG} a`, { hasText: "Report a bug" }).getAttribute("href");
  if (!bug?.startsWith("https://github.com/New1Direction/ohiyo/issues/new")) throw new Error(`bug link: ${bug}`);
  const terms = await page.locator(`${DIALOG} a`, { hasText: "Terms" }).first().getAttribute("href");
  if (terms !== "https://ohiyo.gg/terms.html") throw new Error(`terms link: ${terms}`);
  log("Settings → Help & feedback shows the live status, a bug report and the Terms ✓");
  await shot(page, "58-help-desktop-dark");
  await page.keyboard.press("Escape");
  await page.waitForSelector(DIALOG, { state: "detached", timeout: 4000 });

  // The command palette opens the same page.
  await page.keyboard.press("Control+k");
  await page.keyboard.type("help");
  await page.keyboard.press("Enter");
  await statusAnswered(page);
  log("the command palette opens Help & feedback ✓");

  // Light, to look at.
  await page.locator(`${DIALOG} .kc-settings-nav button`, { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.locator(`${DIALOG} button`, { hasText: "Help & feedback" }).click();
  await statusAnswered(page);
  await shot(page, "58-help-desktop-light");
  await page.keyboard.press("Escape");

  // Phone.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => console.error("  PHONE ERR:", e.message));
  await onboard(phone, `hlq_${uniq()}`, "Helpy Phone", "Pocket Help");
  await phone.locator('button[aria-label="Open channels"]').first().click();
  await phone.click('button[aria-label="Settings"]');
  await phone.waitForSelector(DIALOG, { timeout: 6000 });
  await phone.locator(`${DIALOG} button`, { hasText: "Help & feedback" }).click();
  await statusAnswered(phone);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`Help is ${overflow}px wider than the phone`);
  await shot(phone, "58-help-phone");
  log("Help fits a phone ✓");

  console.log("\n✅ HELP AND GIFS PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ HELP AND GIFS FAILED:", err?.message ?? err);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
