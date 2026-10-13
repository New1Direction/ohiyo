import { currentToken, launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Search like Discord. Someone else posts a link in #general, then the channel moves on by
// 59 messages, so the link is no longer among the 50 the app loads. Searching
// `from:<them> has:link` finds exactly that message, and Jump opens #general at it: the app
// pages back until the message is there, scrolls to it and marks it. While typing, from:
// offers the space's people. Screenshots (suggestions, results in dark and light, and the
// sheet on a phone) are kept on every run.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const PASS = "supersecret123";
const u = uniq();
const A = `sra_${u}`;
const B = `srb_${u}`;
const COMPOSER = 'textarea[placeholder*="Say something to #general"]';
const BOX = 'input[aria-label="Search messages"]';
const browser = await launchBrowser();
let failed = false;

const call = async (token, path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} gave ${res.status}: ${JSON.stringify(body)}`);
  return body;
};
const send = (token, channel, content) => call(token, `/channels/${channel}/messages`, { method: "POST", body: JSON.stringify({ content }) });

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, A, "Searcher");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Search HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
  const tokenA = await currentToken(page);
  const space = (await call(tokenA, "/servers")).find((s) => s.name === "Search HQ");
  const general = space.channels.find((c) => c.channel_type === "text").id;

  // ── Someone else joins and posts a link; the channel then moves on by 59 messages ──
  const b = await call(null, "/auth/register", { method: "POST", body: JSON.stringify({ username: B, password: PASS, display_name: "Link Poster" }) });
  const invite = await call(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" });
  await call(b.token, `/invites/${invite.code}`, { method: "POST", body: "{}" });
  const target = await send(b.token, general, `deploy notes https://example.com/${u}`);
  for (let i = 0; i < 29; i += 1) await send(b.token, general, `filler from b ${i}`);
  for (let i = 0; i < 30; i += 1) await send(tokenA, general, `filler from a ${i}`);
  log("B posted a link, then 59 more messages followed it");
  // They arrived live while #general was open; a reload loads only the latest 50.
  await page.reload();
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
  await page.waitForSelector(".msg-content:has-text('filler from a 29')", { timeout: 15000 });
  if (await page.locator(`[data-message-id="${target.id}"]`).count()) throw new Error("the link is still among the loaded messages; the test proves nothing");

  // ── from: offers the space's people ──
  await page.click('button[aria-label="Open search"]');
  await page.waitForSelector(BOX, { timeout: 5000 });
  await page.fill(BOX, "from:");
  await page.waitForSelector('[role="option"]:has-text("Link Poster")', { timeout: 5000 });
  log("from: offers the people in the space ✓");
  await settle(page, 200);
  await shot(page, "54-search-suggestions-dark");

  // ── from:<B> has:link finds exactly the link ──
  await page.fill(BOX, `from:${B} has:link`);
  await page.keyboard.press("Escape"); // close the suggestions; the sheet stays open
  await page.waitForSelector(".kc-search-result", { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll(".kc-search-result").length === 1, undefined, { timeout: 8000 });
  const result = await page.locator(".kc-search-result").first().innerText();
  if (!result.includes(`https://example.com/${u}`)) throw new Error(`the result isn't the link: ${result}`);
  log("from:B has:link finds exactly the link ✓");
  await settle(page, 200);
  await shot(page, "54-search-results-dark");

  // ── Jump opens #general at the message, though it was beyond the loaded page ──
  await page.locator(".kc-search-result button:has-text('Jump')").first().click();
  await page.waitForSelector(BOX, { state: "detached", timeout: 5000 });
  const row = page.locator(`[data-message-id="${target.id}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForSelector(`[data-message-id="${target.id}"].kc-msg-flash`, { timeout: 5000 });
  const box = await row.boundingBox();
  const view = page.viewportSize();
  if (!box || box.y < 0 || box.y + box.height > view.height) throw new Error(`the message isn't on screen: ${JSON.stringify(box)}`);
  log("Jump paged back, scrolled to the message and marked it ✓");

  // ── The same results in a light theme ──
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.keyboard.press("Escape");
  // Let the "theme applied" notice go, so it doesn't cover the sheet in the screenshots.
  await page.waitForSelector("text=Ohiyo Light\" applied", { state: "detached", timeout: 10000 }).catch(() => {});
  await settle(page, 300);
  await page.click('button[aria-label="Open search"]');
  await page.fill(BOX, `from:${B} has:link`);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".kc-search-result", { timeout: 8000 });
  await settle(page, 250);
  await shot(page, "54-search-results-light");

  // ── On a phone the sheet fills the screen and nothing spills sideways ──
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page, 400);
  const spill = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (spill > 1) throw new Error(`the page scrolls sideways by ${spill}px on a phone`);
  await shot(page, "54-search-phone");
  log("the sheet fits a phone ✓");

  console.log("\n✅ SEARCH PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
