import { launchBrowser, ORIGIN, register, shot, settle, log, uniq, PASS } from "./harness.mjs";

const u = uniq();
const A = `ma_${u}`, B = `mb_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Ann");
  await pageA.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Mention HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  await pageA.click('button[aria-label="Invite people"]');
  await pageA.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 6000 });
  const link = await pageA.inputValue('input[aria-label="Invite link"]');
  await pageA.keyboard.press("Escape");

  // B joins
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(() => localStorage.clear());
  await pageB.goto(link, { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("text=Create an account", { timeout: 8000 });
  await pageB.click("text=Create an account");
  await pageB.fill('input[autocomplete="username"]', B);
  await pageB.fill('input[autocomplete="nickname"]', "Bea");
  await pageB.fill("#kc-password", PASS);
  await pageB.click('button:has-text("Create my account")');
  await pageB.waitForSelector('button:has-text("Accept invite")', { timeout: 12000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A + B both in #general");

  // A makes #random; B moves there (so a mention in #general is "away")
  await pageA.click('button[aria-label="Create channel"]');
  await pageA.fill('input[placeholder="new-channel"]', "random");
  await pageA.locator('input[placeholder="new-channel"]').press("Enter");
  await pageA.waitForSelector('button:has-text("random")', { timeout: 6000 });
  await pageB.waitForSelector('button:has-text("random")', { timeout: 8000 });
  await pageB.click('button:has-text("random")');
  await pageB.waitForSelector('input[placeholder*="Say something to #random"]', { timeout: 6000 });
  await pageA.click('button:has-text("general")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 6000 });

  // ── @mention autocomplete ──
  const composer = pageA.locator('input[placeholder*="Say something"]');
  await composer.click();
  await composer.pressSequentially("@be", { delay: 30 });
  await pageA.waitForSelector(`button:has-text("@${B}")`, { timeout: 5000 });
  log("autocomplete shows Bea ✓");
  await shot(pageA, "30-mention-autocomplete");
  await pageA.locator(`button:has-text("@${B}")`).first().click();
  const val = await composer.inputValue();
  if (!val.includes(`@${B} `)) throw new Error(`mention not inserted: "${val}"`);
  log("selecting inserts @username ✓");
  // append the rest of the message and send
  await composer.fill(`${val.trim()} free tonight?`);
  await composer.press("Enter");
  await pageA.waitForSelector("text=free tonight?", { timeout: 8000 });

  // ── B (away in #random) gets a mention badge on #general ──
  await pageB.waitForFunction(() => {
    const btns = [...document.querySelectorAll("button")];
    return btns.some((b) => (b.textContent || "").trim().startsWith("general") && (b.textContent || "").includes("@"));
  }, { timeout: 8000 });
  log("B sees the red @ mention badge on #general (live) ✓");
  await shot(pageB, "31-mention-badge");

  // B opens #general → sees the message with the mention highlighted
  await pageB.click('button:has-text("general")');
  await pageB.waitForSelector("text=free tonight?", { timeout: 6000 });
  // the @mention pill renders B's username
  await pageB.waitForSelector(`text=@${B}`, { timeout: 6000 });
  log("B opens #general → mention pill rendered ✓");
  await shot(pageB, "32-mention-rendered");

  console.log("\n✅ MENTIONS FLOW PASSED (autocomplete · insert · live badge · highlighted pill)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
