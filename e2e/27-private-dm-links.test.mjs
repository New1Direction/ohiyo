import { launchBrowser, register, log, uniq } from "./harness.mjs";

const u = uniq();
const A = `linka_${u}`;
const B = `linkb_${u}`;
const C = `linkc_${u}`;
const browser = await launchBrowser();
let failed = false;

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

async function registerAt(page, url, username, display) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Create an account", { timeout: 10000 });
  await page.click("text=Create an account");
  await page.waitForSelector("text=Join Ohiyo");
  await page.fill('input[autocomplete="username"]', username);
  if (display) await page.fill('input[autocomplete="nickname"]', display);
  await page.fill("#kc-password", "supersecret123");
  await page.click('button:has-text("Create my account")');
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Link A", "Link HQ");

  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Create one-time private DM link"]');
  await pageA.waitForSelector("text=One-time private DM link", { timeout: 8000 });
  await pageA.click('button:has-text("Create one-time link + QR")');
  await pageA.waitForSelector('input[aria-label="One-time private DM link"]', { timeout: 8000 });
  await pageA.waitForSelector("svg", { timeout: 4000 });
  const dmLink = await pageA.inputValue('input[aria-label="One-time private DM link"]');
  if (!dmLink.includes("?dm=")) throw new Error(`private DM link malformed: ${dmLink}`);
  log("A created one-time private DM link + QR ✓");

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await registerAt(pageB, dmLink, B, "Link B");
  await pageB.waitForSelector("text=Private DM invitation", { timeout: 12000 });
  await pageB.waitForSelector("text=@" + A, { timeout: 8000 });
  await pageB.click('button:has-text("Open DM with Link A")');
  await pageB.waitForSelector('input[placeholder="Say something…"]', { timeout: 10000 });
  if (pageB.url().includes("dm=")) throw new Error("dm token remained in URL after redeem");
  log("B redeemed link and opened A's DM ✓");

  const msg = `one-time-dm-${u}`;
  await pageB.fill('input[placeholder="Say something…"]', msg);
  await pageB.press('input[placeholder="Say something…"]', "Enter");
  await pageB.waitForSelector(`text=${msg}`, { timeout: 8000 });

  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.waitForSelector('button:has-text("Direct Message")', { timeout: 10000 });
  await pageA.click('button:has-text("Direct Message")');
  await pageA.waitForSelector(`text=${msg}`, { timeout: 10000 });
  log("A received the DM created by the link ✓");

  const ctxC = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const pageC = await ctxC.newPage();
  pageC.on("pageerror", (e) => console.error("  C ERR:", e.message));
  await registerAt(pageC, dmLink, C, "Link C");
  await pageC.waitForSelector("text=Private DM invitation", { timeout: 12000 });
  await pageC.waitForSelector("text=this private DM link is invalid, expired, or already used", { timeout: 10000 });
  log("Second redemption was rejected ✓");

  console.log("\n✅ PRIVATE DM LINKS PASSED (QR/link creation, single-use redeem, no token reuse)");
} catch (err) {
  failed = true;
  console.error("\n❌ PRIVATE DM LINKS FAILED:", err?.message ?? err);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
