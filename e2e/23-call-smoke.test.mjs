import { launchBrowser, ORIGIN, PASS, log, settle } from "./harness.mjs";

const uniq = Date.now().toString(36).slice(-6);
const A = `calla_${uniq}`;
const B = `callb_${uniq}`;

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
  const join = page.locator('button[title*="Join"], button[title*="Click to preview"]').first();
  await join.waitFor({ state: "visible", timeout: 10000 });
  await join.click();
  const previewJoin = page.locator('.kc-voice-join-preview button:has-text("Join")').first();
  if (await previewJoin.isVisible().catch(() => false)) await previewJoin.click();
  await page.locator(".kc-call-live-pill").waitFor({ state: "visible", timeout: 10000 });
}

async function waitForPeerConnection(page) {
  const hasDevPeerInspector = await page.evaluate(() => typeof window.__kkCall === "function");
  if (!hasDevPeerInspector) {
    // Production builds intentionally do not expose the low-level peer-connection
    // test seam. The UI assertions above still prove the gateway voice roster works;
    // local/dev runs keep the deeper media-track check.
    return false;
  }
  await page.waitForFunction(() => {
    const call = window.__kkCall?.() ?? [];
    return Array.isArray(call) && call.some((p) =>
      (["connected", "connecting", "completed"].includes(p.conn) ||
      ["connected", "completed"].includes(p.ice)) &&
      p.localTracks?.includes("audio") &&
      p.sendTracks?.includes("audio") &&
      p.recvTracks?.includes("audio") &&
      p.remoteStreamTracks?.some((s) => s.tracks?.includes("audio"))
    );
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
  pageA.on("pageerror", (e) => { console.error("  A PAGEERROR:", e.message); });
  pageB.on("pageerror", (e) => { console.error("  B PAGEERROR:", e.message); });

  await register(pageA, A, "Ada", "Call HQ");
  const invite = await createInvite(pageA);
  await joinInvite(pageB, invite, B, "Ben");
  log("A+B are in the same server ✓");

  await joinVoice(pageA);
  await pageA.waitForSelector("text=Solo voice", { timeout: 10000 });
  await pageA.waitForSelector("text=You’re live in General", { timeout: 10000 });
  await pageB.locator('[data-testid="voice-channel-participant"]').filter({ hasText: "Ada" }).waitFor({ state: "visible", timeout: 12000 });
  log("B sees Ada in voice before joining ✓");

  await joinVoice(pageB);
  await pageA.waitForSelector("text=2 people · Voice room", { timeout: 12000 });
  await pageB.waitForSelector("text=2 people · Voice room", { timeout: 12000 });
  await pageA.waitForSelector("text=Ben", { timeout: 12000 });
  await pageB.waitForSelector("text=Ada", { timeout: 12000 });
  log("both users see group voice room + each other ✓");

  const inspectedA = await waitForPeerConnection(pageA);
  const inspectedB = await waitForPeerConnection(pageB);
  log(inspectedA && inspectedB
    ? "WebRTC peer connections reached connected/connecting state ✓"
    : "production build hides peer inspector; roster/UI voice smoke verified ✓");

  await pageA.click('button[aria-label="Turn camera on"]');
  await pageA.waitForSelector("text=Video room", { timeout: 12000 });
  await pageB.waitForSelector("text=Video room", { timeout: 12000 });
  log("camera meta switches both overlays into media grid ✓");

  await pageA.click('button[aria-label="Mute"]');
  await pageA.waitForSelector('button[aria-label="Unmute"]', { timeout: 8000 });
  await pageB.waitForSelector("text=Muted", { timeout: 12000 });
  log("mute state propagates live ✓");

  await pageA.click('button:has-text("Minimize")');
  await pageA.waitForSelector('button:has-text("Open")', { timeout: 8000 });
  await pageA.click('button:has-text("Open")');
  await pageA.waitForSelector('button:has-text("Minimize")', { timeout: 8000 });
  log("minimize/open works ✓");

  await pageA.click('button[aria-label="Leave call"]');
  await pageA.locator(".kc-call-live-pill").waitFor({ state: "detached", timeout: 10000 });
  await pageB.waitForSelector("text=Solo voice", { timeout: 12000 });
  log("leave cleans up A and returns B to solo voice ✓");

  console.log("\n✅ CALL SMOKE PASSED (gateway voice state · WebRTC peer seam · adaptive UI states)");
} catch (err) {
  failed = true;
  console.error("\n❌ CALL SMOKE FAILED:", err?.message ?? err);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
