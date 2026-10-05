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

async function activation(page) {
  return page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem("ohiyo:activation:v1") || "{}");
    return Object.values(all)[0] || {};
  });
}

async function waitActivation(page, key) {
  await page.waitForFunction((milestone) => {
    const all = JSON.parse(localStorage.getItem("ohiyo:activation:v1") || "{}");
    return Object.values(all).some((state) => Boolean(state?.[milestone]));
  }, key, { timeout: 8000 });
  return activation(page);
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
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  log("ONBOARDING shown after register — cliff removed ✓");
  await shot(page, "03-onboarding-1440");

  // ── Create first space via onboarding → land in live channel ────
  await page.fill("#kc-space-name", "The Roost");
  await page.click('button:has-text("Let\'s go")');
  // Should drop straight into #general with a usable composer
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("LANDED in #general channel immediately after create ✓");
  await settle(page, 600);

  // A member with no profile picture shows the Ohiyo logo, on a circle that is actually painted.
  const ownAvatar = await page.evaluate(() => {
    const el = document.querySelector('button[aria-label="Edit status"] > div');
    return { logo: Boolean(el?.querySelector('svg[viewBox="0 -23 746 746"]')), bg: el ? getComputedStyle(el).backgroundImage : null };
  });
  if (!ownAvatar.logo || !ownAvatar.bg || ownAvatar.bg === "none") {
    throw new Error(`own default avatar is not the logo on a painted circle: ${JSON.stringify(ownAvatar)}`);
  }
  log("default avatar: the Ohiyo logo on a painted circle ✓");
  await shot(page, "04-inapp-channel-1440");

  // Verify the owner checklist + seeded voice channel exist.
  // The checklist is one quiet row under the channels ("Getting started", 2 of 5) until it
  // is opened; it used to fill the sidebar and push the channels out of sight.
  const started = page.locator(".kc-activation > summary");
  await started.waitFor({ timeout: 8000 });
  if (!/Getting started/.test(await started.textContent()) || !/2 of 5/.test(await started.textContent())) throw new Error(`unexpected checklist row: ${await started.textContent()}`);
  const layout = await page.evaluate(() => {
    const row = document.querySelector(".kc-activation").getBoundingClientRect();
    const general = [...document.querySelectorAll(".channel-sidebar button")].find((b) => b.textContent.trim() === "general").getBoundingClientRect();
    return { rowHeight: Math.round(row.height), channelAboveRow: general.bottom <= row.top, isOpen: document.querySelector(".kc-activation").open };
  });
  if (layout.isOpen || layout.rowHeight > 70 || !layout.channelAboveRow) throw new Error(`the checklist should start as a slim row below the channels: ${JSON.stringify(layout)}`);
  await started.click();
  await page.waitForSelector("text=Owner launch checklist", { timeout: 4000 });
  await started.click();
  const afterCreate = await activation(page);
  if (!afterCreate.account || !afterCreate.server) throw new Error("activation did not record account + server milestones");
  log("owner launch checklist visible + account/server milestones recorded locally ✓");
  const hasVoice = await page.locator("text=Voice Channels").count();
  if (hasVoice > 0) log("seeded Voice Channels section present ✓");
  else { console.warn("  WARN: voice channel section not visible"); warnings++; }

  // The welcome checklist's "Invite someone" step gives a real invite to this space. It used to
  // copy a note with a link to the project, which did not bring anyone into the space.
  await page.click('button:has-text("Get an invite link")');
  await page.waitForSelector('input[aria-label="Invite link"]', { timeout: 6000 });
  await page.waitForFunction(() => document.querySelector('input[aria-label="Invite link"]')?.value.includes("?invite="), null, { timeout: 6000 })
    .catch(() => { throw new Error("the welcome checklist's invite step did not produce an invite link to the space"); });
  const welcomeInvite = await page.inputValue('input[aria-label="Invite link"]');
  if (!welcomeInvite.startsWith(ORIGIN) || /github\.com|ohiyo\.gg/.test(welcomeInvite)) throw new Error(`not an invite to this space: ${welcomeInvite}`);
  log("welcome checklist: Invite someone opens this space's own invite link ✓");
  await page.keyboard.press("Escape");
  await page.waitForSelector('input[aria-label="Invite link"]', { state: "detached", timeout: 4000 });

  // ── Send a message ──────────────────────────────────────────────
  const composer = page.locator('input[placeholder*="Say something"]');
  await composer.click();
  await composer.fill("hello kikkacord 🐦 first message!");
  await composer.press("Enter");
  await page.waitForSelector("text=first message!", { timeout: 8000 });
  const afterMessage = await waitActivation(page, "message");
  if (!afterMessage.message) throw new Error("activation did not record message milestone");
  log("message sent + rendered + activation recorded ✓");
  await shot(page, "05-inapp-message-1440");

  // ── Invite milestone ─────────────────────────────────────────────
  await page.click('button[aria-label="Invite people"]');
  await page.waitForSelector('input[aria-label="Invite link"]', { timeout: 8000 });
  const afterInvite = await waitActivation(page, "invite");
  if (!afterInvite.invite) throw new Error("activation did not record invite milestone");
  log("invite link generated + activation recorded ✓");
  await page.click('button:has-text("Done")');

  // ── Instant Servers stays reachable after removing the lightning shortcut ──
  if (await page.locator('button[aria-label="Create or manage Instant Servers"]').count()) {
    throw new Error("the removed lightning shortcut returned");
  }
  // Fresh accounts have no optional keyboard plugin enabled.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search channels and DMs" }).fill("Instant Servers");
  await page.getByRole("option", { name: /Create or manage Instant Servers/ }).click();
  await page.waitForSelector("text=Managed encrypted homes you can leave anytime", { timeout: 8000 });
  log("Instant Servers manager opens from the core command palette ✓");
  await page.keyboard.press("Escape");
  await settle(page, 200);

  // ── Create-server modal (the + button, replacing window.prompt) ──
  await page.click('[title="Create a space"]');
  await page.waitForSelector("text=Create your space", { timeout: 5000 });
  log("CreateServerModal opens from + (no window.prompt) ✓");
  await shot(page, "06-create-modal-1440");
  await page.keyboard.press("Escape");
  await settle(page, 300);

  // ── Logout → login flow with remembered username + friendly error ─
  await page.click('[title="Sign out"]');
  // Signing out of the last account asks first, because it removes local message data.
  const signOutDialog = '[role="dialog"][aria-labelledby="kc-sign-out-title"]';
  await page.waitForSelector(signOutDialog, { timeout: 8000 });
  log("sign-out asks before removing local message data ✓");
  await page.click(`${signOutDialog} button:has-text("Sign out")`);
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

  // ── Narrowing a desktop window reflows the chat (it used to stay wide and get clipped) ──
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForFunction(() => {
    const composer = document.querySelector(".kc-composer-shell");
    return composer && composer.getBoundingClientRect().right <= window.innerWidth;
  }, null, { timeout: 4000 }).catch(() => { throw new Error("the chat pane did not shrink with the window: the composer is clipped"); });
  log("narrower window: chat pane shrinks, composer stays on screen ✓");

  // ── Mobile drawer: chat MUST be reachable on a phone (the old break) ──
  await page.setViewportSize({ width: 320, height: 720 });
  await settle(page, 500);
  await page.waitForSelector('input[placeholder*="Say something"]', { state: "visible", timeout: 6000 });
  log("mobile 320: chat full-width + reachable, drawer collapsed ✓");

  // A message that wraps on a phone needs a taller row (rows used to be sized for a wide pane
  // and ran into each other).
  const longLine = page.locator('input[placeholder*="Say something"]');
  await longLine.fill("ok so the plan for saturday is: we meet at the station at ten, grab coffee, walk up to the lookout, and then whoever is still alive gets ramen after");
  await longLine.press("Enter");
  await page.waitForSelector("text=/whoever is still alive/", { timeout: 6000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".msg-group")].every((row) => {
    const style = getComputedStyle(row);
    const needed = row.firstElementChild.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    return row.getBoundingClientRect().height >= Math.floor(needed);
  }), null, { timeout: 4000 }).catch(() => { throw new Error("a wrapped message on a phone got a row that is too short for it"); });
  log("mobile 320: wrapped messages get rows tall enough for them ✓");
  await shot(page, "08-mobile-chat");

  const menuBtn = page.locator('button[aria-label="Open channels"]').filter({ has: page.locator("svg") }).first();
  await menuBtn.click();
  await page.waitForSelector(".kc-nav-scrim", { timeout: 4000 });
  await page.waitForSelector(".kc-nav >> text=TEXT CHANNELS", { state: "visible", timeout: 4000 });
  log("mobile: drawer opens with channel list + scrim ✓");
  await shot(page, "08-mobile-drawer");

  await page.locator(".kc-nav button").filter({ hasText: /^general/ }).first().click();
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
