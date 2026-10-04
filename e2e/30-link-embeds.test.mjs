import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// YouTube links and posts on X play in the chat:
//   1) showing the chat loads no player (only the video's picture, where previews are on);
//   2) pressing play puts YouTube's player in the row, and it KEEPS PLAYING while you type
//      and while new messages arrive (rows used to be rebuilt on every re-render, which
//      restarted the video each time);
//   3) a post on X opens in the row at the height X reports;
//   4) the rows stay tall enough for their cards, open and closed, desktop and phone.
// YouTube and X are never contacted: their hosts are answered here.
const browser = await launchBrowser();
let failed = false;

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s";
const POST = "https://x.com/jack/status/20";
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
// What X's real frame does once the post is drawn: tell the page how tall it is.
const X_FRAME = `<!doctype html><body style="margin:0;background:#15202b;color:#fff">post
<script>parent.postMessage({ "twttr.embed": { jsonrpc: "2.0", method: "twttr.private.resize", id: "embed-0",
  params: [{ width: 480, height: 412, data: { tweet_id: new URLSearchParams(location.search).get("id") } }] } }, "*");</script></body>`;

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const asked = [];
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(youtube\.com|youtube-nocookie\.com|ytimg\.com|twitter\.com|twimg\.com|x\.com)\//, (route) => {
    const url = new URL(route.request().url());
    asked.push(url.hostname + url.pathname);
    if (url.hostname.endsWith("ytimg.com")) return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
    if (url.hostname === "platform.twitter.com") return route.fulfill({ status: 200, contentType: "text/html", body: X_FRAME });
    return route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><body style="margin:0;background:#000;color:#fff">player</body>' });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));

  await register(page, `le_${uniq()}`, "Link Lee");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Link players");
  await page.click('button:has-text("Let\'s go")');
  const composer = page.locator('input[placeholder*="Say something"]');
  await composer.waitFor({ timeout: 12000 });
  const say = async (text) => {
    await composer.fill(text);
    await composer.press("Enter");
  };
  await say(`movie night? ${VIDEO}`);
  await say(`also this ${POST}`);
  await say("ok that's all from me");
  await page.waitForSelector(".kc-embed__poster", { timeout: 8000 });
  await page.waitForSelector(".kc-embed__chip", { timeout: 8000 });

  const rowsFit = (what) =>
    page.waitForFunction(() => [...document.querySelectorAll(".msg-group")].every((row) => {
      const style = getComputedStyle(row);
      const needed = row.firstElementChild.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      return row.getBoundingClientRect().height >= Math.floor(needed);
    }), null, { timeout: 4000 }).catch(() => { throw new Error(`a row is too short for its link card (${what})`); });

  // 1) Nothing plays, and no player is fetched, until it is pressed.
  if (await page.locator("iframe").count()) throw new Error("a player loaded before anyone pressed play");
  const early = asked.filter((u) => !u.startsWith("i.ytimg.com/"));
  if (early.length) throw new Error(`showing the chat contacted: ${early.join(", ")}`);
  await rowsFit("closed");
  log("closed cards: a picture and two buttons, no player, nothing fetched from YouTube or X but the picture ✓");
  await shot(page, "30-link-embeds-closed");

  // 2) Play. The click that loads the player is the click to play, at the linked moment.
  await page.click(".kc-embed__poster");
  const player = page.locator(".kc-embed__stage iframe");
  await player.waitFor({ timeout: 6000 });
  const src = new URL(await player.getAttribute("src"));
  if (src.origin !== "https://www.youtube-nocookie.com" || src.pathname !== "/embed/dQw4w9WgXcQ") throw new Error(`wrong player: ${src}`);
  if (src.searchParams.get("autoplay") !== "1" || src.searchParams.get("start") !== "43") throw new Error(`player should autoplay from 0:43: ${src.search}`);
  log("play: YouTube's no-cookie player, in the row, starting at the linked moment ✓");

  // The same player, not a rebuilt one, after typing and after a new message.
  await player.evaluate((el) => { el.__stillThePlayer = true; });
  await composer.fill("typing while it plays");
  await composer.fill("");
  await say("a new message arrives");
  await page.waitForSelector("text=a new message arrives", { timeout: 6000 });
  const survived = await page.locator(".kc-embed__stage iframe").evaluate((el) => el.__stillThePlayer === true).catch(() => false);
  if (!survived) throw new Error("the player was rebuilt when the chat re-rendered: a playing video would start over");
  log("the video keeps playing while you type and when a new message arrives ✓");

  // 3) The post on X, at the height X's frame reports.
  await page.click(".kc-embed__chip");
  const post = page.locator(".kc-embed--post iframe");
  await post.waitFor({ timeout: 6000 });
  if ((await post.getAttribute("src")) !== "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true&theme=dark") throw new Error("wrong frame for the post");
  await page.waitForFunction(() => Math.round(document.querySelector(".kc-embed--post iframe").getBoundingClientRect().height) === 412, null, { timeout: 6000 })
    .catch(() => { throw new Error("the post did not take the height X reported"); });
  await rowsFit("open");
  log("post on X: opens in the row, sized to the post, rows still fit ✓");
  await shot(page, "30-link-embeds-open");

  // 4) Phone width with both open, then closed again.
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page, 500); // the cards are re-laid out at the new width; let that finish before clicking
  await rowsFit("open, phone");
  await page.click(".kc-embed--post .kc-embed__close");
  await page.waitForSelector(".kc-embed--post", { state: "detached", timeout: 4000 }).catch(() => { throw new Error("Close did not remove the post"); });
  await page.click(".kc-embed--video .kc-embed__close");
  await page.waitForFunction(() => document.querySelectorAll("iframe").length === 0, null, { timeout: 4000 }).catch(async () => {
    const left = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => new URL(f.src).hostname));
    throw new Error(`Close left a player on the page: ${left.join(", ")}`);
  });
  await rowsFit("closed again, phone");
  await page.waitForSelector(".kc-embed__poster", { timeout: 4000 });
  log("close: both players are removed, and the rows fit at phone width too ✓");

  console.log("\n✅ LINK PLAYERS PASSED (click to play · keeps playing · X post sized · rows fit)");
} catch (err) {
  failed = true;
  console.error("\n❌ LINK PLAYERS FAILED:", err?.message ?? err);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
