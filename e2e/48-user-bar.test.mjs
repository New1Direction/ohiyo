import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// The bar at the foot of the channel sidebar is two lines, like Discord's: your name, then
// your status. Clicking it opens a menu with your status, an activity and Sign out…; Settings
// stays on the bar. Message times read "Today at 9:23 AM", with the full date on hover.
// Screenshots at desktop and phone width, dark and light, are kept by CI to look at.
const browser = await launchBrowser();
let failed = false;
const COMPOSER = 'input[placeholder*="Say something"]';

async function onboard(page, tag, displayName, space) {
  await register(page, `ub_${tag}_${uniq()}`, displayName);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
}

const readBar = (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".kc-user-panel");
    const lines = [...(panel?.querySelectorAll("[data-user-line]") ?? [])].map((l) => ({
      text: l.textContent.trim(),
      // One line each: a wrapped line is taller than its line height.
      wraps: l.getBoundingClientRect().height > parseFloat(getComputedStyle(l).lineHeight) * 1.5,
    }));
    return { lines, panelHeight: Math.round(panel?.getBoundingClientRect().height ?? 0) };
  });

const plain = (s) => s.replace(/\s/g, " ").trim();

async function sendAndReadTime(page, text) {
  await page.fill(COMPOSER, text);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".msg-meta time[datetime]", { timeout: 8000 });
  return page.evaluate(() => {
    const t = document.querySelector(".msg-meta time[datetime]");
    return { text: t.textContent, title: t.getAttribute("title"), datetime: t.getAttribute("datetime") };
  });
}

try {
  // ── Desktop ──
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(page, "desk", "Desk", "User Bar");

  const stamp = await sendAndReadTime(page, "hello from the desk");
  if (!/^Today at \d{1,2}:\d{2}/.test(plain(stamp.text))) throw new Error(`a new message's time reads "${stamp.text}"`);
  if (!stamp.title || !/\d{4}/.test(stamp.title)) throw new Error(`hovering the time doesn't give the full date: "${stamp.title}"`);
  if (Number.isNaN(Date.parse(stamp.datetime))) throw new Error(`the time has no machine-readable datetime: "${stamp.datetime}"`);
  log(`message time reads "${plain(stamp.text)}", full date on hover ✓`);

  const bar = await readBar(page);
  if (bar.lines.length !== 2) throw new Error(`the bar has ${bar.lines.length} lines: ${JSON.stringify(bar.lines)}`);
  if (bar.lines[0].text !== "Desk" || bar.lines[1].text !== "Set a status") throw new Error(`the bar reads ${JSON.stringify(bar.lines)}`);
  if (bar.lines.some((l) => l.wraps)) throw new Error(`a bar line wraps: ${JSON.stringify(bar.lines)}`);
  log(`the bar is two lines: ${bar.lines.map((l) => l.text).join(" / ")} (${bar.panelHeight}px) ✓`);
  await shot(page, "48-user-bar-desktop-dark");

  await page.click(".kc-user-identity");
  await page.waitForSelector('.kc-user-menu[role="dialog"]', { timeout: 4000 });
  await page.click('.kc-user-menu button:has-text("Add an activity")');
  await page.waitForSelector('.kc-user-menu input[aria-label="Activity name"]', { timeout: 4000 });
  await settle(page, 300);
  await shot(page, "48-user-bar-desktop-menu-dark");
  await page.fill('.kc-user-menu input[aria-label="Activity name"]', "Chess");
  await page.locator('.kc-user-menu input[aria-label="Activity name"]').press("Enter");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".kc-user-menu", { state: "detached", timeout: 4000 });
  // The server echoes the activity back before the bar shows it.
  const shown = await page
    .waitForFunction(() => /Playing Chess/.test(document.querySelectorAll(".kc-user-panel [data-user-line]")[1]?.textContent ?? ""), undefined, { timeout: 6000 })
    .then(() => true, () => false);
  if (!shown) throw new Error(`the bar doesn't show the activity: ${JSON.stringify((await readBar(page)).lines)}`);
  log("an activity added from the menu shows on the second line ✓");

  // Light theme, to look at.
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.keyboard.press("Escape");
  await settle(page, 300);
  await shot(page, "48-user-bar-desktop-light");
  await page.click(".kc-user-identity");
  await page.waitForSelector('.kc-user-menu[role="dialog"]', { timeout: 4000 });
  await settle(page, 300);
  await shot(page, "48-user-bar-desktop-menu-light");
  await page.keyboard.press("Escape");

  // ── Phone ──
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(phone, "pocket", "A rather long display name for a phone", "Pocket Bar");
  const cdp = await phoneCtx.newCDPSession(phone);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await settle(phone, 200);
  await sendAndReadTime(phone, "hello from my phone");
  const headerWraps = await phone.evaluate(() => {
    const meta = document.querySelector(".msg-meta");
    const name = meta?.querySelector("button")?.getBoundingClientRect();
    const time = meta?.querySelector("time")?.getBoundingClientRect();
    return name && time ? Math.abs(name.top - time.top) > 6 : null;
  });
  if (headerWraps) throw new Error("on a phone the message time drops under a long name");
  log("on a phone a long name shortens and the time stays on the same line ✓");
  await shot(phone, "48-user-bar-phone-chat");

  await phone.locator('button[aria-label="Open channels"]').first().click();
  await settle(phone, 300);
  const phoneBar = await readBar(phone);
  if (phoneBar.lines.length !== 2 || phoneBar.lines.some((l) => l.wraps)) throw new Error(`phone bar: ${JSON.stringify(phoneBar.lines)}`);
  const small = await phone.evaluate(() =>
    [...document.querySelectorAll(".kc-user-identity, .kc-user-panel button[aria-label='Settings']")]
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0 && (r.height < 44 || r.width < 44))
      .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  if (small.length) throw new Error(`user bar targets smaller than 44px on a phone: ${small.join(", ")}`);
  await shot(phone, "48-user-bar-phone-sidebar");
  await phone.locator(".kc-user-identity").tap();
  await phone.waitForSelector('.kc-user-menu[role="dialog"]', { timeout: 4000 });
  // The menu opens with a short scale-in; measure once it has settled.
  await settle(phone, 300);
  const smallItems = await phone.evaluate(() =>
    [...document.querySelectorAll(".kc-user-menu button, .kc-user-menu input")]
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height < 44)
      .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  if (smallItems.length) throw new Error(`user menu targets shorter than 44px on a phone: ${smallItems.join(", ")}`);
  log("on a phone the bar is two lines and every target is at least 44px ✓");
  await shot(phone, "48-user-bar-phone-menu");

  console.log("\n✅ USER BAR PASSED (two lines · menu · activity · times · phone)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
