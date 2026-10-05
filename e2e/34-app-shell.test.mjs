import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// The frame around the chat: the rail on the far left, the space's sidebar and the message
// box. Each check here was clutter a new owner saw on their first screen.
const browser = await launchBrowser();
let failed = false;
const COMPOSER = 'input[placeholder*="Say something"]';

try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `sh_${uniq()}`, "Shell Shay");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Harbor");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
  await settle(page, 500);

  // The rail: spaces first. The home switcher (and its own "+") sits at the bottom, so the
  // "+" next to your spaces is the only one in reach and means one thing.
  const rail = await page.evaluate(() => {
    const top = (label) => document.querySelector(`.server-sidebar button[aria-label="${label}"]`)?.getBoundingClientRect().top ?? null;
    const railBox = document.querySelector(".server-sidebar > div").getBoundingClientRect();
    return { createSpace: top("Create a space"), addHome: top("Add an Ohiyo home"), saved: top("Saved messages"), railBottom: railBox.bottom, vh: innerHeight };
  });
  if (rail.createSpace === null || rail.addHome === null) throw new Error(`rail buttons missing: ${JSON.stringify(rail)}`);
  if (!(rail.createSpace < rail.addHome && rail.saved < rail.addHome)) throw new Error(`the home switcher should come after the spaces in the rail: ${JSON.stringify(rail)}`);
  if (rail.vh - rail.addHome > 120) throw new Error(`the home switcher should sit at the bottom of the rail: ${JSON.stringify(rail)}`);
  log("shell: spaces first in the rail, home switcher at the bottom ✓");

  // The owner is not offered a button to report their own space.
  if (await page.locator('.channel-sidebar button[aria-label="Report server"]').count()) throw new Error("the owner is shown Report server for their own space");
  if (!(await page.locator('.channel-sidebar button[aria-label="Invite people"]').isVisible())) throw new Error("the Invite button is gone");
  log("shell: no report button on your own space ✓");

  // The message box has one "+". The poll lives inside it, next to uploading a file.
  if (await page.locator('.kc-composer-tools > button[aria-label="Create a poll"]').count()) throw new Error("the poll button still sits beside the message box");
  await page.locator('button[aria-label="Add to your message"]').click();
  const menu = page.locator(".kc-composer-menu");
  await menu.waitFor({ timeout: 3000 });
  const items = await menu.locator("button").allTextContents();
  if (!items.some((t) => /Upload a file/.test(t)) || !items.some((t) => /Create a poll/.test(t))) throw new Error(`unexpected menu: ${items.join(" | ")}`);
  await shot(page, "34-composer-menu");
  // Escape closes it without doing anything.
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached", timeout: 3000 });
  // And the poll can still be made from there.
  await page.locator('button[aria-label="Add to your message"]').click();
  await menu.locator("button", { hasText: "Create a poll" }).click();
  await page.waitForSelector("text=New poll", { timeout: 5000 });
  await page.fill('input[aria-label="Poll question"]', "Lunch?");
  await page.fill('input[aria-label="Poll option 1"]', "Yes");
  await page.fill('input[aria-label="Poll option 2"]', "Also yes");
  await page.click('button:has-text("Launch poll")');
  await page.waitForSelector("text=Also yes", { timeout: 8000 });
  log("shell: one + on the message box, with file and poll inside ✓");

  console.log("\n✅ APP SHELL PASSED");
} catch (e) {
  failed = true;
  console.error("\n❌ FAILED:", e.message);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
