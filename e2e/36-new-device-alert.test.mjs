import { currentToken, launchBrowser, register, log, uniq, PASS, ORIGIN } from "./harness.mjs";

// New device on your account: a stolen session could add a device and read every later
// encrypted message, so your other devices say so at once.
//   • A signs in on device 2 → device 1 shows the alert live, without a reload.
//   • The device that just signed in does not alert about itself.
//   • "Not me" takes device 2 off the account and ends every session: device 2's token
//     stops working. Device 1 signs back in and nothing is left to alert about.
//   • "It was me" (device 3) keeps the device, and the alert stays gone after a reload.
//   • A device added while device 1 is closed (device 4) is flagged when it opens.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `nd_${u}`;
const browser = await launchBrowser();
let failed = false;

const ALERT = "text=/new device signed in to your account/";

async function login(page, username) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill("#kc-password", PASS);
  await page.press("#kc-password", "Enter");
  await page.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
}

async function freshDevice(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  return { ctx, page };
}

const status = async (token, path) => (await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
const devicesOf = async (token) =>
  (await (await fetch(`${API}/users/@me/devices`, { headers: { Authorization: `Bearer ${token}` } })).json()).map((d) => d.device_id);
const signalDevice = (page) => page.evaluate(() => Number(localStorage.getItem("kc:sig:deviceId")));

async function waitForDevices(token, n) {
  for (let i = 0; i < 20; i++) {
    const list = await devicesOf(token);
    if (list.length >= n) return list;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the account never listed ${n} devices`);
}

try {
  // ── Device 1 ──
  const d1 = await freshDevice({ width: 1200, height: 820 });
  await register(d1.page, A, "Nd");
  await d1.page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await d1.page.fill("#kc-space-name", "Nd HQ");
  await d1.page.click('button:has-text("Let\'s go")');
  await d1.page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  const token1 = await currentToken(d1.page);
  await waitForDevices(token1, 1);
  await d1.page.waitForTimeout(800);
  if ((await d1.page.locator(ALERT).count()) > 0) throw new Error("device 1 alerted about itself");
  log("device 1 signed up; no alert about itself ✓");

  // ── Device 2 signs in: device 1 is told at once ──
  const d2 = await freshDevice({ width: 1000, height: 760 });
  await login(d2.page, A);
  const token2 = await currentToken(d2.page);
  const device2 = await signalDevice(d2.page);
  await d1.page.waitForSelector(ALERT, { timeout: 12000 });
  log("device 1 shows the new-device alert live ✓");
  await d2.page.waitForTimeout(1500);
  if ((await d2.page.locator(ALERT).count()) > 0) throw new Error("device 2 alerted about itself");
  log("device 2 does not alert about itself ✓");

  // ── "Not me": device 2 leaves the account and every session ends ──
  await d1.page.click('.kc-device-alert button:has-text("Not me")');
  await d1.page.click('button:has-text("Remove and sign out")');
  await d1.page.waitForSelector('input[autocomplete="username"]', { timeout: 12000 });
  log("device 1 is back at sign-in");
  if ((await status(token2, "/users/@me")) !== 401) throw new Error("device 2's token still works after Not me");
  if ((await status(token1, "/users/@me")) !== 401) throw new Error("device 1's old token still works after Not me");
  log("every old session is ended, device 2's included ✓");
  await d2.page.waitForSelector("text=/You were signed out on this device/", { timeout: 20000 });
  log("device 2 noticed and went to sign-in by itself ✓");

  await login(d1.page, A);
  const token1b = await currentToken(d1.page);
  const after = await devicesOf(token1b);
  if (after.includes(device2)) throw new Error(`device 2 (${device2}) is still on the account: ${JSON.stringify(after)}`);
  await d1.page.waitForTimeout(1500);
  if ((await d1.page.locator(ALERT).count()) > 0) throw new Error("device 1 alerts again after signing back in");
  log("device 2 is off the account; device 1 signs back in with no alert ✓");
  await d2.ctx.close();

  // ── "It was me": device 3 stays, and the alert stays gone ──
  const d3 = await freshDevice({ width: 1000, height: 760 });
  await login(d3.page, A);
  const device3 = await signalDevice(d3.page);
  await d1.page.waitForSelector(ALERT, { timeout: 12000 });
  await d1.page.click('.kc-device-alert button:has-text("It was me")');
  await d1.page.waitForSelector(ALERT, { state: "detached", timeout: 4000 });
  await d1.page.reload({ waitUntil: "domcontentloaded" });
  await d1.page.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
  await d1.page.waitForTimeout(1500);
  if ((await d1.page.locator(ALERT).count()) > 0) throw new Error("the alert came back after It was me");
  if (!(await devicesOf(token1b)).includes(device3)) throw new Error("It was me removed device 3");
  log("It was me keeps device 3 and the alert stays gone ✓");

  // ── A device added while device 1 is closed is caught when it opens ──
  await d1.page.close();
  const d4 = await freshDevice({ width: 1000, height: 760 });
  await login(d4.page, A);
  await waitForDevices(token1b, 3);
  const reopened = await d1.ctx.newPage();
  await reopened.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await reopened.waitForSelector(ALERT, { timeout: 12000 });
  log("a device added while device 1 was closed is flagged when it opens ✓");

  console.log("\n✅ NEW DEVICE ALERT E2E PASSED (a device added to your account is announced, and Not me cuts it off)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
