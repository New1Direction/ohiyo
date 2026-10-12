import { currentToken, launchBrowser, register, log, uniq } from "./harness.mjs";

// Someone who already has a space is sent an invite code. The welcome screen's join box is
// gone for them, so the "+" in the space rail has to offer it: paste the code, see the space,
// accept, and land in it. Something that isn't an invite is refused in place.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `jsa_${u}`;
const B = `jsb_${u}`;
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
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Ja", "Ja HQ");
  const tokenA = await currentToken(pageA);
  const space = (await api(tokenA, "/servers")).body.find((s) => s.name === "Ja HQ");
  const invite = await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" });
  const code = invite.body.code;
  log("A made an invite:", code);

  const ctxB = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Jb", "Jb HQ");
  const tokenB = await currentToken(pageB);

  // ── The "+" offers a join box ──
  await pageB.locator('button[aria-label="Add a space"], button[aria-label="Create a space"]').first().click();
  const field = 'input[aria-label="Invite link or code"]';
  await pageB.waitForSelector(field, { timeout: 6000 });
  log("the + button offers a join box ✓");

  // ── Something that isn't an invite is refused in place ──
  await pageB.fill(field, "not an invite!");
  await pageB.click('button:has-text("Join space")');
  await pageB.waitForSelector("text=That isn't an invite link or code.", { timeout: 5000 });
  if (!(await pageB.locator(field).isVisible())) throw new Error("a bad invite closed the box");
  log("a value that isn't an invite is refused in place ✓");

  // ── The code opens the space's invite, and accepting joins it ──
  await pageB.fill(field, code);
  await pageB.click('button:has-text("Join space")');
  await pageB.waitForSelector("text=You're invited to", { timeout: 8000 });
  await pageB.waitForSelector("text=Ja HQ", { timeout: 5000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('button[aria-label="Ja HQ"]', { timeout: 12000 });
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  if (!(await api(tokenB, "/servers")).body.some((s) => s.id === space.id)) throw new Error("B isn't in Ja HQ");
  if (!(await pageB.locator('button[aria-label="Jb HQ"]').count())) throw new Error("B's own space left the rail");
  log("B joined Ja HQ from the + button, and still has Jb HQ ✓");

  console.log("\n✅ JOIN A SPACE FROM THE + BUTTON PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
