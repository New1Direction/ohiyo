import { launchBrowser, register, log, uniq, PASS } from "./harness.mjs";

// When the server refuses this device's session, the app asks once more who it is before
// going to sign-in (another tab may have a newer session). If that one question failed on
// the network, nothing asked again: the app sat on "Signed out" with no way forward.
//   • The session ends while the app's first checks can't reach the server.
//   • It keeps asking, and lands on sign-in saying why once the server answers.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `retry_${u}`;
const browser = await launchBrowser();
let failed = false;
let page = null;

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, A, "Retry");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Retry HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("signed in");

  // The app's next two "who am I?" checks fail as if offline.
  let dropped = 0;
  await ctx.route("**/api/v1/users/@me", (route) => {
    if (route.request().method() === "GET" && dropped < 2) {
      dropped += 1;
      return route.abort("internetdisconnected");
    }
    return route.continue();
  });

  // End this session from elsewhere: a password change through the API.
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: A, password: PASS }),
  }).then((r) => r.json());
  const changed = await fetch(`${API}/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ current_password: PASS, new_password: "retry-new-pass-99" }),
  });
  if (changed.status !== 200) throw new Error(`password change -> ${changed.status}`);
  log("the session was ended elsewhere");

  await page.waitForSelector("text=/You were signed out on this device/", { timeout: 30000 });
  if (dropped < 2) throw new Error(`only ${dropped} check(s) failed, so the retry wasn't tested`);
  log(`after ${dropped} failed checks it asked again and went to sign-in ✓`);

  console.log("\n✅ SIGNED-OUT CHECK RETRIES PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
  const seen = await page?.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => null);
  if (seen) console.error("  the page shows:", JSON.stringify(seen));
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
