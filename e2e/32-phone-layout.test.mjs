import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// The app in a phone browser (390 wide, touch). Each check here was a real defect: buttons
// sitting on top of message text, a desktop hover toolbar popping over neighbouring messages,
// no way to react by touch, a dialog wider than the screen, a drawer that hid the channels
// behind a checklist, tap targets a quarter of a fingertip, and inputs small enough that an
// iPhone zooms the whole page when one is focused.
const browser = await launchBrowser();
let failed = false;
const COMPOSER = 'input[placeholder*="Say something"]';
const MIN_TAP = 40;

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `ph_${uniq()}`, "Phone Pat");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Pocket");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
  // The driver's own touch emulation is usually lost when the page reloads during sign-up
  // (maxTouchPoints comes back 0), and the touch styles are what is under test, so switch
  // it on again now that the app has loaded.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await settle(page, 200);
  if (!(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches))) throw new Error("the test browser is not reporting a touch screen");

  // The app is as tall as the part of the screen the browser leaves it, not the whole screen.
  const shell = await page.evaluate(() => {
    const el = document.querySelector(".kc-screen");
    return el ? { height: Math.round(el.getBoundingClientRect().height), inner: window.innerHeight } : null;
  });
  if (!shell || shell.height !== shell.inner) throw new Error(`the app shell is not sized to the visible screen: ${JSON.stringify(shell)}`);

  // Toasts appear at the top on a phone, clear of the message box and the newest messages.
  const toastTop = await page.evaluate(() => document.querySelector(".ohiyo-toast-stack")?.getBoundingClientRect().top ?? null);
  if (toastTop === null || toastTop > 120) throw new Error(`toasts are not anchored to the top on a phone (top ${toastTop})`);
  log("phone: the shell fits the visible screen and toasts sit at the top ✓");

  for (const text of [
    "hey everyone, welcome to the pocket club",
    "this is a much longer message that should wrap across several lines on a phone so we can see how it behaves when there is plenty to say",
    "short one",
  ]) {
    await page.fill(COMPOSER, text);
    await page.keyboard.press("Enter");
    await settle(page, 250);
  }
  await settle(page, 600);

  // No line of message text runs underneath a message's ⋯ button.
  const covered = await page.evaluate(() =>
    [...document.querySelectorAll(".kc-msg")].flatMap((msg) => {
      const more = msg.querySelector(".kc-msg-more");
      const text = msg.querySelector(".msg-content");
      if (!more || !text) return [];
      const button = more.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(text);
      const under = [...range.getClientRects()].some((line) => line.right > button.left + 0.5 && line.bottom > button.top && line.top < button.bottom);
      return under ? [text.textContent.slice(0, 24)] : [];
    }),
  );
  if (covered.length) throw new Error(`message text runs under the ⋯ button: ${covered.join(" | ")}`);
  const moreCount = await page.locator(".kc-msg-more").count();
  if (moreCount < 3) throw new Error(`expected a ⋯ on each of the 3 messages, found ${moreCount}`);
  log("phone: no message text is hidden under a ⋯ button ✓");

  // Touching a message does not bring up the desktop hover toolbar.
  await page.locator(".kc-msg .msg-content").first().tap();
  await settle(page, 300);
  const hoverBars = await page.evaluate(() =>
    [...document.querySelectorAll(".kc-msg-actions")].filter((el) => {
      const style = getComputedStyle(el);
      return style.display !== "none" && Number(style.opacity) > 0.01;
    }).length,
  );
  if (hoverBars) throw new Error(`${hoverBars} desktop hover toolbar(s) showing on a touch screen`);
  log("phone: no hover toolbar on touch ✓");

  // The ⋯ sheet can add a reaction, and the picker it opens is on screen.
  await page.locator('button[aria-label="Message actions"]').first().tap();
  await page.waitForSelector(".kc-sheet", { timeout: 4000 });
  await page.locator(".kc-sheet button", { hasText: "Add reaction" }).tap();
  await page.waitForSelector(".kc-react-picker", { timeout: 4000 });
  const picker = await page.evaluate(() => {
    const box = document.querySelector(".kc-react-picker").getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, vw: innerWidth, vh: innerHeight };
  });
  if (picker.left < 0 || picker.right > picker.vw || picker.top < 0 || picker.bottom > picker.vh) throw new Error(`the reaction picker is off screen: ${JSON.stringify(picker)}`);
  const emoji = (await page.locator(".kc-react-picker button").first().textContent()).trim();
  await page.locator(".kc-react-picker button").first().tap();
  await page.waitForSelector(".kc-react-picker", { state: "detached", timeout: 4000 });
  await page.waitForFunction((e) => [...document.querySelectorAll(".kc-msg")].some((m) => m.textContent.includes(e)), emoji, { timeout: 4000 });
  log("phone: the ⋯ sheet offers Add reaction and its picker is on screen ✓");

  // The menu button in the header is big enough to hit.
  const toggle = await page.locator('button[aria-label="Open channels"]').first().boundingBox();
  if (toggle.width < MIN_TAP || toggle.height < MIN_TAP) throw new Error(`the header menu button is ${Math.round(toggle.width)}x${Math.round(toggle.height)}`);

  // The drawer: wide enough to read, the rail runs its full height, and the channels
  // (text and voice) are there without scrolling past the checklist.
  await page.locator('button[aria-label="Open channels"]').first().tap();
  await settle(page, 450);
  const drawer = await page.evaluate(() => {
    const vh = innerHeight;
    const nav = document.querySelector(".kc-nav").getBoundingClientRect();
    const rail = document.querySelector(".kc-nav .server-sidebar > div").getBoundingClientRect();
    const inView = (el) => !!el && el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= vh;
    const buttons = [...document.querySelectorAll(".kc-nav button")];
    const byLabel = (start) => buttons.find((b) => (b.getAttribute("aria-label") ?? "").startsWith(start));
    const size = (el) => (el ? `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}` : "missing");
    const invite = byLabel("Invite people");
    return {
      width: Math.round(nav.width),
      scrim: Math.round(innerWidth - nav.right),
      railHeight: Math.round(rail.height),
      vh,
      generalInView: inView(buttons.find((b) => b.textContent.trim() === "general")),
      voiceInView: inView(byLabel("Voice")),
      // The button or the word inside it: either one being clipped counts.
      inviteCut: invite ? [invite, ...invite.querySelectorAll("*")].some((el) => el.scrollWidth > el.clientWidth + 1) || invite.getBoundingClientRect().width < 88 : true,
      createChannel: size(byLabel("Create channel")),
      manageCategories: size(byLabel("Manage categories")),
    };
  });
  if (drawer.width < 300) throw new Error(`the drawer is only ${drawer.width}px wide on a 390px phone`);
  if (drawer.scrim < 44) throw new Error(`only ${drawer.scrim}px left to tap outside the drawer`);
  if (drawer.railHeight < drawer.vh - 2) throw new Error(`the server rail stops at ${drawer.railHeight}px of ${drawer.vh}`);
  if (!drawer.generalInView || !drawer.voiceInView) throw new Error(`channels are below the fold when the drawer opens: ${JSON.stringify(drawer)}`);
  if (drawer.inviteCut) throw new Error("the Invite people button is cut off");
  for (const [name, value] of [["Create channel", drawer.createChannel], ["Manage categories", drawer.manageCategories]]) {
    const [w, h] = value.split("x").map(Number);
    if (!(w >= 36 && h >= 36)) throw new Error(`${name} is ${value}`);
  }
  log(`phone: drawer ${drawer.width}px wide, rail full height, channels in view, buttons hittable ✓`);
  await shot(page, "32-phone-drawer");

  // A dialog never spills past the screen, and its fields do not make an iPhone zoom.
  await page.locator('.kc-nav button[aria-label="Events"]').tap();
  await page.waitForSelector("#kc-events-title", { timeout: 4000 });
  await settle(page, 400);
  const dialog = await page.evaluate(() => {
    const modal = document.querySelector(".kc-modal");
    const vw = innerWidth;
    const controls = [...modal.querySelectorAll("button, input, textarea, select")];
    return {
      right: Math.round(modal.getBoundingClientRect().right),
      vw,
      offEdge: controls.filter((el) => el.getBoundingClientRect().right > vw + 1).map((el) => el.getAttribute("aria-label") || el.textContent.trim() || el.getAttribute("placeholder")),
      smallText: [...modal.querySelectorAll("input, textarea, select")].filter((el) => Number.parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.getAttribute("aria-label") || el.getAttribute("placeholder")),
    };
  });
  if (dialog.right > dialog.vw || dialog.offEdge.length) throw new Error(`the Events dialog spills past the screen: ${JSON.stringify(dialog)}`);
  if (dialog.smallText.length) throw new Error(`fields under 16px make an iPhone zoom: ${dialog.smallText.join(", ")}`);
  log("phone: the Events dialog fits and its fields are 16px ✓");
  await shot(page, "32-phone-dialog");

  console.log("\n✅ PHONE LAYOUT PASSED");
} catch (e) {
  failed = true;
  console.error("\n❌ FAILED:", e.message);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
