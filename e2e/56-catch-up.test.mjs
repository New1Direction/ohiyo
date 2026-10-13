import { currentToken, launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Catching up, like Discord.
//   • B posts 30 messages in #random while A is in #general: #random shows 30 unread.
//   • A opens #random: a red "New messages" line sits above B's first message (after A's own
//     earlier ones), and the bar says "30 new messages since …". Jump brings the line into
//     view; Mark as read clears the bar and the line.
//   • B posts in #general; A uses the space menu's "Mark space as read": the number goes, and
//     stays gone after a reload (the server has it).
//   • B posts again; right-clicking #general → Mark as read clears it.
//   • A half-writes a message in #random and leaves: #random shows a draft pencil.
//   • The line and the bar, to look at: desktop dark and light, and a phone.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `cua_${u}`;
const B = `cub_${u}`;
const browser = await launchBrowser();
let failed = false;

const api = async (token, path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
}

const row = (page, name) => page.locator(".channel-sidebar .kc-channel-row", { hasText: name }).first();
const line = (page) => page.locator('[role="separator"][aria-label="New messages"]');
const bar = (page) => page.locator(".kc-unread-bar");

async function openChannel(page, name) {
  await row(page, name).click();
  await page.waitForSelector(`textarea[placeholder*="Say something to #${name}"]`, { timeout: 10000 });
}

// The line is on screen inside the message list, and nothing (the bar) covers it.
async function lineInView(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[role="separator"][aria-label="New messages"]');
    const list = el?.closest(".kc-touch-scroll");
    if (!el || !list) return false;
    const a = el.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    if (!(a.top >= b.top && a.bottom <= b.bottom)) return false;
    const onTop = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
    return Boolean(onTop && el.contains(onTop));
  });
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Cua", "Cu HQ");
  const tokenA = await currentToken(pageA);

  const ctxB = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Cub", "Cub HQ");
  const tokenB = await currentToken(pageB);
  await ctxB.close();

  const space = (await api(tokenA, "/servers")).body.find((s) => s.name === "Cu HQ");
  const general = space.channels.find((c) => c.name === "general");
  const random = await api(tokenA, `/servers/${space.id}/channels`, { method: "POST", body: JSON.stringify({ name: "random" }) });
  if (random.status !== 200) throw new Error(`A couldn't make #random (${random.status})`);
  const randomId = random.body.id;
  const invite = await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" });
  if ((await api(tokenB, `/invites/${invite.body.code}`, { method: "POST", body: "{}" })).status !== 200) throw new Error("B couldn't join");
  // The server allows 30 messages per 10 seconds per person: past that, wait for it.
  const say = async (token, channelId, content) => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const res = await api(token, `/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
      if (res.status === 200) return res;
      if (res.status !== 429) throw new Error(`couldn't post "${content}" (${res.status})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`still too fast to post "${content}"`);
  };
  await say(tokenA, randomId, `mine-1-${u}`);
  await say(tokenA, randomId, `mine-2-${u}`);
  log("A's space has #general and #random; A wrote twice in #random; B joined");

  // ── 30 new messages while A is elsewhere ──
  await pageA.reload();
  await pageA.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
  for (let i = 1; i <= 30; i += 1) await say(tokenB, randomId, `catchup-${String(i).padStart(2, "0")}-${u}`);
  await row(pageA, "random").locator('[aria-label="30 unread"]').waitFor({ timeout: 10000 });
  log("#random shows 30 unread ✓");

  await openChannel(pageA, "random");
  await pageA.waitForSelector(`text=catchup-30-${u}`, { timeout: 10000 });
  await bar(pageA).waitFor({ timeout: 6000 });
  const barText = (await bar(pageA).textContent()) ?? "";
  if (!/30 new messages since /.test(barText)) throw new Error(`the bar reads "${barText}"`);
  log(`the bar reads "${barText.replace(/JumpMark as read/, "").trim()}" ✓`);

  await bar(pageA).locator('button:has-text("Jump")').click();
  await line(pageA).waitFor({ timeout: 6000 });
  await settle(pageA, 400);
  if (!(await lineInView(pageA))) throw new Error("Jump didn't bring the New messages line into view, uncovered");
  const order = await pageA.evaluate(({ first, mine }) => {
    const sep = document.querySelector('[role="separator"][aria-label="New messages"]');
    const find = (text) => [...document.querySelectorAll("[data-message-id]")].find((el) => el.textContent?.includes(text));
    const firstUnread = find(first);
    const mineEl = find(mine);
    const after = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { lineBeforeFirst: after(sep, firstUnread), mineBeforeLine: after(mineEl, sep) };
  }, { first: `catchup-01-${u}`, mine: `mine-2-${u}` });
  if (!order.lineBeforeFirst) throw new Error("the line isn't above B's first new message");
  if (!order.mineBeforeLine) throw new Error("A's own earlier message isn't above the line");
  log("Jump shows the line, between A's own messages and B's first new one ✓");
  await shot(pageA, "56-catch-up-desktop-dark");

  await bar(pageA).locator('button:has-text("Mark as read")').click();
  await line(pageA).waitFor({ state: "detached", timeout: 4000 });
  if (await bar(pageA).count()) throw new Error("the bar stayed after Mark as read");
  log("Mark as read clears the bar and the line ✓");

  // ── Mark space as read ──
  await say(tokenB, general.id, `g1-${u}`);
  await say(tokenB, general.id, `g2-${u}`);
  await row(pageA, "general").locator('[aria-label="2 unread"]').waitFor({ timeout: 8000 });
  await pageA.click('.channel-sidebar button[aria-haspopup="menu"]');
  await pageA.click('.channel-sidebar [role="menuitem"]:has-text("Mark space as read")');
  await row(pageA, "general").locator('[aria-label$="unread"]').waitFor({ state: "detached", timeout: 6000 });
  await pageA.reload();
  await pageA.waitForSelector("textarea", { timeout: 12000 });
  await settle(pageA, 800);
  if (await row(pageA, "general").locator('[aria-label$="unread"]').count()) throw new Error("#general is unread again after a reload");
  log("Mark space as read clears #general, and it stays read after a reload ✓");

  // ── Right-click → Mark as read ──
  await openChannel(pageA, "random");
  await say(tokenB, general.id, `g3-${u}`);
  await row(pageA, "general").locator('[aria-label="1 unread"]').waitFor({ timeout: 8000 });
  await row(pageA, "general").click({ button: "right" });
  await pageA.click('[role="menu"][aria-label="general"] [role="menuitem"]:has-text("Mark as read")');
  await row(pageA, "general").locator('[aria-label$="unread"]').waitFor({ state: "detached", timeout: 6000 });
  log("right-click → Mark as read clears #general ✓");

  // ── A draft leaves a pencil ──
  await pageA.fill('textarea[placeholder*="Say something to #random"]', `half a thought ${u}`);
  await openChannel(pageA, "general");
  await row(pageA, "random").locator('[aria-label="Draft"]').waitFor({ timeout: 4000 });
  log("a half-written message leaves a pencil on #random ✓");

  // ── To look at: light theme, then a phone ──
  for (let i = 1; i <= 6; i += 1) await say(tokenB, randomId, `again-${i}-${u}`);
  await row(pageA, "random").locator('[aria-label="6 unread"]').waitFor({ timeout: 8000 });
  await pageA.locator('button[aria-label="Settings"]').first().click();
  await pageA.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await pageA.click('button[aria-label="Use theme: Ohiyo Light"]');
  await pageA.keyboard.press("Escape");
  await settle(pageA, 300);
  await openChannel(pageA, "random");
  await bar(pageA).locator('button:has-text("Jump")').click();
  await line(pageA).waitFor({ timeout: 6000 });
  await settle(pageA, 400);
  if (!(await lineInView(pageA))) throw new Error("light theme: Jump didn't bring the line into view, uncovered");
  await pageA.waitForSelector(".ohiyo-toast", { state: "detached", timeout: 12000 }).catch(() => {});
  await shot(pageA, "56-catch-up-desktop-light");

  await say(tokenB, general.id, `phone-${u}`);
  await pageA.setViewportSize({ width: 390, height: 844 });
  await settle(pageA, 400);
  await pageA.locator('button[aria-label="Open channels"]').first().click();
  await settle(pageA, 400);
  await pageA.locator(".kc-nav .kc-channel-row", { hasText: "general" }).first().click();
  await pageA.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 10000 });
  await line(pageA).waitFor({ timeout: 6000 });
  await pageA.waitForSelector(".ohiyo-toast", { state: "detached", timeout: 12000 }).catch(() => {});
  await pageA.mouse.move(380, 600); // no message's hover toolbar in the picture
  await settle(pageA, 300);
  const look = await pageA.evaluate(() => {
    const list = document.querySelector(".kc-touch-scroll");
    return {
      pill: Boolean(document.querySelector(".kc-jump-bottom")),
      bar: Boolean(document.querySelector(".kc-unread-bar")),
      scroll: list ? [list.scrollTop, list.scrollHeight, list.clientHeight] : null,
    };
  });
  if (!look.bar) throw new Error("the bar isn't shown on a phone");
  // The whole line fits (wrapped if need be): "1 new message since 3:12 AM", not "since …".
  const cut = await bar(pageA).locator(".kc-unread-bar__text").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (cut) throw new Error("the bar's words are cut off on a phone");
  // The "Jump to present" pill is for reading history; a chat that fits the screen has none.
  if (look.pill && look.scroll && look.scroll[1] <= look.scroll[2]) {
    throw new Error(`the jump pill shows though the whole chat fits the screen: ${JSON.stringify(look)}`);
  }
  const overflow = await pageA.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error("the page scrolls sideways on a phone");
  await shot(pageA, "56-catch-up-phone");
  log("the line and the bar look right in light, and fit a phone ✓");

  console.log("\n✅ CATCH UP PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
