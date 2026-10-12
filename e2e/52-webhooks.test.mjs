import { launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Incoming webhooks. The space's owner opens Webhooks from the space menu, makes one for
// #general and is shown its URL once. Another service (this test, with plain fetch and no
// account) posts to the URL, and the message appears live in #general under the webhook's
// name with an APP badge. A wrong token gets 404. Screenshots (the dialog, and the message in
// dark and light) are kept on every run.
const u = uniq();
const A = `wha_${u}`;
const COMPOSER = 'textarea[placeholder*="Say something to #general"]';
const NAME = '.channel-sidebar button[aria-haspopup="menu"]';
const browser = await launchBrowser();
let failed = false;

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, A, "Hook Owner");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Hook HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector(COMPOSER, { timeout: 12000 });

  // ── Make a webhook from the space menu ──
  await page.click(NAME);
  await page.click('[role="menuitem"]:has-text("Webhooks")');
  await page.waitForSelector('input[aria-label="Webhook name"]', { timeout: 5000 });
  await page.fill('input[aria-label="Webhook name"]', "Deploy bot");
  await page.click('button:has-text("Create webhook")');
  await page.waitForSelector('input[aria-label="Webhook URL"]', { timeout: 8000 });
  const url = await page.inputValue('input[aria-label="Webhook URL"]');
  if (!/\/api\/v1\/webhooks\/[^/]+\/[A-Za-z0-9_-]{43,}$/.test(url)) throw new Error(`that doesn't look like a webhook URL: ${url}`);
  log("the owner made a webhook and was shown its URL once");
  await settle(page, 250);
  await shot(page, "52-webhooks-dialog-dark");
  await page.click('button:has-text("Done")');
  await page.waitForSelector('input[aria-label="Webhook URL"]', { state: "detached", timeout: 5000 });
  await page.keyboard.press("Escape");

  // ── Another service posts to it, with no account ──
  const text = `Deploy finished ${u}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) });
  if (res.status !== 204) throw new Error(`posting to the webhook gave ${res.status}: ${await res.text()}`);
  const msg = page.locator(".kc-msg", { has: page.locator(`.msg-content:has-text("${text}")`) }).first();
  await msg.waitFor({ timeout: 8000 });
  if (!(await page.locator("text=Deploy bot").first().isVisible())) throw new Error("the webhook's name isn't shown");
  if ((await page.locator(".kc-app-badge").count()) < 1) throw new Error("no APP badge on the webhook's message");
  log("the message appeared live under the webhook's name with an APP badge ✓");

  const wrong = await fetch(url.replace(/[A-Za-z0-9_-]{6}$/, "zzzzzz"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "nope" }),
  });
  if (wrong.status !== 404) throw new Error(`a wrong token gave ${wrong.status}, not 404`);
  log("a wrong token is turned away ✓");

  await page.waitForSelector("text=Welcome to Hook HQ", { state: "detached", timeout: 10000 }).catch(() => {});
  await settle(page, 250);
  await shot(page, "52-webhooks-message-dark");
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await page.click('button[aria-label="Use theme: Ohiyo Light"]');
  await page.keyboard.press("Escape");
  await settle(page, 300);
  await shot(page, "52-webhooks-message-light");

  console.log("\n✅ WEBHOOKS PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
