import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// The message bar is one flat surface, like the rest of the app: "+" on the left, the text,
// then the emoji button and Send on the right, all inside the same bar. The text field has no
// box of its own and focus doesn't draw a bright ring around it. With a mouse, Send shows only
// when there is something to send (Enter sends); on a touch screen it is always there.
const browser = await launchBrowser();
let failed = false;
const COMPOSER = 'textarea[placeholder*="Say something"]';
const SEND = 'form.kc-composer-shell button[aria-label="Send message"]';

async function onboard(page, who, space) {
  await register(page, `mb_${who}_${uniq()}`, who);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
}

// The bar's parts in document order, and how each draws itself at rest.
const readBar = (page) =>
  page.evaluate(() => {
    const form = document.querySelector("form.kc-composer-shell");
    const input = form?.querySelector('textarea[placeholder*="Say something"]');
    const add = form?.querySelector('button[aria-label="Add to your message"], button[aria-label="Attach a file"]');
    const emoji = form?.querySelector('button[aria-label="Emoji and GIFs"]');
    const send = form?.querySelector('button[aria-label="Send message"]');
    const order = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const look = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        border: [s.borderTopWidth, s.borderTopStyle].join(" "),
        borderColor: s.borderTopColor,
        shadow: s.boxShadow,
        outline: s.outlineStyle,
      };
    };
    return {
      found: { add: Boolean(add), input: Boolean(input), emoji: Boolean(emoji), send: Boolean(send) },
      addBeforeText: order(add, input),
      emojiAfterText: order(input, emoji),
      sendAfterEmoji: order(emoji, send),
      input: look(input),
      add: look(add),
      emoji: look(emoji),
      bar: look(form),
    };
  });

const transparent = (c) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
const sendShown = (page) => page.locator(SEND).isVisible();

try {
  // ── With a mouse ──
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(page, "Desk", "Flat Bar");
  if (!(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches))) throw new Error("the desktop browser is not reporting a mouse");

  const bar = await readBar(page);
  if (!bar.found.add || !bar.found.input || !bar.found.emoji) throw new Error(`the bar is missing a part: ${JSON.stringify(bar.found)}`);
  if (!bar.addBeforeText) throw new Error("the + button is not before the text");
  if (!bar.emojiAfterText) throw new Error("the emoji button is not after the text, on the right of the bar");
  log("one bar: + on the left, the text, then emoji on the right ✓");

  // Flat: the text field and the icon buttons draw nothing of their own.
  if (!transparent(bar.input.background) || bar.input.backgroundImage !== "none") throw new Error(`the text field has its own background: ${JSON.stringify(bar.input)}`);
  if (!bar.input.border.startsWith("0px") && !bar.input.border.endsWith("none")) throw new Error(`the text field has its own border: ${bar.input.border}`);
  if (bar.input.shadow !== "none") throw new Error(`the text field has its own shadow: ${bar.input.shadow}`);
  for (const name of ["add", "emoji"]) {
    if (!transparent(bar[name].background) || bar[name].backgroundImage !== "none") throw new Error(`the ${name} button has a background of its own: ${JSON.stringify(bar[name])}`);
  }
  log("the text and the icons sit flat on the bar, with no boxes of their own ✓");

  // Focus: no ring around the text; the bar itself shows it, calmly. (A chat can open with
  // the message box already focused, so start from nothing focused.)
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await settle(page, 250);
  const before = (await readBar(page)).bar;
  await page.click(COMPOSER);
  await settle(page, 250);
  const focused = await readBar(page);
  if (focused.input.shadow !== "none" || focused.input.outline !== "none") throw new Error(`focus draws a ring around the text: ${JSON.stringify(focused.input)}`);
  if (JSON.stringify(focused.bar) === JSON.stringify(before)) throw new Error("nothing shows that the message bar has focus");
  log("focus: no ring around the text; the bar shows it ✓");

  // Send appears only when there is something to send.
  if (await sendShown(page)) throw new Error("Send shows on an empty message with a mouse");
  await shot(page, "44-message-bar-desktop-empty");
  await page.fill(COMPOSER, "flat bars are nicer");
  await settle(page, 150);
  if (!(await sendShown(page))) throw new Error("Send doesn't show once there is text");
  const typed = await readBar(page);
  if (!typed.sendAfterEmoji) throw new Error("Send is not after the emoji button");
  const heights = await page.evaluate(() => Math.round(document.querySelector("form.kc-composer-shell").getBoundingClientRect().height));
  await shot(page, "44-message-bar-desktop-typed");
  await page.press(COMPOSER, "Enter");
  await page.waitForSelector('[data-message-id]:not([data-message-id^="temp-"]) >> text=flat bars are nicer', { timeout: 8000 });
  await settle(page, 200);
  if (await sendShown(page)) throw new Error("Send stays after the message went");
  const emptyHeight = await page.evaluate(() => Math.round(document.querySelector("form.kc-composer-shell").getBoundingClientRect().height));
  if (emptyHeight !== heights) throw new Error(`the bar changes height when Send appears: ${emptyHeight}px empty, ${heights}px with text`);
  log("with a mouse, Send shows only when there is something to send, Enter sends, and the bar keeps its height ✓");

  // A light theme, to look at.
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator('.kc-settings-nav button', { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.keyboard.press("Escape");
  await settle(page, 300);
  await page.fill(COMPOSER, "and in the light");
  await shot(page, "44-message-bar-desktop-light");
  await page.fill(COMPOSER, "");

  // ── On a touch screen ──
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(phone, "Pocket", "Flat Phone");
  const cdp = await phoneCtx.newCDPSession(phone);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await settle(phone, 200);
  if (!(await phone.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches))) throw new Error("the test browser is not reporting a touch screen");
  if (!(await sendShown(phone))) throw new Error("Send is missing on a touch screen with nothing typed");
  const taps = await phone.evaluate(() =>
    [...document.querySelectorAll("form.kc-composer-shell button")]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ name: b.getAttribute("aria-label"), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })),
  );
  const small = taps.filter((t) => t.w < 44 || t.h < 44);
  if (small.length) throw new Error(`message bar buttons smaller than 44px on a phone: ${JSON.stringify(small)}`);
  await shot(phone, "44-message-bar-phone-empty");
  await phone.fill(COMPOSER, "from my phone");
  await shot(phone, "44-message-bar-phone-typed");
  log("on a touch screen, Send is always there and every bar button is at least 44px ✓");

  // A phone has no Shift key: Enter starts a new line there, and Send sends.
  await phone.fill(COMPOSER, `first line ${uniq()}`);
  const firstLine = await phone.inputValue(COMPOSER);
  await phone.press(COMPOSER, "Enter");
  await settle(phone, 300);
  const afterEnter = await phone.inputValue(COMPOSER);
  if (afterEnter !== `${firstLine}\n`) throw new Error(`Enter on a phone didn't start a new line: ${JSON.stringify(afterEnter)}`);
  if (await phone.locator(`.msg-content:has-text("${firstLine}")`).count()) throw new Error("Enter on a phone sent the message");
  await phone.locator(COMPOSER).pressSequentially("second line");
  await phone.locator(SEND).tap();
  await phone.waitForSelector(`.msg-content:has-text("${firstLine}")`, { timeout: 8000 });
  const sent = await phone.locator(`.msg-content:has-text("${firstLine}")`).first().innerText();
  if (!/first line [^\n]*\n\s*second line/.test(sent)) throw new Error(`the two lines didn't arrive as two lines: ${JSON.stringify(sent)}`);
  log("on a touch screen, Enter starts a new line and Send sends both lines ✓");

  console.log("\n✅ MESSAGE BAR PASSED (one flat bar · focus · Send when there's something to send · phone)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
