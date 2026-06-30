import { launchBrowser, ORIGIN, PASS, log } from "./harness.mjs";

const uniq = Date.now().toString(36).slice(-6);
const A = `screena_${uniq}`;
const B = `screenb_${uniq}`;

async function installFakeDisplayCapture(page) {
  await page.addInitScript(() => {
    window.__lastDisplayMediaConstraints = null;
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async (constraints) => {
        window.__lastDisplayMediaConstraints = constraints;
        const canvas = document.createElement("canvas");
        canvas.width = 3840;
        canvas.height = 2160;
        const ctx = canvas.getContext("2d");
        let frame = 0;
        const draw = () => {
          if (!ctx) return;
          const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
          g.addColorStop(0, "#122033");
          g.addColorStop(0.5, "#5ca8e8");
          g.addColorStop(1, "#f2f5f7");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "rgba(0,0,0,.62)";
          ctx.fillRect(220, 220, 1800, 520);
          ctx.fillStyle = "white";
          ctx.font = "96px sans-serif";
          ctx.fillText(`Ohiyo screen share ${++frame}`, 300, 420);
          ctx.font = "54px monospace";
          ctx.fillText("4K detail test · late join safe", 300, 540);
        };
        draw();
        const timer = setInterval(draw, 250);
        const stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0];
        track.addEventListener("ended", () => clearInterval(timer));
        return stream;
      },
    });
  });
}

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
  const row = page.locator('[data-testid="voice-channel-row"] button').first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.click();
  const previewJoin = page.locator('.kc-voice-join-preview button:has-text("Join")').first();
  if (await previewJoin.isVisible({ timeout: 750 }).catch(() => false)) await previewJoin.click();
  await page.waitForSelector("text=LIVE", { timeout: 10000 });
}

async function waitForScreenTrackIfInspectable(page) {
  const inspectable = await page.evaluate(() => typeof window.__kkCall === "function");
  if (!inspectable) return false;
  await page.waitForFunction(() => {
    const call = window.__kkCall?.() ?? [];
    return Array.isArray(call) && call.some((p) => p.recvTracks?.includes("video"));
  }, { timeout: 20000 });
  return true;
}

const browser = await launchBrowser({ fakeMedia: true });
let failed = false;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone", "camera"] });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone", "camera"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await installFakeDisplayCapture(pageA);
  await installFakeDisplayCapture(pageB);
  pageA.on("pageerror", (e) => { console.error("  A PAGEERROR:", e.message); });
  pageB.on("pageerror", (e) => { console.error("  B PAGEERROR:", e.message); });

  await register(pageA, A, "Ada", "Screen HQ");
  const invite = await createInvite(pageA);
  log("A created screen-share server ✓");

  await joinVoice(pageA);
  await pageA.waitForSelector("text=Solo voice", { timeout: 10000 });
  await pageA.click('button[aria-label="Share screen"]');
  await pageA.waitForSelector("text=Share your screen", { timeout: 8000 });
  await pageA.waitForSelector("text=Sharp", { timeout: 8000 });
  await pageA.click('button:has-text("Start sharing")');
  await pageA.waitForSelector("text=Video room", { timeout: 12000 });
  await pageA.waitForSelector("text=sharing", { timeout: 12000 });
  const constraints = await pageA.evaluate(() => window.__lastDisplayMediaConstraints);
  if (!constraints?.video || constraints.video.width?.ideal < 3840 || constraints.video.height?.ideal < 2160) {
    throw new Error(`default screen-share constraints were not sharp/native: ${JSON.stringify(constraints)}`);
  }
  log("A starts default sharp/native screen share ✓");

  await joinInvite(pageB, invite, B, "Ben");
  await joinVoice(pageB);
  await pageB.waitForSelector("text=Video room", { timeout: 12000 });
  await pageB.waitForSelector("text=Ada · sharing", { timeout: 12000 });
  const inspectedTrack = await waitForScreenTrackIfInspectable(pageB);
  log(inspectedTrack
    ? "late joiner sees active screen share and receives video track ✓"
    : "late joiner sees active screen share in production UI ✓");

  await pageA.click('button[aria-label="Stop sharing"]');
  await pageA.waitForSelector("text=Voice room", { timeout: 12000 });
  await pageB.waitForSelector("text=Voice room", { timeout: 12000 });
  log("stop sharing returns both users to voice room ✓");

  console.log("\n✅ SCREEN SHARE SMOKE PASSED (sharp default · live share · late join · stop share)");
} catch (err) {
  failed = true;
  console.error("\n❌ SCREEN SHARE SMOKE FAILED:", err?.message ?? err);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
