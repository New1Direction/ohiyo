import { currentToken, launchBrowser, register, log, uniq, PASS, ORIGIN, openDm } from "./harness.mjs";

// Recovery restore: A backs up keys on device 1, then loses it. B keeps writing. A signs in
// on a fresh device 2, which can't read B's new message, restores the backup with the
// recovery code, and reads it. The conversation then carries on both ways.
//
// What a key backup can and can't bring back (the forward-secrecy line):
//   • A message sent to A's old device AFTER the backup: readable after restore.
//   • A message A had already read BEFORE the backup: its key was deleted when it was
//     read, so it stays unreadable. New backups hold keys, not copies of messages.
//
// Device 2 becomes device 1: it takes device 1's id, identity and sessions. So the id
// device 2 signed in with must leave the account (nobody holds its keys), and a session
// device 2 opened before the restore must not be reused under device 1's identity. B adds
// a second device after the backup, and device 2 messages it before restoring, to check.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `ra_${u}`,
  B = `rb_${u}`;
const browser = await launchBrowser();
let failed = false;

const COMPOSER = 'textarea[placeholder="Say something…"]';
const LOCKED = "text=/needs keys this device/";

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
}

async function login(page, username) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill("#kc-password", PASS);
  await page.press("#kc-password", "Enter");
  await page.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
}

async function openDmWith(page, name) {
  await page.click('button[aria-label="Direct Messages"]');
  await openDm(page, name);
  await page.waitForSelector(COMPOSER, { timeout: 8000 });
}

async function send(page, text) {
  const composer = page.locator(COMPOSER);
  await composer.fill(text);
  await composer.press("Enter");
  await page.waitForSelector(`text=${text}`, { timeout: 8000 });
}

const bodyText = (page) => page.evaluate(() => document.body.innerText).catch(() => "");
const signalDevice = (page) => page.evaluate(() => Number(localStorage.getItem("kc:sig:deviceId")));

async function apiGet(page, path) {
  const token = await currentToken(page);
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}
const accountDevices = async (page) => (await apiGet(page, "/users/@me/devices")).map((d) => d.device_id).sort();

try {
  // ── A (device 1) and B, an encrypted DM, one message each way ──
  const ctxA1 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA1 = await ctxA1.newPage();
  pageA1.on("pageerror", (e) => console.error("  A1 ERR:", e.message));
  await onboard(pageA1, A, "Ra", "Ra HQ");

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Rb", "Rb HQ");
  log("A (device 1) + B registered");

  await pageA1.click('button[aria-label="Direct Messages"]');
  await pageA1.click('button[aria-label="Find people"]');
  await pageA1.fill('input[aria-label="Search people"]', B);
  await pageA1.waitForSelector(`button[aria-label="Message @${B}"]`, { timeout: 6000 });
  await pageA1.click(`button[aria-label="Message @${B}"]`);
  await pageA1.waitForSelector(COMPOSER, { timeout: 8000 });
  await pageA1.click('button[aria-label="Turn on end-to-end encryption"]');
  await pageA1.waitForSelector("text=/Switched to end-to-end encrypted/", { timeout: 6000 });
  const hello = `hello-${u}`;
  await send(pageA1, hello);

  await pageB.reload({ waitUntil: "domcontentloaded" });
  await openDmWith(pageB, "Ra");
  await pageB.waitForSelector(`text=${hello}`, { timeout: 10000 });
  const readBeforeBackup = `read-before-backup-${u}`;
  await send(pageB, readBeforeBackup);
  await pageA1.waitForSelector(`text=${readBeforeBackup}`, { timeout: 10000 });
  log("encrypted DM works both ways ✓");

  // ── A backs up keys on device 1 and keeps the recovery code ──
  await pageA1.click('button[aria-label="Settings"]');
  await pageA1.click('button:has-text("Privacy & security")');
  await pageA1.click('button:has-text("Back up my keys now")');
  // Making a backup asks for the password again: a stolen session must not replace it.
  await pageA1.fill('input[aria-label="Your password"]', PASS);
  await pageA1.click('form[aria-label="Confirm with your password"] button[type="submit"]');
  // "Copy code" only appears in the box that shows a freshly made code.
  const copyCode = pageA1.locator('button:has-text("Copy code")');
  await copyCode.waitFor({ timeout: 10000 });
  const code = ((await copyCode.locator("xpath=../..").locator("code").textContent()) ?? "").trim();
  if (code.length < 8) throw new Error(`no recovery code shown (got "${code}")`);
  log("A backed up keys on device 1 ✓");
  const aId = await pageA1.evaluate(() => window.__kikkacordUser?.id);
  const bId = await pageB.evaluate(() => window.__kikkacordUser?.id);
  const device1 = await signalDevice(pageA1);

  // ── Device 1 is lost. B writes while A is away ──
  await ctxA1.close();
  const afterBackup = `after-backup-${u}`;
  await send(pageB, afterBackup);
  log("A's device 1 is gone; B sent a new message");

  // ── B adds a second device after the backup: device 1 never had a session with it ──
  const ctxB2 = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const pageB2 = await ctxB2.newPage();
  pageB2.on("pageerror", (e) => console.error("  B2 ERR:", e.message));
  await login(pageB2, B);
  let bDevices = 0;
  for (let i = 0; i < 16 && bDevices < 2; i++) {
    bDevices = (await apiGet(pageB, `/users/${bId}/identity-keys`)).length;
    if (bDevices < 2) await new Promise((r) => setTimeout(r, 600));
  }
  if (bDevices < 2) throw new Error(`B's second device never published keys (devices=${bDevices})`);
  await openDmWith(pageB2, "Ra");
  log("B signed in on a second device");

  // ── A signs in on device 2: a new device can't read it yet ──
  const ctxA2 = await browser.newContext({ viewport: { width: 1200, height: 820 } });
  const pageA2 = await ctxA2.newPage();
  pageA2.on("pageerror", (e) => console.error("  A2 ERR:", e.message));
  await login(pageA2, A);
  await openDmWith(pageA2, "Rb");
  await pageA2.waitForSelector(LOCKED, { timeout: 10000 });
  if ((await bodyText(pageA2)).includes(afterBackup)) throw new Error("device 2 read the message before any restore");
  const device2 = await signalDevice(pageA2);
  log("device 2 shows the message as locked before restore ✓");

  // The locked card is several lines tall. Its row was once sized as one line of text, so
  // the next message covered the card and its "Open recovery" button.
  const covered = await pageA2.evaluate(() => {
    const groups = [...document.querySelectorAll(".msg-group")];
    return groups.slice(0, -1).some((group, i) => {
      const card = group.querySelector(".mt-1.max-w-md.rounded-2xl");
      return card !== null && card.getBoundingClientRect().bottom > groups[i + 1].getBoundingClientRect().top + 1;
    });
  });
  if (covered) throw new Error("a locked message's card runs under the next message");

  // Device 2 writes before restoring: this opens its own sessions with both of B's devices.
  const beforeRestore = `before-restore-${u}`;
  await send(pageA2, beforeRestore);
  await pageB2.waitForSelector(`text=${beforeRestore}`, { timeout: 12000 });
  log("device 2 messaged B before restoring (B's second device read it) ✓");

  // ── Restore from the locked message's own "Open recovery" button ──
  await pageA2.locator('button:has-text("Open recovery")').first().click();
  await pageA2.waitForSelector('input[aria-label="Recovery code"]', { timeout: 8000 });
  // Restoring while the old device still works makes two devices share one set of keys.
  await pageA2.waitForSelector("text=/Only restore if you no longer have the device that made this backup/", { timeout: 4000 });
  await pageA2.fill('input[aria-label="Recovery code"]', code);
  await pageA2.click('button:has-text("Check backup")');
  await pageA2.waitForSelector("text=Recovery preview", { timeout: 15000 });
  await Promise.all([
    pageA2.waitForEvent("load", { timeout: 15000 }), // restore reloads the app
    pageA2.click('button:has-text("Restore keys")'),
  ]);
  await pageA2.waitForSelector('button[aria-label="Direct Messages"]', { timeout: 12000 });
  log("restored the backup on device 2");

  // ── Device 2 is now device 1, and its own earlier id has left the account ──
  if ((await signalDevice(pageA2)) !== device1) throw new Error("after restore, device 2 does not carry device 1's id");
  let devicesNow = [];
  for (let i = 0; i < 10; i++) {
    devicesNow = await accountDevices(pageA2);
    if (!devicesNow.includes(device2)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (devicesNow.includes(device2)) {
    throw new Error(`device 2's own id ${device2} is still in the account after restore: ${JSON.stringify(devicesNow)}`);
  }
  const bSees = (await apiGet(pageB, `/users/${aId}/identity-keys`)).map((k) => k.device_id);
  if (bSees.includes(device2)) throw new Error("B still encrypts to device 2's old id");
  log(`the account lists device 1's id only; device 2's old id is gone ✓`);

  // ── The message sent after the backup is readable now ──
  await openDmWith(pageA2, "Rb");
  try {
    await pageA2.waitForSelector(`text=${afterBackup}`, { timeout: 12000 });
  } catch {
    const txt = await bodyText(pageA2);
    const state = txt.includes("still can’t be decrypted") ? "restore_failed" : txt.includes("needs keys this device") ? "locked" : "absent";
    throw new Error(`after restore, the message sent after the backup is not readable (state: ${state})`);
  }
  log("device 2 reads the message B sent after the backup ✓");

  // ── A message read before the backup stays unreadable (forward secrecy) ──
  if ((await bodyText(pageA2)).includes(readBeforeBackup)) {
    throw new Error("a message read before the backup became readable: the backup holds more than keys");
  }
  log("the message read before the backup stays unreadable ✓");

  // ── The conversation carries on both ways from the restored device ──
  const afterRestore = `after-restore-${u}`;
  await send(pageB, afterRestore);
  await pageA2.waitForSelector(`text=${afterRestore}`, { timeout: 12000 });
  const fromRestored = `from-restored-${u}`;
  await send(pageA2, fromRestored);
  await pageB.waitForSelector(`text=${fromRestored}`, { timeout: 12000 });
  log("after restore, B → A and A → B both decrypt ✓");
  // B's second device only ever had a session with device 2's old keys. Reusing that
  // session under device 1's identity would make this unreadable there.
  try {
    await pageB2.waitForSelector(`text=${fromRestored}`, { timeout: 12000 });
  } catch {
    throw new Error("B's second device can't read what the restored device sent");
  }
  log("B's second device reads the restored device too ✓");

  console.log("\n✅ RECOVERY RESTORE E2E PASSED (a new device restores keys and reads what was sent after the backup)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
