import { currentToken, launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Threads. B writes in #general; A starts a thread from B's message and it opens beside the
// channel. B sees "No replies yet" appear under the message without reloading, opens the
// thread from there and replies; A sees the reply in the open thread and the count under the
// message. The thread never shows up as a channel in the sidebar. On a phone the thread takes
// the whole screen and a back button returns to the channel. Screenshots (desktop dark and
// light, phone) are kept on every run.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `tha_${u}`;
const B = `thb_${u}`;
const P = `thp_${u}`;
const COMPOSER = 'textarea[placeholder*="Say something to #general"]';
const REPLY_BOX = 'textarea[placeholder^="Reply in"]';
const PANEL = 'section[aria-label^="Thread:"]';
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
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
}

async function say(page, text) {
  await page.fill(COMPOSER, text);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`.msg-content:has-text("${text}")`, { timeout: 8000 });
}

// On a touch screen Enter starts a new line; Send sends.
async function sayByTap(page, text) {
  await page.fill(COMPOSER, text);
  await page.locator('form.kc-composer-shell button[aria-label="Send message"]').first().tap();
  await page.waitForSelector(`.msg-content:has-text("${text}")`, { timeout: 8000 });
}

function message(page, text) {
  return page.locator(".kc-msg", { has: page.locator(`.msg-content:has-text("${text}")`) }).first();
}

try {
  // ── A and B in one space ──
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Thread Ana", "Thread HQ");
  const tokenA = await currentToken(pageA);
  const space = (await api(tokenA, "/servers")).body.find((s) => s.name === "Thread HQ");
  const code = (await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" })).body.code;

  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Thread Ben", "Ben's place");
  const tokenB = await currentToken(pageB);
  if ((await api(tokenB, `/invites/${code}`, { method: "POST", body: "{}" })).status !== 200) throw new Error("B couldn't join");
  await pageB.click('button[aria-label="Thread HQ"]', { timeout: 12000 });
  await pageB.click('button:has-text("general")');
  await pageB.waitForSelector(COMPOSER, { timeout: 8000 });

  const text = `Who wants pizza tonight ${u}?`;
  await say(pageB, text);
  await message(pageA, text).waitFor({ timeout: 8000 });
  log("B wrote in #general and A sees it");

  // ── A starts a thread from B's message ──
  await message(pageA, text).hover();
  await message(pageA, text).locator('button[aria-label="Start a thread"]').click();
  const nameField = 'input[aria-label="Thread name"]';
  await pageA.waitForSelector(nameField, { timeout: 5000 });
  const suggested = await pageA.inputValue(nameField);
  if (!suggested.startsWith("Who wants pizza")) throw new Error(`the name wasn't taken from the message: "${suggested}"`);
  await pageA.fill(nameField, "Pizza");
  await pageA.click('button:has-text("Start thread")');
  await pageA.waitForSelector(`${PANEL}`, { timeout: 8000 });
  if (!(await pageA.locator(COMPOSER).isVisible())) throw new Error("the channel's message bar went away when the thread opened");
  log("A started a thread and it opened beside the channel ✓");

  // ── B sees it under the message without reloading, opens it and replies ──
  const chipB = message(pageB, text).locator('button[aria-label^="Open thread Pizza"]');
  await chipB.waitFor({ timeout: 8000 });
  if (!(await chipB.innerText()).includes("No replies yet")) throw new Error(`B's chip says "${await chipB.innerText()}"`);
  log("B sees the new thread under the message live ✓");
  await chipB.click();
  await pageB.waitForSelector(`${PANEL} ${REPLY_BOX}`, { timeout: 8000 });
  await pageB.fill(`${PANEL} ${REPLY_BOX}`, "Me! 8pm?");
  await pageB.keyboard.press("Enter");
  await pageB.waitForSelector(`${PANEL} .msg-content:has-text("Me! 8pm?")`, { timeout: 8000 });

  // ── A sees the reply in the open thread, and the count under the message ──
  await pageA.waitForSelector(`${PANEL} .msg-content:has-text("Me! 8pm?")`, { timeout: 8000 });
  const chipA = message(pageA, text).locator('button[aria-label^="Open thread Pizza"]');
  await pageA.waitForFunction(
    (t) => [...document.querySelectorAll('button[aria-label^="Open thread Pizza"]')].some((b) => b.textContent.includes(t)),
    "1 reply",
    { timeout: 8000 }
  );
  log(`A sees B's reply in the thread and "${(await chipA.innerText()).trim()}" under the message ✓`);
  if ((await pageA.locator(".kc-nav button", { hasText: "Pizza" }).count()) > 0) throw new Error("the thread is listed as a channel");
  if ((await api(tokenA, `/servers/${space.id}`)).body.channels.some((c) => c.name === "Pizza")) throw new Error("the space lists the thread as a channel");
  log("the thread isn't a channel in the sidebar ✓");

  // ── The channel's thread list ──
  await pageA.click('button[aria-label="Threads"]');
  await pageA.waitForSelector('[role="dialog"] button:has-text("Pizza")', { timeout: 5000 });
  await pageA.keyboard.press("Escape");
  log("the Threads button lists it ✓");
  await settle(pageA, 300);
  await shot(pageA, "51-threads-desktop-dark");

  // Light theme, to look at.
  await pageA.locator('button[aria-label="Settings"]').first().click();
  await pageA.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await pageA.click('button[aria-label="Use theme: Ohiyo Light"]');
  await pageA.keyboard.press("Escape");
  await settle(pageA, 300);
  await shot(pageA, "51-threads-desktop-light");

  // ── Phone: the thread takes the screen, back returns to the channel ──
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => console.error("  P ERR:", e.message));
  await onboard(phone, P, "Thread Pip", "Pip's place");
  const phoneText = `Phone thread ${u}`;
  await sayByTap(phone, phoneText);
  await message(phone, phoneText).locator('button[aria-label="Message actions"]').tap();
  await phone.locator('button:has-text("Start a thread")').tap();
  await phone.waitForSelector(nameField, { timeout: 5000 });
  await phone.locator('button:has-text("Start thread")').tap();
  await phone.waitForSelector(`${PANEL} ${REPLY_BOX}`, { timeout: 8000 });
  await phone.fill(`${PANEL} ${REPLY_BOX}`, "from my phone");
  await phone.locator(`${PANEL} button[aria-label="Send message"]`).tap();
  await phone.waitForSelector(`${PANEL} .msg-content:has-text("from my phone")`, { timeout: 8000 });
  const box = await phone.locator(PANEL).boundingBox();
  if (!box || box.width < 380) throw new Error(`the thread doesn't fill the phone screen (${box?.width}px wide)`);
  // Let the "Welcome to Pip's place" toast go, so the screenshot shows the reply under it.
  await phone.waitForSelector("text=Welcome to Pip", { state: "detached", timeout: 10000 }).catch(() => {});
  await settle(phone, 250);
  await shot(phone, "51-threads-phone");
  await phone.locator(`${PANEL} button[aria-label="Back to the channel"]`).tap();
  await phone.waitForSelector(PANEL, { state: "detached", timeout: 5000 });
  await phone.waitForSelector(COMPOSER, { timeout: 5000 });
  log("phone: the thread fills the screen and Back returns to the channel ✓");

  console.log("\n✅ THREADS PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
