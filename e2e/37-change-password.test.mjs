import { currentToken, launchBrowser, register, log, uniq, PASS, ORIGIN } from "./harness.mjs";

// Change password: needs the current one, ends every other session, keeps this one.
//   • A wrong current password is refused, and this device stays signed in.
//   • After a change, device 1 keeps working (it sends a message), device 2's session
//     is dead and it goes to sign-in by itself, the old password no longer signs in,
//     and the new one does.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `pw_${u}`;
const NEW_PASS = "brand-new-pass-77";
const browser = await launchBrowser();
let failed = false;

const status = async (token, path) => (await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })).status;
const loginStatus = async (password) =>
  (await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: A, password }) })).status;

async function login(page, password) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', A);
  await page.fill("#kc-password", password);
  await page.press("#kc-password", "Enter");
  await page.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
}

async function fillPasswordForm(page, current, next) {
  await page.fill('input[aria-label="Current password"]', current);
  await page.fill('input[aria-label="New password"]', next);
  await page.fill('input[aria-label="New password again"]', next);
  await page.click('form[aria-label="Change password"] button[type="submit"]');
}

try {
  const ctx1 = await browser.newContext({ viewport: { width: 1200, height: 820 } });
  const page1 = await ctx1.newPage();
  page1.on("pageerror", (e) => console.error("  P1 ERR:", e.message));
  await register(page1, A, "Pw");
  await page1.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page1.fill("#kc-space-name", "Pw HQ");
  await page1.click('button:has-text("Let\'s go")');
  const composer = 'input[placeholder*="Say something to #general"]';
  await page1.waitForSelector(composer, { timeout: 12000 });

  const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const page2 = await ctx2.newPage();
  await login(page2, PASS);
  const token2 = await currentToken(page2);
  const token1 = await currentToken(page1);
  log("A is signed in on two devices");

  // ── Wrong current password ──
  await page1.click('button[aria-label="Settings"]');
  await page1.locator('button:has-text("Account")').first().click();
  await page1.waitForSelector('form[aria-label="Change password"]', { timeout: 8000 });
  await fillPasswordForm(page1, "not-my-password", NEW_PASS);
  await page1.waitForSelector("text=That isn't your current password.", { timeout: 8000 });
  if ((await status(token1, "/users/@me")) !== 200) throw new Error("a wrong current password signed device 1 out");
  if ((await status(token2, "/users/@me")) !== 200) throw new Error("a wrong current password ended device 2's session");
  log("a wrong current password is refused; both sessions still work ✓");

  // ── The real change ──
  await fillPasswordForm(page1, PASS, NEW_PASS);
  await page1.waitForSelector("text=/Password changed/", { timeout: 10000 });
  log("password changed on device 1");

  if ((await status(token2, "/users/@me")) !== 401) throw new Error("device 2's session survived the change");
  if ((await status(token1, "/users/@me")) !== 401) throw new Error("device 1's old token survived the change");
  const fresh = await currentToken(page1);
  if (!fresh || fresh === token1 || (await status(fresh, "/users/@me")) !== 200) throw new Error("device 1 didn't get a working new token");
  log("every old token is dead; device 1 holds a new one ✓");

  // Device 1 keeps working: close settings and send a message over the reconnected app.
  await page1.keyboard.press("Escape");
  const hello = `still-here-${u}`;
  await page1.fill(composer, hello);
  await page1.press(composer, "Enter");
  await page1.waitForSelector(`text=${hello}`, { timeout: 10000 });
  await page1.reload({ waitUntil: "domcontentloaded" });
  await page1.waitForSelector(`text=${hello}`, { timeout: 12000 });
  log("device 1 stays signed in and sends after the change, and after a reload ✓");

  if ((await loginStatus(PASS)) !== 401) throw new Error("the old password still signs in");

  // Device 2 notices on its own and goes to sign-in, saying why (it used to sit on
  // "Reconnecting you now…" for good).
  await page2.waitForSelector("text=/You were signed out on this device/", { timeout: 20000 });
  await page2.fill('input[autocomplete="username"]', A);
  await page2.fill("#kc-password", NEW_PASS);
  await page2.press("#kc-password", "Enter");
  await page2.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
  log("device 2 went to sign-in by itself; the old password is refused, the new one signs in ✓");

  console.log("\n✅ CHANGE PASSWORD E2E PASSED (other sessions end, this one carries on)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
