import { currentToken, launchBrowser, register, log, uniq, PASS, ORIGIN, openDm } from "./harness.mjs";

// A contact's new device: every device a contact has can read what you send them. A new
// one used to be trusted silently, and a "verified" mark kept covering it.
//   • B adds a device while A hasn't verified B → a calm "They added a new device."
//   • A verifies B → "verified".
//   • B adds another device → loud "They have a device you didn't verify.", and the
//     verified mark no longer shows. Verifying again settles it.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `ca_${u}`,
  B = `cb_${u}`;
const browser = await launchBrowser();
let failed = false;

const COMPOSER = 'input[placeholder="Say something…"]';
const CALM = "text=/They added a new device/";
const LOUD = "text=/They have a device you didn't verify/";
const VERIFIED = "text=/End-to-end encrypted · verified/";

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

async function login(page, username) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill("#kc-password", PASS);
  await page.press("#kc-password", "Enter");
  await page.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
}

async function send(page, text) {
  const composer = page.locator(COMPOSER);
  await composer.fill(text);
  await composer.press("Enter");
  await page.waitForSelector(`text=${text}`, { timeout: 8000 });
}

async function bDevices(page, bId) {
  const token = await currentToken(page);
  const res = await fetch(`${API}/users/${bId}/identity-keys`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).length;
}

async function addDeviceForB(n, pageA, bId) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const page = await ctx.newPage();
  await login(page, B);
  for (let i = 0; i < 20 && (await bDevices(pageA, bId)) < n; i++) await new Promise((r) => setTimeout(r, 500));
  if ((await bDevices(pageA, bId)) < n) throw new Error(`B's device ${n} never published keys`);
  return ctx;
}

async function verify(page) {
  await page.click('button[aria-label="Verify encryption safety number"]');
  await page.click('button:has-text("These match — mark verified")', { timeout: 10000 });
  await page.waitForSelector(VERIFIED, { timeout: 6000 });
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Ca", "Ca HQ");
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  await onboard(pageB, B, "Cb", "Cb HQ");
  const bId = await pageB.evaluate(() => window.__kikkacordUser?.id);

  // ── An encrypted DM; A's first send records B's devices ──
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Find people"]');
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`button[aria-label="Message @${B}"]`, { timeout: 6000 });
  await pageA.click(`button[aria-label="Message @${B}"]`);
  await pageA.waitForSelector(COMPOSER, { timeout: 8000 });
  await pageA.click('button[aria-label="Turn on end-to-end encryption"]');
  await pageA.waitForSelector("text=/Switched to end-to-end encrypted/", { timeout: 6000 });
  await send(pageA, `hi-${u}`);
  await pageA.waitForTimeout(800);
  if ((await pageA.locator(CALM).count()) + (await pageA.locator(LOUD).count()) > 0) {
    throw new Error("A was told about B's devices on first contact");
  }
  log("first contact: B's devices recorded quietly ✓");

  // ── B adds a device; A hasn't verified B: calm ──
  const ctxB2 = await addDeviceForB(2, pageA, bId);
  await send(pageA, `after-b2-${u}`);
  await pageA.waitForSelector(CALM, { timeout: 8000 });
  log("B added a device → calm notice for unverified A ✓");
  await pageA.click('button:has-text("Dismiss")');
  await pageA.waitForSelector(CALM, { state: "detached", timeout: 4000 });

  // ── A verifies B ──
  await verify(pageA);
  log("A verified B ✓");

  // ── B adds another device: loud, and verified no longer shows ──
  const ctxB3 = await addDeviceForB(3, pageA, bId);
  await send(pageA, `after-b3-${u}`);
  await pageA.waitForSelector(LOUD, { timeout: 8000 });
  if ((await pageA.locator(VERIFIED).count()) > 0) throw new Error("still shown as verified with an unverified device");
  log("B added a device after A verified → loud notice, verified mark gone ✓");

  // The notice survives a reload until A deals with it, and opening the DM alone is enough.
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.click('button[aria-label="Direct Messages"]');
  await openDm(pageA, "Cb");
  await pageA.waitForSelector(LOUD, { timeout: 8000 });
  log("the notice is still there after a reload ✓");

  await pageA.click('button:has-text("Verify now")');
  await pageA.click('button:has-text("These match — mark verified")', { timeout: 10000 });
  await pageA.waitForSelector(VERIFIED, { timeout: 6000 });
  if ((await pageA.locator(LOUD).count()) > 0) throw new Error("the notice stayed after verifying again");
  log("verifying again covers the new device ✓");

  await ctxB2.close();
  await ctxB3.close();
  console.log("\n✅ CONTACT NEW DEVICE E2E PASSED (a contact's new device is announced; verified covers only the devices you compared)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
