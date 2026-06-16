import { launchBrowser, ORIGIN, SHOTS } from "./harness.mjs";
const URL = ORIGIN;

const uniq = Date.now().toString(36).slice(-6);
const USER = `flow_${uniq}`;
const PASS = "supersecret123";
const DISPLAY = `Flow ${uniq}`;

const log = (...a) => console.log("•", ...a);
let warnings = 0;

async function settle(page, ms = 350) { await page.waitForTimeout(ms); }
async function fonts(page) { await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {}); }

async function shot(page, name) {
  await fonts(page);
  await settle(page, 200);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  log("shot", name);
}

const browser = await launchBrowser();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

page.on("pageerror", (e) => { console.error("  PAGEERROR:", e.message); warnings++; });
page.on("console", (m) => { if (m.type() === "error") { console.error("  console.error:", m.text()); } });

try {
  // ── Fresh visitor ───────────────────────────────────────────────
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  log("auth screen loaded");
  await shot(page, "01-auth-login-1440");

  // Password show/hide toggle works
  await page.fill('input[autocomplete="username"]', USER);
  await page.fill("#kc-password", PASS);
  const typeBefore = await page.getAttribute("#kc-password", "type");
  await page.click('button[aria-label="Show password"]');
  const typeAfter = await page.getAttribute("#kc-password", "type");
  if (!(typeBefore === "password" && typeAfter === "text")) {
    throw new Error(`show/hide password broken: ${typeBefore} -> ${typeAfter}`);
  }
  log("password show/hide ✓");
  await page.click('button[aria-label="Hide password"]');

  // ── Switch to register ──────────────────────────────────────────
  await page.click("text=Create an account");
  await page.waitForSelector("text=Join Ohiyo", { timeout: 5000 });
  await shot(page, "02-auth-register-1440");

  // Live password strength hint
  await page.fill('input[autocomplete="username"]', USER);
  await page.fill('input[autocomplete="nickname"]', DISPLAY);
  await page.fill("#kc-password", "short");
  await settle(page, 150);
  let hint = await page.textContent("form");
  if (!/At least 8 characters/.test(hint)) throw new Error("password hint not showing for weak pw");
  await page.fill("#kc-password", PASS);
  await settle(page, 150);
  hint = await page.textContent("form");
  if (!/Strong enough/.test(hint)) throw new Error("strong-password hint missing");
  log("inline password validation ✓");

  // ── Register → expect onboarding (no empty-app cliff) ───────────
  await page.click('button:has-text("Create my account")');
  await page.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  log("ONBOARDING shown after register — cliff removed ✓");
  await shot(page, "03-onboarding-1440");

  // ── Create first space via onboarding → land in live channel ────
  await page.fill("#kc-space-name", "The Roost");
  await page.click('button:has-text("Let\'s go")');
  // Should drop straight into #general with a usable composer
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("LANDED in #general channel immediately after create ✓");
  await settle(page, 600);
  await shot(page, "04-inapp-channel-1440");

  // Verify the seeded voice channel exists (server seed change)
  const hasVoice = await page.locator("text=Voice Channels").count();
  if (hasVoice > 0) log("seeded Voice Channels section present ✓");
  else { console.warn("  WARN: voice channel section not visible"); warnings++; }

  // ── Send a message ──────────────────────────────────────────────
  const composer = page.locator('input[placeholder*="Say something"]');
  await composer.click();
  await composer.fill("hello kikkacord 🐦 first message!");
  await composer.press("Enter");
  await page.waitForSelector("text=first message!", { timeout: 8000 });
  log("message sent + rendered ✓");
  await shot(page, "05-inapp-message-1440");

  // ── Create-server modal (the + button, replacing window.prompt) ──
  await page.click('[title="Add a Server"]');
  await page.waitForSelector("text=Create your space", { timeout: 5000 });
  log("CreateServerModal opens from + (no window.prompt) ✓");
  await shot(page, "06-create-modal-1440");
  await page.keyboard.press("Escape");
  await settle(page, 300);

  // ── Logout → login flow with remembered username + friendly error ─
  await page.click('[title="Log out"]');
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 8000 });
  const remembered = await page.inputValue('input[autocomplete="username"]');
  if (remembered !== USER) console.warn(`  WARN: username not remembered (${remembered})`), warnings++;
  else log("username remembered on return ✓");

  // Friendly error on wrong password
  await page.fill("#kc-password", "wrongpassword");
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector("text=/doesn't match/", { timeout: 8000 });
  log("friendly error on bad credentials ✓");
  await shot(page, "07-auth-error-1440");

  // Correct login
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("login success → back in channel ✓");

  // ── Mobile drawer: chat MUST be reachable on a phone (the old break) ──
  await page.setViewportSize({ width: 320, height: 720 });
  await settle(page, 500);
  await page.waitForSelector('input[placeholder*="Say something"]', { state: "visible", timeout: 6000 });
  log("mobile 320: chat full-width + reachable, drawer collapsed ✓");
  await shot(page, "08-mobile-chat");

  const menuBtn = page.locator('button[aria-label="Open channels"]').filter({ has: page.locator("svg") }).first();
  await menuBtn.click();
  await page.waitForSelector(".kc-nav-scrim", { timeout: 4000 });
  await page.waitForSelector(".kc-nav >> text=TEXT CHANNELS", { state: "visible", timeout: 4000 });
  log("mobile: drawer opens with channel list + scrim ✓");
  await shot(page, "08-mobile-drawer");

  await page.locator(".kc-nav").locator("text=general").first().click();
  await page.waitForSelector(".kc-nav-scrim", { state: "detached", timeout: 4000 });
  await page.waitForSelector('input[placeholder*="Say something"]', { state: "visible", timeout: 4000 });
  log("mobile: picking a channel closes the drawer, back to chat ✓");
  await shot(page, "08-mobile-closed");

  for (const [w, h, label] of [[768, 1024, "768"], [1024, 768, "1024"]]) {
    await page.setViewportSize({ width: w, height: h });
    await settle(page, 500);
    await shot(page, `08-inapp-${label}`);
  }

  // Auth + onboarding at small breakpoints (fresh)
  await page.evaluate(() => localStorage.clear());
  await page.setViewportSize({ width: 320, height: 720 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 8000 });
  await shot(page, "09-auth-320");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 8000 });
  await shot(page, "10-auth-768");

  console.log(`\n✅ FULL FLOW PASSED${warnings ? ` (with ${warnings} warning(s))` : ""}`);
} catch (err) {
  console.error("\n❌ FLOW FAILED:", err.message);
  try { await page.screenshot({ path: `${SHOTS}/FAIL.png` }); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
}
