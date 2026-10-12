import { currentToken, launchBrowser, register, log, uniq, PASS } from "./harness.mjs";

// The server could take a member out of a space, or delete a space for its owner, but the
// app had no way to ask for either.
//   • A member opens Space options and leaves: the space leaves their list.
//   • The owner sees Delete, not Leave. A wrong password deletes nothing; the right one
//     deletes the space, and it leaves the owner's list.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `spa_${u}`;
const B = `spb_${u}`;
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
  await onboard(pageA, A, "Sa", "Sa HQ");
  const tokenA = await currentToken(pageA);

  const ctxB = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Sb", "Sb HQ");
  const tokenB = await currentToken(pageB);

  const space = (await api(tokenA, "/servers")).body.find((s) => s.name === "Sa HQ");
  const invite = await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" });
  if ((await api(tokenB, `/invites/${invite.body.code}`, { method: "POST", body: "{}" })).status !== 200) throw new Error("B couldn't join");
  log("B joined A's space");

  // ── A member leaves ──
  await pageB.click('button[aria-label="Sa HQ"]', { timeout: 15000 });
  await pageB.click('button[aria-label="Space options"]');
  await pageB.waitForSelector('button:has-text("Leave space")', { timeout: 6000 });
  if (await pageB.locator('button:has-text("Delete space")').count()) throw new Error("a member is offered Delete space");
  await pageB.click('button:has-text("Leave space")');
  await pageB.waitForSelector('button[aria-label="Sa HQ"]', { state: "detached", timeout: 10000 });
  if ((await api(tokenB, "/servers")).body.some((s) => s.id === space.id)) throw new Error("B is still a member");
  log("B left from Space options, and the space left B's list ✓");

  // ── The owner deletes ──
  await pageA.click('button[aria-label="Space options"]');
  await pageA.waitForSelector('input[aria-label="Your password"]', { timeout: 6000 });
  if (await pageA.locator('button:has-text("Leave space")').count()) throw new Error("the owner is offered Leave space");
  const confirm = 'form[aria-label="Confirm with your password"] button[type="submit"]';
  await pageA.fill('input[aria-label="Your password"]', "not-my-password");
  await pageA.click(confirm);
  await pageA.waitForSelector("text=That isn't your password. Nothing was deleted.", { timeout: 8000 });
  if ((await api(tokenA, `/servers/${space.id}`)).status !== 200) throw new Error("a wrong password deleted the space");
  log("a wrong password deletes nothing ✓");

  await pageA.fill('input[aria-label="Your password"]', PASS);
  await pageA.click(confirm);
  await pageA.waitForSelector('button[aria-label="Sa HQ"]', { state: "detached", timeout: 10000 });
  // Gone, not just left: the owner can't leave, and its invite no longer resolves. (The
  // space's own address answers 403 to anyone who isn't in it, so it can't tell.)
  if ((await api(tokenA, "/servers")).body.some((s) => s.id === space.id)) throw new Error("the space is still A's");
  if ((await api(tokenB, `/invites/${invite.body.code}`)).status !== 404) throw new Error("the space's invite still resolves");
  log("A deleted the space with the password, and it left A's list ✓");

  console.log("\n✅ LEAVE AND DELETE A SPACE PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
