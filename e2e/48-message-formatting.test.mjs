import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Formatting like Discord. Shift+Enter starts a new line in the message box (Enter still
// sends), and a message drawn from Discord's markdown shows headings, quotes, lists, code,
// masked links and timestamps. The row is sized for what is drawn: nothing overlaps the
// message after it.
const browser = await launchBrowser();
let failed = false;
const COMPOSER = 'textarea[placeholder*="Say something"]';

const LINES = [
  "# Release notes",
  "-# posted by the bot",
  "> **Bold** move, *italic* thought, __underlined__ and ~~struck~~",
  "> with `inline code` and ||a spoiler||",
  "- first",
  "- second",
  "  - nested",
  "1. one",
  "2. two",
  "Read [the docs](https://ohiyo.gg) or [paypal.com](https://example.com/login), at <t:1700000000:F> (<t:1700000000:R>)",
  "```js",
  "const ok = true;",
  "```",
  "after the code",
];

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `md_${uniq()}`, "Formatter");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Formatting");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });

  // Shift+Enter makes a new line and sends nothing.
  await page.click(COMPOSER);
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  const typed = await page.inputValue(COMPOSER);
  if (typed !== "line one\nline two") throw new Error(`Shift+Enter didn't start a new line: ${JSON.stringify(typed)}`);
  const grown = await page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().height, COMPOSER);
  await page.press(COMPOSER, "Enter");
  // A <br> has no box of its own, so it is never "visible": wait for it to be there.
  await page.waitForSelector('[data-message-id]:not([data-message-id^="temp-"]) .msg-content br', { state: "attached", timeout: 8000 });
  const after = await page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().height, COMPOSER);
  if (!(grown > after)) throw new Error(`the message box didn't grow for two lines (${grown}px) or shrink back (${after}px)`);
  log("Shift+Enter starts a new line, the box grows with it, Enter sends ✓");

  // A message using every kind of formatting.
  await page.fill(COMPOSER, LINES.join("\n"));
  await page.press(COMPOSER, "Enter");
  const msg = page.locator('[data-message-id]:not([data-message-id^="temp-"])', { has: page.locator("h1.kc-md-heading") }).last();
  await msg.waitFor({ timeout: 8000 });
  await settle(page, 400);

  const seen = await msg.evaluate((el) => ({
    h1: el.querySelector("h1.kc-md-h1")?.textContent,
    subtext: el.querySelector("small.kc-md-subtext")?.textContent,
    quote: el.querySelector("blockquote.kc-md-quote strong")?.textContent,
    spoiler: Boolean(el.querySelector("blockquote [data-spoiler]")),
    nested: el.querySelectorAll("ul.kc-md-list ul.kc-md-list li").length,
    ordered: el.querySelectorAll("ol.kc-md-list > li").length,
    link: el.querySelector('a.kc-md-link[href="https://ohiyo.gg/"]')?.textContent,
    host: el.querySelector(".kc-md-link-host")?.textContent,
    times: el.querySelectorAll("time.kc-md-time").length,
    code: el.querySelector('pre.code-block[data-lang="js"]')?.textContent,
    after: el.textContent.includes("after the code"),
  }));
  const want = { h1: "Release notes", subtext: "posted by the bot", quote: "Bold", spoiler: true, nested: 1, ordered: 2, link: "the docs", host: " (example.com)", times: 2, code: "const ok = true;", after: true };
  for (const [k, v] of Object.entries(want)) {
    if (seen[k] !== v) throw new Error(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(seen[k])}`);
  }
  log("headings, subtext, quotes, lists, code, masked links and timestamps all draw ✓");

  // The row is sized for what is drawn: the message after it doesn't overlap it.
  await page.fill(COMPOSER, "the next message");
  await page.press(COMPOSER, "Enter");
  const next = page.locator('[data-message-id]:not([data-message-id^="temp-"])', { hasText: "the next message" }).last();
  await next.waitFor({ timeout: 8000 });
  await settle(page, 400);
  const overlap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-message-id]:not([data-message-id^="temp-"])')];
    const big = rows.find((r) => r.querySelector("h1.kc-md-heading"));
    const nxt = rows.find((r) => r.textContent.includes("the next message"));
    if (!big || !nxt) return null;
    return Math.round(big.getBoundingClientRect().bottom - nxt.getBoundingClientRect().top);
  });
  if (overlap === null) throw new Error("couldn't find both messages");
  if (overlap > 1) throw new Error(`the formatted message runs ${overlap}px into the next one`);
  log(`the next message starts below the formatted one (${-overlap}px clear) ✓`);
  await msg.scrollIntoViewIfNeeded();
  await shot(page, "48-message-formatting-dark");

  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.keyboard.press("Escape");
  await settle(page, 400);
  await msg.scrollIntoViewIfNeeded();
  await shot(page, "48-message-formatting-light");
  await ctx.close();

  console.log("\n✅ MESSAGE FORMATTING PASSED (Shift+Enter · headings · quotes · lists · code · links · timestamps · row height)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
