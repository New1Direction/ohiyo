import { launchBrowser, ORIGIN, SHOTS } from "./harness.mjs";
const URL = ORIGIN;

const uniq = Date.now().toString(36).slice(-6);
const PASS = "supersecret123";
const log = (...a) => console.log("•", ...a);
const settle = (p, ms = 300) => p.waitForTimeout(ms);

async function shot(page, name) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  await settle(page, 200);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function register(page, username, displayName) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Create an account", { timeout: 10000 });
  await page.click("text=Create an account");
  await page.waitForSelector("text=Join Ohiyo");
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[autocomplete="nickname"]', displayName);
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Create my account")');
}

const browser = await launchBrowser();
let failed = false;
try {
  const A = `ada_${uniq}`, B = `ben_${uniq}`;
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));

  // A: register + create server, grab invite link
  await register(pageA, A, "Ada");
  await pageA.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Vibe HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  await pageA.click('button[aria-label="Invite people"]');
  await pageA.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 6000 });
  const link = await pageA.inputValue('input[aria-label="Invite link"]');
  await pageA.keyboard.press("Escape");
  log("A created Vibe HQ");

  // B: join via link
  await pageB.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(() => localStorage.clear());
  await pageB.goto(link, { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("text=Create an account", { timeout: 8000 });
  await pageB.click("text=Create an account");
  await pageB.fill('input[autocomplete="username"]', B);
  await pageB.fill('input[autocomplete="nickname"]', "Ben");
  await pageB.fill("#kc-password", PASS);
  await pageB.click('button:has-text("Create my account")');
  await pageB.waitForSelector('button:has-text("Accept invite")', { timeout: 12000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("B joined Vibe HQ, both in #general");

  // ── 1. TYPING INDICATOR ──────────────────────────────────────────
  await pageA.locator('input[placeholder*="Say something"]').fill("hey ben checking typing");
  await pageB.waitForSelector("text=/is typing/", { timeout: 6000 });
  const typingText = await pageB.textContent("text=/is typing/");
  log(`B sees typing: "${typingText.trim()}" ✓`);
  await shot(pageB, "16-typing");
  await pageA.locator('input[placeholder*="Say something"]').fill(""); // cancel, don't send

  // ── 2. REPLIES ───────────────────────────────────────────────────
  await pageB.locator('input[placeholder*="Say something"]').fill("original msg from ben");
  await pageB.locator('input[placeholder*="Say something"]').press("Enter");
  await pageA.waitForSelector("text=original msg from ben", { timeout: 8000 });
  // A clicks Reply on Ben's message
  const benMsg = pageA.locator(".msg-group", { hasText: "original msg from ben" });
  await benMsg.hover();
  await benMsg.getByRole("button", { name: "Reply" }).first().click();
  await pageA.waitForSelector("text=/Replying to/", { timeout: 4000 });
  log("A: reply chip shows ✓");
  await shot(pageA, "17-reply-compose");
  await pageA.locator('input[placeholder*="Reply to"]').fill("haha good one");
  await pageA.locator('input[placeholder*="Reply to"]').press("Enter");
  // A's own reply should render with a quote of the original
  await pageA.waitForSelector("text=haha good one", { timeout: 8000 });
  // B receives the reply WITH the quote
  await pageB.waitForSelector("text=haha good one", { timeout: 8000 });
  const bReplyGroup = pageB.locator(".msg-group", { hasText: "haha good one" });
  const quoteText = await bReplyGroup.textContent();
  if (!/original msg from ben/.test(quoteText)) throw new Error("reply quote not shown on B side");
  log("B sees reply with quoted original ✓");
  await shot(pageB, "18-reply-rendered");

  // ── 3. UNREAD BADGES ─────────────────────────────────────────────
  // A creates a second channel and switches to it
  await pageA.click('button[aria-label="Create channel"]');
  await pageA.fill('input[placeholder="new-channel"]', "random");
  await pageA.locator('input[placeholder="new-channel"]').press("Enter");
  await pageA.waitForSelector('button:has-text("random")', { timeout: 6000 });
  await pageA.click('button:has-text("random")');
  await pageA.waitForSelector('input[placeholder*="Say something to #random"]', { timeout: 6000 });
  log("A switched to #random");
  // B posts to #general while A is viewing #random
  await pageB.locator('input[placeholder*="Say something"]').fill("ping while you're away");
  await pageB.locator('input[placeholder*="Say something"]').press("Enter");
  // A should get an unread badge on #general (lowercase text channel + a digit)
  await pageA.waitForFunction(() => {
    const btns = [...document.querySelectorAll("button")];
    return btns.some((b) => (b.textContent || "").trim().startsWith("general") && /\d/.test(b.textContent || ""));
  }, { timeout: 8000 });
  log("A sees unread badge on #general ✓");
  await shot(pageA, "19-unread");
  // Opening it clears the badge
  await pageA.click('button:has-text("general")');
  await pageA.waitForSelector("text=ping while you're away", { timeout: 6000 });
  await pageA.waitForFunction(() => {
    const btns = [...document.querySelectorAll("button")];
    const g = btns.find((b) => (b.textContent || "").trim().startsWith("general"));
    return g && !/\d/.test(g.textContent || "");
  }, { timeout: 6000 });
  log("A: badge cleared after opening #general ✓");

  // ── 4. CUSTOM STATUS ─────────────────────────────────────────────
  await pageA.click('button[title="Set a custom status"]');
  await pageA.fill('input[placeholder*="vibe"]', "gaming 🎮");
  await pageA.locator('input[placeholder*="vibe"]').press("Enter");
  await pageA.waitForSelector("text=gaming 🎮", { timeout: 6000 });
  log("A: custom status set ✓");
  await shot(pageA, "20-status");
  // Persists across reload
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.waitForSelector("text=gaming 🎮", { timeout: 12000 });
  log("A: status persists across reload ✓");

  console.log("\n✅ ALIVE & EXPRESSIVE FLOW PASSED (typing · replies · unread · status)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
  try { await (await browser.contexts())[0].pages()[0].screenshot({ path: `${SHOTS}/ALIVE-FAIL.png` }); } catch {}
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
