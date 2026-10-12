import { launchBrowser, register, log, uniq, openDm } from "./harness.mjs";

// Someone you have never talked to starts a DM with you while you're online. The chat must
// turn up in your list straight away, under their name and with an unread badge, not only
// after a reload.
const u = uniq();
const A = `la_${u}`,
  B = `lb_${u}`;
const browser = await launchBrowser();
let failed = false;

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Lia", "Lia HQ");

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Lou", "Lou HQ");
  // B sits on the DM list the whole time and never reloads.
  await pageB.click('button[aria-label="Direct Messages"]');
  log("A and B are online");

  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Find people"]');
  await pageA.waitForSelector('input[aria-label="Search people"]', { timeout: 6000 });
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`button[aria-label="Message @${B}"]`, { timeout: 6000 });
  await pageA.click(`button[aria-label="Message @${B}"]`);
  const composer = pageA.locator('input[placeholder="Say something…"]');
  await composer.waitFor({ timeout: 8000 });
  const hello = `first-hello-${u}`;
  await composer.fill(hello);
  await composer.press("Enter");
  await pageA.waitForSelector(`text=${hello}`, { timeout: 8000 });
  log("A started a DM with B and said hello");

  await pageB.waitForSelector('button[aria-label="Pin Lia"]', { timeout: 8000 });
  await pageB.waitForSelector('[aria-label="1 unread"]', { timeout: 8000 });
  log("B's list shows the new DM under A's name, with 1 unread, without a reload ✓");
  await openDm(pageB, "Lia");
  await pageB.waitForSelector(`text=${hello}`, { timeout: 8000 });
  log("B opened it and reads the hello ✓");

  console.log("\n✅ A NEW DM ARRIVES LIVE, NAMED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
