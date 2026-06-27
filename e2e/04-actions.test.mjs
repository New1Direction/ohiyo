import { launchBrowser, ORIGIN, SHOTS } from "./harness.mjs";
const URL = ORIGIN;
const uniq = Date.now().toString(36).slice(-6);
const PASS = "supersecret123";
const log = (...a) => console.log("•", ...a);
const settle = (p, ms = 300) => p.waitForTimeout(ms);
async function shot(page, n) { await page.evaluate(() => document.fonts?.ready).catch(()=>{}); await settle(page,200); await page.screenshot({ path: `${SHOTS}/${n}.png` }); }
async function register(page, u, d) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Create an account", { timeout: 10000 });
  await page.click("text=Create an account");
  await page.waitForSelector("text=Join Ohiyo");
  await page.fill('input[autocomplete="username"]', u);
  await page.fill('input[autocomplete="nickname"]', d);
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Create my account")');
}

const browser = await launchBrowser();
let failed = false;
try {
  const A = `act_${uniq}`, B = `bob_${uniq}`;
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));

  await register(pageA, A, "Actor");
  await pageA.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Action HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  const grab = link => link;

  // Send a message
  const composer = pageA.locator('input[placeholder*="Say something"]');
  await composer.fill("frist mesage");
  await composer.press("Enter");
  await pageA.waitForSelector("text=frist mesage", { timeout: 8000 });
  log("sent a message");

  const grp = () => pageA.locator(".msg-group", { hasText: /frist|first/ });

  // ── EDIT ──
  await grp().hover();
  await grp().getByRole("button", { name: "Edit message" }).first().click();
  const editInput = pageA.locator('input[aria-label="Edit message"]');
  await editInput.fill("first message (fixed)");
  await editInput.press("Enter");
  await pageA.waitForSelector("text=first message (fixed)", { timeout: 8000 });
  await pageA.waitForSelector("text=(edited)", { timeout: 6000 });
  log("edit + (edited) label ✓");
  await shot(pageA, "21-edited");

  // ── PIN ──
  const pinGrp = pageA.locator(".msg-group", { hasText: "first message (fixed)" });
  await pinGrp.hover();
  await pinGrp.getByRole("button", { name: "Pin message" }).first().click();
  await pageA.waitForSelector("text=Pinned", { timeout: 8000 });
  log("pin → 📌 Pinned tag ✓");
  // verify pins endpoint via UI state, then unpin
  await shot(pageA, "22-pinned");
  await pinGrp.hover();
  await pinGrp.getByRole("button", { name: "Unpin message" }).first().click();
  await pageA.waitForFunction(() => !/Pinned/.test(document.body.innerText), { timeout: 6000 });
  log("unpin clears tag ✓");

  // ── DELETE (inline confirm) ──
  await composer.fill("delete this one");
  await composer.press("Enter");
  await pageA.waitForSelector("text=delete this one", { timeout: 8000 });
  const dgroup = pageA.locator('[data-message-id]:not([data-message-id^="temp-"])', { hasText: "delete this one" });
  await dgroup.waitFor({ state: "visible", timeout: 8000 });
  await dgroup.hover();
  await dgroup.getByRole("button", { name: "Delete message" }).first().click();
  // inline confirm should appear (Delete / Cancel)
  await dgroup.getByRole("button", { name: "Cancel" }).waitFor({ timeout: 5000 });
  await shot(pageA, "23-delete-confirm");
  await dgroup.hover();
  await dgroup.getByRole("button", { name: "Delete", exact: true }).click();
  await pageA.waitForFunction(() => !/delete this one/.test(document.body.innerText), { timeout: 8000 });
  log("delete with inline confirm ✓");

  // ── TITLE BADGE (needs a 2nd user) ──
  await pageA.click('button[aria-label="Invite people"]');
  await pageA.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 6000 });
  const link = await pageA.inputValue('input[aria-label="Invite link"]');
  await pageA.keyboard.press("Escape");
  // A creates #random and switches to it
  await pageA.click('button[aria-label="Create channel"]');
  await pageA.fill('input[placeholder="new-channel"]', "random");
  await pageA.locator('input[placeholder="new-channel"]').press("Enter");
  await pageA.waitForSelector('button:has-text("random")', { timeout: 6000 });
  await pageA.click('button:has-text("random")');
  await pageA.waitForSelector('input[placeholder*="Say something to #random"]', { timeout: 6000 });

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(() => localStorage.clear());
  await pageB.goto(grab(link), { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("text=Create an account", { timeout: 8000 });
  await pageB.click("text=Create an account");
  await pageB.fill('input[autocomplete="username"]', B);
  await pageB.fill('input[autocomplete="nickname"]', "Bob");
  await pageB.fill("#kc-password", PASS);
  await pageB.click('button:has-text("Create my account")');
  await pageB.waitForSelector('button:has-text("Accept invite")', { timeout: 12000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  // B posts to #general while A is on #random
  await pageB.locator('input[placeholder*="Say something"]').fill("hey are you there");
  await pageB.locator('input[placeholder*="Say something"]').press("Enter");
  // A's tab title should show unread count
  await pageA.waitForFunction(() => /^\(\d+\) Ohiyo/.test(document.title), { timeout: 8000 });
  const title = await pageA.evaluate(() => document.title);
  log(`A tab title shows unread: "${title}" ✓`);
  // opening the channel clears the title
  await pageA.click('button:has-text("general")');
  await pageA.waitForFunction(() => document.title === "Ohiyo", { timeout: 6000 });
  log("title resets after reading ✓");

  console.log("\n✅ MESSAGE ACTIONS FLOW PASSED (edit · pin · delete · title badge)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
  try { await (await browser.contexts())[0].pages()[0].screenshot({ path: `${SHOTS}/ACTIONS-FAIL.png` }); } catch {}
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
