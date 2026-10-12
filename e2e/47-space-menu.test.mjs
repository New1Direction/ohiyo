import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// The space menu opens from the space's name, like Discord: one labelled menu in place of the
// row of unlabelled icons. It fits the window on a desktop and on a phone, the keyboard lands
// in it and Escape gives focus back to the name. Screenshots (dark, light, phone) are kept on
// every run so the menu can be looked at.
const browser = await launchBrowser();
let failed = false;
const COMPOSER = 'textarea[placeholder*="Say something"]';
const NAME = '.channel-sidebar button[aria-haspopup="menu"]';
const MENU = '.channel-sidebar [role="menu"]';

async function onboard(page, who, space) {
  await register(page, `sm_${who}_${uniq()}`, who);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
}

const readMenu = (page) =>
  page.evaluate((sel) => {
    const menu = document.querySelector(sel);
    if (!menu) return null;
    const box = menu.getBoundingClientRect();
    const active = document.activeElement;
    return {
      left: Math.round(box.left),
      right: Math.round(box.right),
      bottom: Math.round(box.bottom),
      vw: innerWidth,
      vh: innerHeight,
      items: [...menu.querySelectorAll('[role="menuitem"]')].map((el) => ({
        label: el.textContent.trim(),
        h: Math.round(el.getBoundingClientRect().height),
        danger: el.classList.contains("is-danger"),
      })),
      focused: active?.getAttribute("role") === "menuitem" ? active.textContent.trim() : null,
    };
  }, MENU);

function checkFits(menu, where) {
  if (!menu) throw new Error(`${where}: the menu didn't open`);
  if (menu.left < 0 || menu.right > menu.vw || menu.bottom > menu.vh) throw new Error(`${where}: the menu spills off the window: ${JSON.stringify(menu)}`);
}

try {
  // ── Desktop ──
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(page, "Desk", "Menu HQ");

  for (const gone of ["Events", "Moderation queue", "Space options", "Change server logo", "Report server"]) {
    if (await page.locator(`.channel-sidebar button[aria-label="${gone}"]`).count()) throw new Error(`the header still has the "${gone}" icon`);
  }
  if (!(await page.locator('.channel-sidebar button[aria-label="Invite people"]').isVisible())) throw new Error("the Invite button is gone");

  await page.click(NAME);
  await page.waitForSelector(MENU, { timeout: 4000 });
  await settle(page, 250);
  const desk = await readMenu(page);
  checkFits(desk, "desktop");
  const labels = desk.items.map((i) => i.label);
  for (const want of ["Invite people", "Create channel", "Events", "Delete space"]) {
    if (!labels.includes(want)) throw new Error(`the owner's menu has no "${want}": ${labels.join(", ")}`);
  }
  if (labels.at(-1) !== "Delete space" || !desk.items.at(-1).danger) throw new Error(`Delete space is not last in the danger colour: ${JSON.stringify(desk.items)}`);
  if (desk.focused !== "Invite people") throw new Error(`opening the menu didn't put focus on its first item (${desk.focused})`);
  await shot(page, "47-space-menu-desktop-dark");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await page.waitForSelector(MENU, { state: "detached", timeout: 4000 });
  if (!(await page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup") === "menu"))) throw new Error("Escape didn't give focus back to the space name");
  log(`desktop: the name opens ${labels.length} labelled items, fits the window, Escape returns to the name ✓`);

  // A light theme, to look at.
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.keyboard.press("Escape");
  await settle(page, 300);
  await page.click(NAME);
  await page.waitForSelector(MENU, { timeout: 4000 });
  await settle(page, 250);
  checkFits(await readMenu(page), "desktop light");
  await shot(page, "47-space-menu-desktop-light");
  await page.mouse.click(900, 400);
  await page.waitForSelector(MENU, { state: "detached", timeout: 4000 });
  log("desktop light: the menu opens and a click outside closes it ✓");

  // ── Phone ──
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(phone, "Pocket", "Menu Phone");
  await phone.locator('button[aria-label="Open channels"]').first().tap();
  await settle(phone, 450);
  await phone.locator(`.kc-nav ${NAME}`).tap();
  await phone.waitForSelector(`.kc-nav ${MENU}`, { timeout: 4000 });
  await settle(phone, 250);
  const pocket = await readMenu(phone);
  checkFits(pocket, "phone");
  const short = pocket.items.filter((i) => i.h < 44);
  if (short.length) throw new Error(`menu rows under 44px on a phone: ${JSON.stringify(short)}`);
  await shot(phone, "47-space-menu-phone");
  log(`phone: the menu fits and its ${pocket.items.length} rows are at least 44px ✓`);

  console.log("\n✅ SPACE MENU PASSED (opens from the name · labelled · keyboard · fits desktop and phone)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
