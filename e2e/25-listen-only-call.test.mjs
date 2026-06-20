import { launchBrowser, ORIGIN, PASS, log } from "./harness.mjs";

const uniq = Date.now().toString(36).slice(-6);
const A = `heara_${uniq}`;
const B = `hearb_${uniq}`;

async function register(page, username, displayName, spaceName) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Create an account", { timeout: 10000 });
  await page.click("text=Create an account");
  await page.waitForSelector("text=Join Ohiyo");
  await page.fill('input[autocomplete="username"]', username);
  if (displayName) await page.fill('input[autocomplete="nickname"]', displayName);
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Create my account")');
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", spaceName);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

async function createInvite(page) {
  await page.click('button[aria-label="Invite people"]');
  await page.waitForSelector('input[aria-label="Invite link"]', { timeout: 6000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 6000 });
  const invite = await page.inputValue('input[aria-label="Invite link"]');
  await page.keyboard.press("Escape");
  return invite;
}

async function joinInvite(page, invite, username, displayName) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(invite, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.click("text=Create an account");
  await page.fill('input[autocomplete="username"]', username);
  if (displayName) await page.fill('input[autocomplete="nickname"]', displayName);
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Create my account")');
  await page.waitForSelector("text=You're invited to", { timeout: 12000 });
  await page.click('button:has-text("Accept invite")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

async function joinVoice(page) {
  const join = page.locator('button[title="Join voice"]').first();
  await join.waitFor({ state: "visible", timeout: 10000 });
  await join.click();
  await page.waitForSelector("text=LIVE", { timeout: 10000 });
}

async function blockMicrophone(page) {
  await page.evaluate(() => {
    const mediaDevices = navigator.mediaDevices;
    const original = mediaDevices.getUserMedia.bind(mediaDevices);
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: (constraints) => {
        if (constraints && typeof constraints === "object" && "audio" in constraints && constraints.audio) {
          return Promise.reject(new DOMException("Microphone blocked for listen-only test", "NotAllowedError"));
        }
        return original(constraints);
      },
    });
  });
}

async function waitForListenOnlyReceiveAudio(page) {
  await page.waitForFunction(() => {
    const call = window.__kkCall?.() ?? [];
    return Array.isArray(call) && call.some((p) =>
      (["connected", "connecting", "completed"].includes(p.conn) ||
      ["connected", "completed"].includes(p.ice)) &&
      !p.localTracks?.includes("audio") &&
      !p.sendTracks?.includes("audio") &&
      p.recvTracks?.includes("audio") &&
      p.remoteStreamTracks?.some((s) => s.tracks?.includes("audio"))
    );
  }, { timeout: 20000 });
}

const browser = await launchBrowser({ fakeMedia: true });
let failed = false;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone", "camera"] });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["camera"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on("pageerror", (e) => { console.error("  A PAGEERROR:", e.message); });
  pageB.on("pageerror", (e) => { console.error("  B PAGEERROR:", e.message); });

  await register(pageA, A, "Ada", "Listen HQ");
  const invite = await createInvite(pageA);
  await joinInvite(pageB, invite, B, "Ben");
  log("A+B are in the same server ✓");

  await joinVoice(pageA);
  await blockMicrophone(pageB);
  await joinVoice(pageB);
  await pageB.waitForSelector("text=Listening only", { timeout: 12000 });
  await pageA.waitForSelector("text=Ben", { timeout: 12000 });
  await pageA.waitForSelector("text=Muted", { timeout: 12000 });
  log("mic-blocked user joins as listen-only ✓");

  await waitForListenOnlyReceiveAudio(pageB);
  log("listen-only user receives remote voice audio track ✓");

  console.log("\n✅ LISTEN-ONLY CALL SMOKE PASSED (no mic · joins call · receives audio)");
} catch (err) {
  failed = true;
  console.error("\n❌ LISTEN-ONLY CALL SMOKE FAILED:", err?.message ?? err);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
