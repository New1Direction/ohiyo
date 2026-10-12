import { currentToken, launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// A channel can be muted from its header, like Discord.
//   • B mutes #random. A message there raises no unread number; the row says it's muted.
//   • B unmutes it. The next message there shows as 1 unread.
//   • The setting is stored on the server, so B's other devices follow it.
//   • The space's dialog (all messages / only @mentions / nothing) fits a desktop and a phone,
//     in a dark and a light theme; screenshots are kept for a look.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `nta_${u}`;
const B = `ntb_${u}`;
const browser = await launchBrowser();
let failed = false;

const api = async (token, path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
}

const row = (page, name) => page.locator(".channel-sidebar .kc-channel-row", { hasText: name }).first();

async function openChannel(page, name) {
  await row(page, name).click();
  await page.waitForSelector(`textarea[placeholder*="Say something to #${name}"]`, { timeout: 10000 });
}

// A muted chat's dialog says until when and offers Unmute; an unmuted one offers the Mute list.
async function setMute(page, choice) {
  await page.click('button[aria-label="Notification settings"]');
  const dialog = page.locator('[role="dialog"]', { hasText: "Notifications for" });
  await dialog.waitFor({ timeout: 6000 });
  if (choice === "unmute") {
    await dialog.locator("text=Muted until you turn it back on").waitFor({ timeout: 4000 });
    await shot(page, "50-notif-muted-dialog");
    await dialog.locator('button:has-text("Unmute")').click();
  } else {
    await dialog.locator('select[aria-label="Mute"]').selectOption({ label: choice });
    await dialog.locator('button:has-text("Save")').click();
  }
  await dialog.waitFor({ state: "detached", timeout: 6000 });
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Na", "Na HQ");
  const tokenA = await currentToken(pageA);

  const ctxB = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Nb", "Nb HQ");
  const tokenB = await currentToken(pageB);

  const space = (await api(tokenA, "/servers")).body.find((s) => s.name === "Na HQ");
  const random = await api(tokenA, `/servers/${space.id}/channels`, { method: "POST", body: JSON.stringify({ name: "random" }) });
  if (random.status !== 200) throw new Error(`A couldn't make #random (${random.status})`);
  const randomId = random.body.id;
  const invite = await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" });
  if ((await api(tokenB, `/invites/${invite.body.code}`, { method: "POST", body: "{}" })).status !== 200) throw new Error("B couldn't join");
  const sayInRandom = (content) => api(tokenA, `/channels/${randomId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
  log("B joined A's space, which has #general and #random");

  await pageB.click('button[aria-label="Na HQ"]', { timeout: 15000 });
  await openChannel(pageB, "random");
  await setMute(pageB, "Until I turn it back on");
  const stored = (await api(tokenB, "/users/@me/notification-settings")).body ?? [];
  if (!stored.some((s) => s.target_type === "channel" && s.target_id === randomId && s.muted)) throw new Error("the mute wasn't stored");
  log("B muted #random from its header, and the server has it ✓");

  await openChannel(pageB, "general");
  await sayInRandom(`while-muted-${u}`);
  await pageB.waitForSelector('.channel-sidebar .kc-channel-row:has-text("random") [aria-label="Muted"]', { timeout: 8000 });
  await pageB.waitForTimeout(1500);
  if (await row(pageB, "random").locator('[aria-label$="unread"]').count()) throw new Error("a muted channel shows an unread number");
  await shot(pageB, "50-notif-muted-row");
  log("a message in muted #random raises no unread number ✓");

  await openChannel(pageB, "random");
  await setMute(pageB, "unmute");
  await openChannel(pageB, "general");
  await sayInRandom(`after-unmute-${u}`);
  await row(pageB, "random").locator('[aria-label="1 unread"]').waitFor({ timeout: 8000 });
  log("unmuted, the next message shows as 1 unread ✓");

  // ── The space's dialog, to look at: desktop dark and light, then a phone ──
  async function openSpaceDialog(page, scope = ".channel-sidebar") {
    await page.click(`${scope} button[aria-haspopup="menu"]`);
    await page.click(`${scope} [role="menuitem"]:has-text("Notification settings")`);
    const dialog = page.locator('[role="dialog"]', { hasText: "Notifications for" });
    await dialog.waitFor({ timeout: 6000 });
    await settle(page, 250);
    return dialog;
  }
  async function checkDialog(page, dialog, where) {
    const box = await dialog.boundingBox();
    const view = page.viewportSize();
    if (!box || box.x < 0 || box.y < 0 || box.x + box.width > view.width + 1 || box.y + box.height > view.height + 1) {
      throw new Error(`the dialog doesn't fit the ${where} window: ${JSON.stringify(box)} in ${JSON.stringify(view)}`);
    }
    const names = await dialog.locator(".kc-notif-option__name").allTextContents();
    if (names.join("|") !== "All messages|Only @mentions|Nothing") throw new Error(`the ${where} choices read ${names.join(", ")}`);
    const heights = await dialog.locator(".kc-notif-option").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    if (heights.some((h) => h < 44)) throw new Error(`a choice is under 44px on ${where}: ${heights}`);
  }
  let dialog = await openSpaceDialog(pageB);
  await checkDialog(pageB, dialog, "desktop");
  await shot(pageB, "50-notif-space-dark");
  await dialog.locator('button:has-text("Cancel")').click();
  await dialog.waitFor({ state: "detached", timeout: 4000 });

  await pageB.locator('button[aria-label="Settings"]').first().click();
  await pageB.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await pageB.click('button[aria-label="Use theme: Ohiyo Light"]');
  await pageB.keyboard.press("Escape");
  await settle(pageB, 300);
  dialog = await openSpaceDialog(pageB);
  await checkDialog(pageB, dialog, "desktop light");
  await shot(pageB, "50-notif-space-light");
  await dialog.locator('button:has-text("Cancel")').click();
  log("the space's dialog fits a desktop, dark and light ✓");

  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => console.error("  P ERR:", e.message));
  await onboard(phone, `ntc_${u}`, "Nc", "Nc HQ");
  await phone.locator('button[aria-label="Open channels"]').first().tap();
  await settle(phone, 450);
  dialog = await openSpaceDialog(phone, ".kc-nav");
  await checkDialog(phone, dialog, "phone");
  await shot(phone, "50-notif-space-phone");
  log("on a phone the dialog fits and every choice is at least 44px ✓");

  console.log("\n✅ NOTIFICATION SETTINGS PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
