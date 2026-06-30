import { launchBrowser, ORIGIN, PASS, SHOTS, log, uniq } from "./harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VIDEO_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mobile-video.mp4");
const u = uniq();
const A = `moba_${u}`;
const B = `mobb_${u}`;

async function shot(page, name) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function assertNoHorizontalOverflow(page, label) {
  const info = await page.evaluate(() => {
    const vw = window.innerWidth;
    const doc = document.documentElement;
    const body = document.body;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => !el.closest(".kc-nav:not(.is-open)"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, cls: el.className || "", left: r.left, right: r.right, width: r.width };
      })
      .filter((r) => r.width > 1 && (r.left < -2 || r.right > vw + 2))
      .slice(0, 8);
    return {
      vw,
      docScrollWidth: doc.scrollWidth,
      bodyScrollWidth: body.scrollWidth,
      offenders,
    };
  });
  if (info.docScrollWidth > info.vw + 2 || info.bodyScrollWidth > info.vw + 2 || info.offenders.length) {
    throw new Error(`${label}: horizontal overflow ${JSON.stringify(info)}`);
  }
}

async function registerFromAuth(page, username, displayName) {
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.click("text=Create an account");
  await page.waitForSelector("text=Join Ohiyo", { timeout: 8000 });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[autocomplete="nickname"]', displayName);
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Create my account")');
}

async function createFirstSpace(page, name) {
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", name);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

async function openMobileNav(page) {
  const menu = page.locator('button[aria-label="Open channels"]').first();
  await menu.waitFor({ state: "visible", timeout: 8000 });
  await menu.click();
  await page.waitForSelector(".kc-nav-scrim", { timeout: 5000 });
}

async function createInviteOnMobile(page) {
  await openMobileNav(page);
  await page.click('button[aria-label="Invite people"]');
  await page.waitForSelector('input[aria-label="Invite link"]', { timeout: 8000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 8000 });
  const invite = await page.inputValue('input[aria-label="Invite link"]');
  await page.keyboard.press("Escape");
  await page.waitForSelector('input[aria-label="Invite link"]', { state: "detached", timeout: 5000 }).catch(() => {});
  return invite;
}

async function assertMobileChatUsable(page, label) {
  await page.waitForSelector('input[placeholder*="Say something"]', { state: "visible", timeout: 8000 });
  await assertNoHorizontalOverflow(page, label);
  const composer = await page.locator(".kc-composer-shell").first().boundingBox();
  if (!composer || composer.width < 300 || composer.width > 392 || composer.height > 72) {
    throw new Error(`${label}: composer wrong size ${JSON.stringify(composer)}`);
  }
}

const browser = await launchBrowser();
let failed = false;
try {
  const iphone = { width: 390, height: 844 };
  const ctxA = await browser.newContext({ viewport: iphone, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const ctxB = await browser.newContext({ viewport: iphone, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  for (const [label, page] of [["A", pageA], ["B", pageB]]) {
    page.on("pageerror", (e) => console.error(`  ${label} PAGEERROR:`, e.message));
    page.on("console", (m) => { if (m.type() === "error") console.error(`  ${label} console.error:`, m.text()); });
  }

  await pageA.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageA.evaluate(() => localStorage.clear());
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await registerFromAuth(pageA, A, "Ava");
  await createFirstSpace(pageA, "Mobile HQ");
  await assertMobileChatUsable(pageA, "owner mobile chat after onboarding");
  await shot(pageA, "28-mobile-owner-chat");
  log("mobile owner signup/onboarding lands in usable chat ✓");

  const invite = await createInviteOnMobile(pageA);
  if (!invite.includes("invite=")) throw new Error(`bad invite URL: ${invite}`);
  await assertNoHorizontalOverflow(pageA, "owner mobile invite modal close");
  log("mobile owner can open drawer and create invite ✓");

  await pageB.goto(invite, { waitUntil: "domcontentloaded" });
  await registerFromAuth(pageB, B, "Ben");
  await pageB.waitForSelector("text=You're invited to", { timeout: 12000 });
  await assertNoHorizontalOverflow(pageB, "friend mobile invite accept screen");
  await pageB.click('button:has-text("Accept invite")');
  await assertMobileChatUsable(pageB, "friend mobile chat after invite");
  await shot(pageB, "28-mobile-friend-chat");
  log("mobile friend invite/signup lands in usable chat ✓");

  await pageA.setInputFiles('input[aria-label="Attach files"]', VIDEO_FIXTURE);
  await pageA.waitForTimeout(2200);
  await pageA.locator('input[placeholder*="Say something"]').fill(`mobile-video-${u}`);
  await pageA.locator('input[placeholder*="Say something"]').press("Enter");
  await pageA.waitForSelector(".kc-video-attachment", { timeout: 12000 });
  const videoCard = pageA.locator(".kc-video-attachment").first();
  await videoCard.locator('button[aria-label^="Load and play"]').waitFor({ state: "visible", timeout: 8000 });
  const preClickVideos = await videoCard.locator("video").count();
  if (preClickVideos !== 0) throw new Error("video element exists before click-to-load");
  const cardBox = await videoCard.boundingBox();
  if (!cardBox || cardBox.width > 330 || cardBox.width < 250) throw new Error(`mobile video card width wrong: ${JSON.stringify(cardBox)}`);
  await assertNoHorizontalOverflow(pageA, "mobile video placeholder");
  await shot(pageA, "28-mobile-video-placeholder");
  log("mobile video placeholder is calm and fits the column ✓");

  await videoCard.locator('button[aria-label^="Load and play"]').click();
  const video = videoCard.locator("video").first();
  await video.waitFor({ state: "visible", timeout: 5000 });
  const preload = await video.getAttribute("preload");
  if (preload !== "none") throw new Error(`video preload should remain none, got ${preload}`);
  await assertNoHorizontalOverflow(pageA, "mobile video after click");
  log("mobile video only creates <video> after click and still fits ✓");

  await pageB.locator('input[placeholder*="Say something"]').fill("yo from phone");
  await pageB.locator('input[placeholder*="Say something"]').press("Enter");
  await pageA.waitForSelector("text=yo from phone", { timeout: 10000 });
  await assertNoHorizontalOverflow(pageA, "owner receiving friend mobile message");
  log("mobile friend can send and desktop/owner receives live ✓");

  console.log("\n✅ MOBILE FRIEND FLOW PASSED (invite · chat · composer · video · no horizontal overflow)");
} catch (err) {
  failed = true;
  console.error("\n❌ MOBILE FRIEND FLOW FAILED:", err?.message ?? err);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
