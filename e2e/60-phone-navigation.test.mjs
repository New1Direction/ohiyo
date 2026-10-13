import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Getting around on a phone without hunting for buttons: swipe right for the spaces and
// channels, swipe left for the member list, and a tab bar at the foot of the drawer that goes
// between spaces and messages in one tap. Discord's newer phone layout dropped the swipe to
// the member list and added taps between servers and DMs; this checks we don't.
const browser = await launchBrowser();
let failed = false;
const COMPOSER = 'textarea[placeholder*="Say something"]';

/** A one-finger swipe through the browser's touch input (a tap is all the driver offers). */
async function swipe(cdp, from, to, ms = 240, steps = 12) {
  const point = (x, y) => [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from[0], from[1]) });
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    await new Promise((resolve) => setTimeout(resolve, ms / steps));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x, y) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const drawerOpen = (page) => page.evaluate(() => document.querySelector(".kc-nav")?.classList.contains("is-open") ?? false);
const membersOpen = (page) => page.evaluate(() => !!document.querySelector('[role="dialog"].kc-modal--side'));
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `sw_${uniq()}`, "Swipe Sam");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Thumbs");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await settle(page, 400);
  // Let the welcome toast go, so it isn't in the pictures.
  await page.waitForSelector(".ohiyo-toast", { state: "detached", timeout: 8000 }).catch(() => {});

  // Swipe right in the middle of the chat: the drawer opens.
  if (await drawerOpen(page)) throw new Error("the drawer is open before any swipe");
  await swipe(cdp, [90, 420], [330, 424]);
  await settle(page, 450);
  if (!(await drawerOpen(page))) throw new Error("a swipe right in the chat didn't open the drawer");
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('.kc-nav nav[aria-label="Main"] button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: b.getAttribute("aria-label"), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
    }),
  );
  if (tabs.map((t) => t.label.split(",")[0]).join() !== "Home,Messages,Mentions,You") throw new Error(`the drawer's tab bar isn't Home, Messages, Mentions, You: ${JSON.stringify(tabs)}`);
  if (tabs.some((t) => t.h < 44 || t.w < 44)) throw new Error(`a tab is smaller than a fingertip: ${JSON.stringify(tabs)}`);
  if (tabs.some((t) => t.bottom > 844)) throw new Error(`the tab bar runs off the bottom: ${JSON.stringify(tabs)}`);
  await shot(page, "60-phone-nav-drawer-dark");
  log("phone: a swipe right opens the drawer, with Home, Messages, Mentions and You at its foot ✓");

  // One tap from the space to your messages, and one back.
  await page.locator('.kc-nav nav[aria-label="Main"] button[aria-label^="Messages"]').tap();
  await page.waitForSelector('.kc-nav :text("Direct Messages")', { timeout: 4000 });
  await page.locator('.kc-nav nav[aria-label="Main"] button[aria-label="Home"]').tap();
  await page.waitForSelector('.kc-nav :text-is("Thumbs")', { timeout: 4000 });
  log("phone: Messages and Home are one tap apart ✓");

  // Swipe left across the drawer: it closes.
  await swipe(cdp, [300, 420], [40, 424]);
  await settle(page, 450);
  if (await drawerOpen(page)) throw new Error("a swipe left didn't close the drawer");

  // Swipe left in the chat: the member list slides in from the right; swipe right to close it.
  await swipe(cdp, [320, 420], [60, 424]);
  await settle(page, 450);
  if (!(await membersOpen(page))) throw new Error("a swipe left in the chat didn't open the member list");
  await shot(page, "60-phone-nav-members-dark");
  await swipe(cdp, [120, 420], [370, 424]);
  await settle(page, 500);
  if (await membersOpen(page)) throw new Error("a swipe right on the member list didn't close it");
  log("phone: a swipe left opens the member list from the right, and a swipe right closes it ✓");

  // Scrolling the chat up and down never opens anything.
  await swipe(cdp, [200, 600], [214, 260]);
  await settle(page, 400);
  if ((await drawerOpen(page)) || (await membersOpen(page))) throw new Error("an up/down scroll opened a panel");
  if ((await sideways(page)) > 0) throw new Error(`the page scrolls sideways at 390: ${await sideways(page)}px`);
  log("phone: scrolling up and down leaves the panels alone, and nothing scrolls sideways ✓");

  // In the light theme, on the smallest phone.
  await page.evaluate(() => localStorage.setItem("kikkacord:theme", "light"));
  await page.setViewportSize({ width: 320, height: 568 });
  await page.reload();
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await settle(page, 600);
  await swipe(cdp, [70, 300], [280, 304]);
  await settle(page, 450);
  if (!(await drawerOpen(page))) throw new Error("a swipe right didn't open the drawer at 320 wide");
  if ((await sideways(page)) > 0) throw new Error(`the page scrolls sideways at 320: ${await sideways(page)}px`);
  await shot(page, "60-phone-nav-drawer-light-320");
  await swipe(cdp, [260, 300], [30, 304]);
  await settle(page, 450);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page, 300);
  await swipe(cdp, [320, 420], [60, 424]);
  await settle(page, 450);
  if (!(await membersOpen(page))) throw new Error("the member list didn't open in the light theme");
  await shot(page, "60-phone-nav-members-light");
  log("phone: the drawer and member list work at 320 wide and in the light theme ✓");

  console.log("\n✅ PHONE NAVIGATION PASSED");
} catch (e) {
  failed = true;
  console.error("\n❌ FAILED:", e.message);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
