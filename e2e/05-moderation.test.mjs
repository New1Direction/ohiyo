import { launchBrowser, ORIGIN, SHOTS } from "./harness.mjs";
const URL = ORIGIN;
const uniq = Date.now().toString(36).slice(-6);
const PASS = "supersecret123";
const log = (...a) => console.log("•", ...a);
const settle = (p, ms = 300) => p.waitForTimeout(ms);
async function shot(p, n) { await p.evaluate(() => document.fonts?.ready).catch(()=>{}); await settle(p,200); await p.screenshot({ path: `${SHOTS}/${n}.png` }); }
async function register(page, u, d) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Create an account", { timeout: 10000 });
  await page.click("text=Create an account");
  await page.fill('input[autocomplete="username"]', u);
  await page.fill('input[autocomplete="nickname"]', d);
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Create my account")');
}

const browser = await launchBrowser();
let failed = false;
try {
  const A = `mod_${uniq}`, B = `kik_${uniq}`;
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Owner");
  await pageA.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Mod HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  // seed messages, grab invite
  await pageA.locator('input[placeholder*="Say something"]').fill("find this needle in general");
  await pageA.locator('input[placeholder*="Say something"]').press("Enter");
  await pageA.waitForSelector("text=find this needle in general", { timeout: 8000 });
  await pageA.click('button[aria-label="Invite people"]');
  await pageA.waitForFunction(() => { const el = document.querySelector('input[aria-label="Invite link"]'); return el && el.value.includes("invite="); }, { timeout: 6000 });
  const link = await pageA.inputValue('input[aria-label="Invite link"]');
  await pageA.keyboard.press("Escape");
  log("A created Mod HQ");

  // A makes #random, switches there
  await pageA.click('button[aria-label="Create channel"]');
  await pageA.fill('input[placeholder="new-channel"]', "random");
  await pageA.locator('input[placeholder="new-channel"]').press("Enter");
  await pageA.waitForSelector('button:has-text("random")', { timeout: 6000 });
  await pageA.click('button:has-text("random")');
  await pageA.waitForSelector('input[placeholder*="Say something to #random"]', { timeout: 6000 });

  // ── SEARCH (from #random, find the #general message, jump to it) ──
  await pageA.click('button[aria-label="Open search"]');
  await pageA.waitForSelector("text=Search messages", { timeout: 5000 });
  await pageA.fill('input[aria-label="Search messages"]', "needle");
  await pageA.waitForSelector("text=find this needle in general", { timeout: 6000 });
  log("search returned the message ✓");
  await shot(pageA, "24-search");
  await pageA.click('button:has-text("find this needle in general")');
  // jumped to #general
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 6000 });
  log("clicking a result jumps to its channel ✓");

  // ── B joins ──
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(() => localStorage.clear());
  await pageB.goto(link, { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("text=Create an account", { timeout: 8000 });
  await pageB.click("text=Create an account");
  await pageB.fill('input[autocomplete="username"]', B);
  await pageB.fill('input[autocomplete="nickname"]', "Kicky");
  await pageB.fill("#kc-password", PASS);
  await pageB.click('button:has-text("Create my account")');
  await pageB.waitForSelector('button:has-text("Accept invite")', { timeout: 12000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  await pageB.waitForSelector("text=Mod HQ", { timeout: 6000 });
  log("B joined Mod HQ");

  // ── MODERATION: A opens members, removes B ──
  await pageA.click('button[aria-label="Members"]');
  await pageA.waitForSelector("text=/Members ·/", { timeout: 5000 });
  await pageA.waitForSelector("text=@" + B, { timeout: 5000 });
  log("members list shows the new member ✓");
  await shot(pageA, "25-members");
  await pageA.getByRole("button", { name: `Remove Kicky` }).click();
  // inline confirm → Ban (removes + blocks rejoining)
  await pageA.getByRole("button", { name: "Ban", exact: true }).click();
  // B should be dropped from Mod HQ
  await pageB.waitForFunction(() => !/Mod HQ/.test(document.body.innerText), { timeout: 8000 });
  log("B was banned — Mod HQ gone from B's app ✓");
  // A's member list no longer shows B (close + reopen or check live)
  await pageA.waitForFunction((u) => !document.body.innerText.includes("@" + u), B, { timeout: 6000 });
  log("A's member list updates live ✓");

  console.log("\n✅ SEARCH + MODERATION FLOW PASSED (search · jump · members · kick)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
  try { await (await browser.contexts())[0].pages()[0].screenshot({ path: `${SHOTS}/MOD-FAIL.png` }); } catch {}
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
