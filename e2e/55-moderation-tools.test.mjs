import { currentToken, launchBrowser, register, log, settle, shot, uniq, SHOTS } from "./harness.mjs";

// Moderation a space can do without bots, end to end:
//   • the owner puts #general in slowmode; the member's second message has to wait, and the
//     composer counts down;
//   • the owner times the member out from the member list; the member's composer turns into a
//     notice saying until when, live, and comes back when the time out is lifted;
//   • the owner pauses invites from the space menu; a newcomer's invite is turned away.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `mta_${u}`;
const B = `mtb_${u}`;
const C = `mtc_${u}`;
const browser = await launchBrowser();
let failed = false;

const api = async (token, path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, text: await res.text() };
};
const json = (r) => JSON.parse(r.text);

async function onboard(page, username, display, space) {
  await register(page, username, display);
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Mo", "Mo HQ");
  const tokenA = await currentToken(pageA);

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Tilly", "Tilly HQ");
  const tokenB = await currentToken(pageB);

  const space = json(await api(tokenA, "/servers")).find((s) => s.name === "Mo HQ");
  const general = space.channels.find((c) => c.name === "general");
  const invite = json(await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" }));
  if ((await api(tokenB, `/invites/${invite.code}`, { method: "POST", body: "{}" })).status !== 200) throw new Error("B couldn't join");
  await pageB.click('button[aria-label="Mo HQ"]', { timeout: 15000 });
  await pageB.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("Tilly joined Mo HQ");

  // ── Slowmode ──
  await pageA.click('button[aria-label="Slowmode"]', { timeout: 8000 });
  await pageA.waitForSelector('select[aria-label="Slowmode"]', { timeout: 6000 });
  await pageA.selectOption('select[aria-label="Slowmode"]', "10");
  await settle(pageA, 200);
  await shot(pageA, "55-moderation-slowmode-dialog-dark");
  await pageA.click('[role="dialog"] button:has-text("Save")');
  await pageA.waitForSelector('select[aria-label="Slowmode"]', { state: "detached", timeout: 6000 });
  const after = json(await api(tokenA, `/servers/${space.id}`));
  if (after.channels.find((c) => c.id === general.id)?.slowmode_seconds !== 10) throw new Error("slowmode wasn't saved");
  log("the owner set slowmode to 10 seconds ✓");

  await pageB.waitForSelector("text=/Slowmode is on: one message every 10 seconds/", { timeout: 8000 });
  await pageB.fill('textarea[placeholder*="Say something to #general"]', `first ${u}`);
  await pageB.press('textarea[placeholder*="Say something to #general"]', "Enter");
  await pageB.waitForSelector(`text=first ${u}`, { timeout: 8000 });
  await pageB.waitForSelector("text=/You can post again in \\d+s/", { timeout: 4000 });
  await shot(pageB, "55-moderation-slowmode-countdown-dark");
  const tooSoon = await api(tokenB, `/channels/${general.id}/messages`, { method: "POST", body: JSON.stringify({ content: "again" }) });
  if (tooSoon.status !== 429) throw new Error(`a second message went through: ${tooSoon.status}`);
  log("Tilly's second message has to wait, and the composer counts down ✓");
  await api(tokenA, `/channels/${general.id}/slowmode`, { method: "PUT", body: JSON.stringify({ seconds: 0 }) });

  // ── Time out ──
  await pageA.getByRole("button", { name: /See who's here/i }).click();
  await pageA.waitForSelector("text=@" + B, { timeout: 6000 });
  await pageA.getByRole("button", { name: "Time out Tilly" }).click();
  await pageA.waitForSelector("text=Time out Tilly", { timeout: 6000 });
  await pageA.click('label:has-text("5 minutes")');
  await pageA.fill('[aria-label="Reason (optional)"]', "cool off");
  await settle(pageA, 200);
  await shot(pageA, "55-moderation-timeout-dialog-dark");
  await pageA.click('[role="dialog"] button:has-text("Time out")');

  await pageB.waitForSelector("text=/You're timed out until/", { timeout: 8000 });
  if (await pageB.locator('textarea[placeholder*="Say something to #general"]').count()) throw new Error("a timed-out member can still type");
  await shot(pageB, "55-moderation-timeout-notice-dark");
  await pageB.setViewportSize({ width: 390, height: 844 });
  await settle(pageB, 300);
  await shot(pageB, "55-moderation-timeout-notice-phone");
  await pageB.setViewportSize({ width: 1100, height: 800 });
  log("Tilly is told until when, and can't type ✓");

  await pageA.waitForSelector("text=/Timed out until/", { timeout: 6000 });
  await pageA.getByRole("button", { name: "Remove time out for Tilly" }).click();
  await pageB.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 8000 });
  log("lifting the time out gives Tilly the composer back ✓");
  await pageA.keyboard.press("Escape");

  // ── Pause invites ──
  const newcomer = json(await api(null, "/auth/register", { method: "POST", body: JSON.stringify({ username: C, password: "supersecret123" }) }));
  await pageA.click('.channel-sidebar button[aria-haspopup="menu"]');
  await pageA.click('[role="menuitem"]:has-text("Invites")');
  await pageA.waitForSelector('[aria-label="Pause invites"]', { timeout: 6000 });
  await pageA.click('[aria-label="Pause invites"]');
  await pageA.waitForFunction(
    () => document.querySelector('[aria-label="Pause invites"]')?.getAttribute("aria-checked") === "true",
    undefined,
    { timeout: 6000 },
  );
  await shot(pageA, "55-moderation-invites-dark");
  const turnedAway = await api(newcomer.token, `/invites/${invite.code}`, { method: "POST", body: "{}" });
  if (turnedAway.status !== 403 || !/isn't taking new members/.test(turnedAway.text)) throw new Error(`a paused invite let someone in: ${turnedAway.status} ${turnedAway.text}`);
  log("paused invites turn a newcomer away with a reason ✓");

  // Light theme, to look at.
  await pageA.keyboard.press("Escape");
  await pageA.locator('button[aria-label="Settings"]').first().click();
  await pageA.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await pageA.click('button[aria-label="Use theme: Ohiyo Light"]');
  await pageA.keyboard.press("Escape");
  await settle(pageA, 300);
  await pageA.click('.channel-sidebar button[aria-haspopup="menu"]');
  await pageA.click('[role="menuitem"]:has-text("Invites")');
  await pageA.waitForSelector('[aria-label="Pause invites"]', { timeout: 6000 });
  await settle(pageA, 300);
  await shot(pageA, "55-moderation-invites-light");
  await pageA.click('[aria-label="Pause invites"]');
  await pageA.waitForFunction(
    () => document.querySelector('[aria-label="Pause invites"]')?.getAttribute("aria-checked") === "false",
    undefined,
    { timeout: 6000 },
  );
  const back = await api(newcomer.token, `/invites/${invite.code}`, { method: "POST", body: "{}" });
  if (back.status !== 200) throw new Error(`unpausing didn't let them in: ${back.status} ${back.text}`);
  log("resuming invites lets them in ✓");

  console.log("\n✅ MODERATION TOOLS PASSED (slowmode · time out · pause invites)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
  try {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: `${SHOTS}/55-FAIL-${Math.random().toString(36).slice(2, 6)}.png` });
  } catch {}
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
