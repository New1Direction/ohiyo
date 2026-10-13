import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Voice controls like Discord's: Settings → Voice & video chooses voice activity or push to
// talk (with a recorded key), and sets input sensitivity with a live mic meter; in a call there
// is a Deafen button beside Mute, and push to talk says which key to hold. Screenshots at
// desktop and phone width, dark and light, are kept by CI to look at.
const browser = await launchBrowser({ fakeMedia: true });
let failed = false;
const COMPOSER = 'textarea[placeholder*="Say something"]';

async function onboard(page, tag, displayName, space) {
  await register(page, `vc_${tag}_${uniq()}`, displayName);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });
}

async function openVoiceSettings(page) {
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".kc-settings-nav button", { hasText: "Voice & video" }).click();
  await page.waitForSelector('input[type="radio"][value="ptt"]', { timeout: 6000 });
}

async function joinVoice(page) {
  const join = page.locator('button[title*="Join"], button[title*="Click to preview"]').first();
  await join.waitFor({ state: "visible", timeout: 10000 });
  await join.click();
  const previewJoin = page.locator('.kc-voice-join-preview button:has-text("Join")').first();
  if (await previewJoin.isVisible().catch(() => false)) await previewJoin.click();
  await page.locator(".kc-call-live-pill").waitFor({ state: "visible", timeout: 10000 });
}

const savedPrefs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ohiyo.voicePrefs.v1") ?? "null"));

try {
  // ── Desktop ──
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone", "camera"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(page, "desk", "Vee", "Voice Lab");

  await openVoiceSettings(page);
  if (!(await page.isChecked('input[type="radio"][value="voice"]'))) throw new Error("voice activity isn't the default");
  await shot(page, "53-voice-settings-dark");

  // Manual sensitivity with the live meter.
  await page.locator("label", { hasText: "Automatically determine input sensitivity" }).locator('input[type="checkbox"]').uncheck();
  await page.waitForSelector('input[type="range"][aria-label="Input sensitivity"]', { timeout: 4000 });
  await page.click('button:has-text("Check my mic")');
  const heard = await page
    .waitForFunction(() => Number(document.querySelector('[data-testid="mic-meter"]')?.getAttribute("data-level") ?? "-100") > -100, undefined, { timeout: 8000 })
    .then(() => true, () => false);
  if (!heard) throw new Error("the mic meter never moved");
  log("manual sensitivity shows a slider and a live mic meter ✓");
  await shot(page, "53-voice-settings-sensitivity-dark");
  await page.click('button:has-text("Stop checking")');

  // Push to talk with a recorded key.
  await page.check('input[type="radio"][value="ptt"]');
  await page.click('button:has-text("Set a key")');
  await page.waitForSelector("text=Press a key", { timeout: 4000 });
  await page.keyboard.press("KeyV");
  await page.waitForSelector("text=Press a key", { state: "detached", timeout: 4000 });
  const prefs = await savedPrefs(page);
  if (prefs?.inputMode !== "ptt" || prefs?.pttKey !== "KeyV") throw new Error(`saved voice settings: ${JSON.stringify(prefs)}`);
  log("push to talk is chosen and V is recorded as its key ✓");
  await shot(page, "53-voice-settings-ptt-dark");
  await page.keyboard.press("Escape");
  await settle(page, 300);

  // In a call: the key to hold, talking while held, and Deafen beside Mute.
  await joinVoice(page);
  await page.waitForSelector("text=Hold V to talk", { timeout: 8000 });
  await page.click(".kc-call-header", { position: { x: 10, y: 10 } });
  await page.keyboard.down("v");
  await page.waitForSelector("text=Talking", { timeout: 4000 });
  await shot(page, "53-voice-call-ptt-dark");
  await page.keyboard.up("v");
  await page.waitForSelector("text=Hold V to talk", { timeout: 4000 });
  log("in a call, holding V talks and letting go stops ✓");

  const labels = await page.evaluate(() => [...document.querySelectorAll(".kc-call-controls button")].map((b) => b.getAttribute("aria-label")));
  if (labels.indexOf("Deafen") !== labels.indexOf("Mute") + 1) throw new Error(`call controls: ${labels.join(", ")}`);
  await page.click('button[aria-label="Deafen"]');
  await page.waitForSelector('button[aria-label="Undeafen"]', { timeout: 6000 });
  await page.waitForSelector('button[aria-label="Unmute"]', { timeout: 6000 });
  await shot(page, "53-voice-call-deafened-dark");
  await page.click('button[aria-label="Undeafen"]');
  await page.waitForSelector('button[aria-label="Mute"]', { timeout: 6000 });
  log("Deafen sits beside Mute, mutes you too, and undeafening puts the mic back ✓");

  // Light theme, to look at.
  await page.click('button:has-text("Minimize")');
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.locator(".kc-settings-nav button", { hasText: "Voice & video" }).click();
  await settle(page, 300);
  await shot(page, "53-voice-settings-light");
  await page.keyboard.press("Escape");
  await page.click('button:has-text("Open")');
  await settle(page, 300);
  await shot(page, "53-voice-call-light");

  // ── Phone ──
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    permissions: ["microphone", "camera"],
  });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => console.error("  ERR:", e.message));
  await onboard(phone, "pocket", "Pocket", "Pocket Lab");
  await phone.waitForSelector(".ohiyo-toast", { state: "detached", timeout: 12000 }).catch(() => {});
  await phone.locator('button[aria-label="Open channels"]').first().click();
  await settle(phone, 300);
  await openVoiceSettings(phone);
  const smallSettings = await phone.evaluate(() =>
    [...document.querySelectorAll(".kc-voice-settings button, .kc-voice-settings label")]
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height < 44)
      .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`),
  );
  if (smallSettings.length) throw new Error(`voice settings targets shorter than 44px on a phone: ${smallSettings.join(", ")}`);
  await shot(phone, "53-voice-settings-phone");
  await phone.keyboard.press("Escape");
  await settle(phone, 300);
  await phone.locator('button[aria-label="Open channels"]').first().click().catch(() => {});
  await settle(phone, 300);
  await joinVoice(phone);
  const deafenBox = await phone.locator('button[aria-label="Deafen"]').first().boundingBox();
  if (!deafenBox || deafenBox.height < 44 || deafenBox.width < 44) throw new Error(`the Deafen button on a phone: ${JSON.stringify(deafenBox)}`);
  await shot(phone, "53-voice-call-phone");
  log("on a phone the voice settings and the Deafen button are at least 44px ✓");

  console.log("\n✅ VOICE CONTROLS PASSED (deafen · push to talk · input sensitivity · screenshots)");
} catch (err) {
  failed = true;
  console.error("\n❌ VOICE CONTROLS FAILED:", err?.message ?? err);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
