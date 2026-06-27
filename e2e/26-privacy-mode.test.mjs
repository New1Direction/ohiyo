import { currentToken, launchBrowser, register, log, uniq } from "./harness.mjs";

// Privacy Mode: keep chat usable, but stop peer-visible behavioral metadata.
// A enables Privacy Mode, chats with B, and proves:
//   1) A's typing is not shown to B.
//   2) A reading B's reply does not turn B's receipt into "Seen".
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `pa_${u}`;
const B = `pb_${u}`;
const browser = await launchBrowser();
let failed = false;

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

async function openDmWith(page, username) {
  await page.click('button[aria-label="Direct Messages"]');
  await page.click('button[aria-label="Find people"]');
  await page.waitForSelector('input[aria-label="Search people"]', { timeout: 6000 });
  await page.fill('input[aria-label="Search people"]', username);
  await page.waitForSelector(`button[aria-label="Message @${username}"]`, { timeout: 8000 });
  await page.click(`button[aria-label="Message @${username}"]`);
  await page.waitForSelector('input[placeholder="Say something…"]', { timeout: 8000 });
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Privacy A", "A HQ");

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Privacy B", "B HQ");
  log("A + B registered");

  // Turn on Privacy Mode from the real settings UI.
  await pageA.click('button[aria-label="Settings"]');
  await pageA.click('button:has-text("Privacy & security")');
  await pageA.waitForSelector("text=Privacy Mode", { timeout: 8000 });
  await pageA.locator('button[role="switch"]').click();
  await pageA.waitForSelector('button[role="switch"][aria-checked="true"]', { timeout: 8000 });
  await pageA.click('button:has-text("Back to Ohiyo")');
  log("A enabled Privacy Mode ✓");

  // A opens a DM and sends the first message so B has a DM tab to open.
  await openDmWith(pageA, B);
  const first = `privacy-hello-${u}`;
  await pageA.fill('input[placeholder="Say something…"]', first);
  await pageA.press('input[placeholder="Say something…"]', "Enter");
  await pageA.waitForSelector(`text=${first}`, { timeout: 8000 });

  await pageB.reload({ waitUntil: "domcontentloaded" });
  await pageB.click('button[aria-label="Direct Messages"]');
  await pageB.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await pageB.click('button:has-text("Direct Message")');
  await pageB.waitForSelector(`text=${first}`, { timeout: 10000 });
  log("B received A's message ✓");

  // A types but does not send. Privacy Mode should suppress TypingStart.
  await pageA.fill('input[placeholder="Say something…"]', `typing-leak-check-${u}`);
  await pageB.waitForTimeout(3200);
  const bTextAfterTyping = await pageB.evaluate(() => document.body.innerText);
  if (/is typing|are typing/.test(bTextAfterTyping)) {
    throw new Error("Privacy Mode leaked A typing indicator to B");
  }
  await pageA.fill('input[placeholder="Say something…"]', "");
  log("A typing stayed private ✓");

  // B replies. A is already reading the DM, but A's Privacy Mode should suppress
  // the peer-visible Seen receipt for B's message.
  const reply = `private-reply-${u}`;
  await pageB.fill('input[placeholder="Say something…"]', reply);
  await pageB.press('input[placeholder="Say something…"]', "Enter");
  await pageA.waitForSelector(`text=${reply}`, { timeout: 10000 });
  await pageB.waitForSelector(".kc-receipt", { timeout: 8000 });
  await pageB.waitForTimeout(2500);
  const receipt = (await pageB.textContent(".kc-receipt"))?.trim();
  if (receipt === "Seen") throw new Error("Privacy Mode leaked A read receipt to B");
  log(`B receipt stayed ${JSON.stringify(receipt)} instead of Seen ✓`);

  // Sanity: the server prefs blob actually persisted Privacy Mode.
  const tokenA = await currentToken(pageA);
  const prefs = await (await fetch(`${API}/users/@me/prefs`, { headers: { Authorization: `Bearer ${tokenA}` } })).json();
  if (prefs?.privacy?.metadataMode !== true) throw new Error(`privacy prefs did not persist: ${JSON.stringify(prefs)}`);
  log("Privacy Mode persisted in user prefs ✓");

  console.log("\n✅ PRIVACY MODE PASSED (no typing leak, no peer-visible Seen receipt, chat still works)");
} catch (err) {
  failed = true;
  console.error("\n❌ PRIVACY MODE FAILED:", err?.message ?? err);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
