import { launchBrowser, register, shot, log, uniq } from "./harness.mjs";

// Disappearing messages: A picks a timer in the DM (both sides get the banner via the
// live broadcast); a short TTL makes a sent message actually vanish from view.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `xa_${u}`,
  B = `xb_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Ax");
  await pageA.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Ax HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await register(pageB, B, "Bx");
  await pageB.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await pageB.fill("#kc-space-name", "Bx HQ");
  await pageB.click('button:has-text("Let\'s go")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A + B registered");

  // A opens a DM with B
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Find people"]');
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`button:has-text("@${B}")`, { timeout: 6000 });
  await pageA.click(`button:has-text("@${B}")`);
  await pageA.waitForSelector('input[placeholder="Say something…"]', { timeout: 8000 });
  // A sends a hello so B's DM list shows the conversation
  const hello = pageA.locator('input[placeholder="Say something…"]');
  await hello.fill(`hi-${u}`);
  await hello.press("Enter");
  await pageA.waitForSelector(`text=hi-${u}`, { timeout: 8000 });

  // B opens the DM (reload so the freshly-created DM shows in the list)
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await pageB.click('button[aria-label="Direct Messages"]');
  await pageB.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await pageB.click('button:has-text("Direct Message")');
  await pageB.waitForSelector(`text=hi-${u}`, { timeout: 10000 });
  log("A opened DM with B; both viewing it");

  // A picks a disappearing timer via the header clock → both sides get the banner
  await pageA.click('button[aria-label="Disappearing messages"]');
  await pageA.click('button:has-text("30 seconds")');
  await pageA.waitForSelector("text=/Disappearing messages on/", { timeout: 6000 });
  await pageB.waitForSelector("text=/Disappearing messages on/", { timeout: 8000 });
  log("A set the timer → both A and B show the disappearing banner (live) ✓");
  await shot(pageA, "37-disappearing-on");

  // Shorten to 2s via REST (the picker minimum is 30s — too slow for a test) and send.
  const tokenA = await pageA.evaluate(() => localStorage.getItem("token"));
  const dms = await (await fetch(`${API}/users/@me/dms`, { headers: { Authorization: `Bearer ${tokenA}` } })).json();
  const cid = dms[0]?.id;
  if (!cid) throw new Error("no DM channel via API");
  await fetch(`${API}/channels/${cid}/disappearing`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
    body: JSON.stringify({ seconds: 2 }),
  });

  const poof = `poof-${u}`;
  const composer = pageA.locator('input[placeholder="Say something…"]');
  await composer.fill(poof);
  await composer.press("Enter");
  await pageA.waitForSelector(`text=${poof}`, { timeout: 8000 });
  await pageB.waitForSelector(`text=${poof}`, { timeout: 8000 });
  log("A sent a 2s message; both A and B see it");

  // After the TTL lapses it vanishes locally (no reload) for both clients.
  await pageA.waitForTimeout(4000);
  const aGone = await pageA.locator(`text=${poof}`).count();
  const bGone = await pageB.locator(`text=${poof}`).count();
  if (aGone !== 0) throw new Error(`message still visible to sender (count=${aGone})`);
  if (bGone !== 0) throw new Error(`message still visible to recipient (count=${bGone})`);
  log("message vanished from both A and B after its TTL (no reload) ✓");
  await shot(pageB, "38-disappeared");

  console.log("\n✅ DISAPPEARING MESSAGES PASSED (one-click timer → live banner both sides → message self-destructs)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
