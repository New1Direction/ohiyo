import { createHmac } from "node:crypto";
import { launchBrowser, register, log, settle, shot, uniq, PASS, ORIGIN } from "./harness.mjs";

// Two-factor sign-in, end to end. A new account turns it on in Settings → Account: password,
// then the setup key (read off the page, the way an authenticator app would), a code worked
// out here from that key, then the recovery codes to save. Signing in again then stops after
// the password and asks for a code; the code signs in. The password alone gets no session.
// Screenshots (the setup step, the recovery codes, the card when it's on in dark and light, the
// sign-in step on a computer by night and by day and on a phone) are kept on every run.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `tfa_${u}`;
const COMPOSER = 'textarea[placeholder*="Say something to #general"]';
const browser = await launchBrowser();
let failed = false;

function base32Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of text.replace(/[\s=-]/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// RFC 6238 with SHA1, 6 digits, 30-second steps: what an authenticator app shows.
function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[19] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}
const stepNow = () => Math.floor(Date.now() / 1000 / 30);

async function awayFromStepEdge() {
  const into = Math.floor(Date.now() / 1000) % 30;
  if (into >= 25) await new Promise((r) => setTimeout(r, (31 - into) * 1000));
}

async function signInUpToTheCode(page) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', A);
  await page.fill("#kc-password", PASS);
  await page.press("#kc-password", "Enter");
  await page.waitForSelector('input[aria-label="Code from your authenticator app"]', { timeout: 10000 });
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, A, "Two Factor");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "2FA HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });

  // ── Turn it on in Settings → Account ──
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".kc-settings-nav button", { hasText: "Account" }).click();
  await page.click('button:has-text("Turn on two-factor sign-in")');
  await page.fill('form[aria-label="Confirm it\'s you"] input[aria-label="Password"]', PASS);
  await page.click('form[aria-label="Confirm it\'s you"] button[type="submit"]');
  await page.waitForSelector('[aria-label="QR code for your authenticator app"]', { timeout: 8000 });
  const key = (await page.locator('[aria-label="Setup key"]').innerText()).replace(/\s/g, "");
  const secret = base32Decode(key);
  if (secret.length !== 20) throw new Error(`the setup key isn't a 160-bit secret: ${key}`);
  await page.locator('[aria-label="QR code for your authenticator app"]').scrollIntoViewIfNeeded();
  await shot(page, "59-two-factor-setup-dark");

  await awayFromStepEdge();
  const enableStep = stepNow();
  await page.fill('input[aria-label="6-digit code"]', totp(secret, enableStep));
  await page.click('form[aria-label="Turn on two-factor sign-in"] button[type="submit"]');
  await page.waitForSelector('button:has-text("Download")', { timeout: 8000 });
  const shown = await page.locator(".kc-recovery-codes li").allInnerTexts();
  if (shown.length !== 10) throw new Error(`expected 10 recovery codes, saw ${shown.length}`);
  await shot(page, "59-two-factor-codes-dark");
  await page.click('button:has-text("I\'ve saved them")');
  await page.waitForSelector("text=10 recovery codes left", { timeout: 8000 });
  await shot(page, "59-two-factor-on-dark");
  log("turned on with a code worked out from the setup key; 10 recovery codes shown once ✓");

  // ── The password alone gets no session ──
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: A, password: PASS }),
  });
  const body = await res.json();
  if (!body.two_factor_required || body.token) throw new Error(`the password alone signed in: ${JSON.stringify(body)}`);
  log("the password alone gets a challenge, not a session ✓");

  // ── Signing in again asks for a code; the code signs in ──
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page2 = await ctx2.newPage();
  page2.on("pageerror", (e) => console.error("  ERR2:", e.message));
  await signInUpToTheCode(page2);
  // The code that turned it on can't be used again; the next one can (the server allows a
  // phone's clock to run one step ahead).
  await page2.fill('input[aria-label="Code from your authenticator app"]', totp(secret, Math.max(stepNow(), enableStep) + 1));
  await page2.press('input[aria-label="Code from your authenticator app"]', "Enter");
  await page2.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
  log("signing in again asked for a code after the password, and the code signed in ✓");

  // ── The card in the light theme, to look at ──
  await page.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.locator(".kc-settings-nav button", { hasText: "Account" }).click();
  await page.locator(".kc-two-factor").scrollIntoViewIfNeeded();
  await shot(page, "59-two-factor-on-light");

  // ── The sign-in step by night and by day, and on a phone, to look at ──
  // The door follows the hour, not the theme: a dark painting by night, a light one by day.
  for (const [hour, tone] of [[23, "dark"], [14, "light"]]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, timezoneId: "UTC" });
    const door = await ctx.newPage();
    await door.clock.setFixedTime(new Date(`2026-10-12T${hour}:00:00Z`));
    await signInUpToTheCode(door);
    const seen = await door.getAttribute("main.ohiyo-door", "data-tone");
    if (seen !== tone) throw new Error(`expected the ${tone} door at ${hour}:00, saw data-tone=${seen}`);
    await settle(door, 200);
    await shot(door, `59-two-factor-signin-${tone}`);
    await ctx.close();
  }

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page4 = await phone.newPage();
  await signInUpToTheCode(page4);
  await settle(page4, 200);
  await shot(page4, "59-two-factor-signin-phone");
  const mode = await page4.getAttribute('input[aria-label="Code from your authenticator app"]', "inputmode");
  if (mode !== "numeric") throw new Error(`the code field doesn't bring up a number pad: inputmode=${mode}`);
  log("the card in the light theme; the sign-in step by night, by day and on a phone (number pad) ✓");
} catch (e) {
  console.error("✗", e.message);
  failed = true;
} finally {
  await browser.close();
}

if (failed) process.exit(1);
console.log("TWO-FACTOR SIGN-IN PASSED");
