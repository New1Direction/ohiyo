import { currentToken, launchBrowser, register, log, uniq } from "./harness.mjs";

// "Add an Ohiyo home" took an invite code as a server address: the code became a home at
// https://<code>, the app switched to it, and every request failed from a sign-in screen.
//   • An address that doesn't answer as an Ohiyo server is refused; nothing changes.
//   • An invite code opens the invite on the current home; no home is added.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `hda_${u}`;
const B = `hdb_${u}`;
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

const storedHomes = (page) =>
  page.evaluate(() => ({ homes: localStorage.getItem("kc:homes:v1"), active: localStorage.getItem("kc:active-home:v1") }));

try {
  const ctxA = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Ha", "Ha HQ");
  const tokenA = await currentToken(pageA);
  const space = (await api(tokenA, "/servers")).body.find((s) => s.name === "Ha HQ");
  const code = (await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" })).body.code;

  const ctxB = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Hb", "Hb HQ");
  const tokenB = await currentToken(pageB);
  const before = await storedHomes(pageB);

  const field = 'input[aria-label="Ohiyo home link"]';
  await pageB.click('button[aria-label="Add an Ohiyo home"]');
  await pageB.waitForSelector(field, { timeout: 6000 });

  // ── An address that isn't an Ohiyo server changes nothing ──
  await pageB.fill(field, "https://nothing-here.invalid");
  await pageB.click('button:has-text("Add home")');
  await pageB.waitForSelector("text=Couldn't reach an Ohiyo home", { timeout: 12000 });
  if (JSON.stringify(await storedHomes(pageB)) !== JSON.stringify(before)) throw new Error("an unreachable address changed the homes");
  if (!(await pageB.locator(field).isVisible())) throw new Error("the dialog closed on a refused address");
  log("an unreachable address is refused, homes unchanged ✓");

  // ── An invite code opens the invite here; no home is added ──
  await pageB.fill(field, code);
  await pageB.click('button:has-text("Add home")');
  await pageB.waitForSelector("text=You're invited to", { timeout: 8000 });
  await pageB.waitForSelector("text=Ha HQ", { timeout: 5000 });
  if (JSON.stringify(await storedHomes(pageB)) !== JSON.stringify(before)) throw new Error("an invite code changed the homes");
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('button[aria-label="Ha HQ"]', { timeout: 12000 });
  if (!(await api(tokenB, "/servers")).body.some((s) => s.id === space.id)) throw new Error("B isn't in Ha HQ");
  log("an invite code in the home dialog opens the invite on this home and joins ✓");

  console.log("\n✅ ADD HOME DIALOG PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
