import { launchBrowser, ORIGIN, register, shot, settle, log, uniq } from "./harness.mjs";
const URL = ORIGIN;

const u = uniq();
const A = `own_${u}`, B = `mem_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Owner");
  await pageA.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Perm HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  await pageA.click('button[aria-label="Invite people"]');
  await pageA.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 6000 });
  const link = await pageA.inputValue('input[aria-label="Invite link"]');
  await pageA.keyboard.press("Escape");
  log("A created Perm HQ");

  // B joins
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(() => localStorage.clear());
  await pageB.goto(link, { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("text=Create an account", { timeout: 8000 });
  await pageB.click("text=Create an account");
  await pageB.fill('input[autocomplete="username"]', B);
  await pageB.fill('input[autocomplete="nickname"]', "Bob");
  await pageB.fill("#kc-password", "supersecret123");
  await pageB.click('button:has-text("Create my account")');
  await pageB.waitForSelector('button:has-text("Accept invite")', { timeout: 12000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("B joined");

  // ── B (no perms) cannot manage roles ──
  await pageB.getByRole("button", { name: /See who's here/i }).click();
  await pageB.waitForSelector("text=/Members ·/", { timeout: 5000 });
  if (await pageB.locator('button:has-text("Manage roles")').count()) {
    throw new Error("B should NOT see Manage roles");
  }
  log("B (no perms) has no Manage-roles button ✓");
  await pageB.keyboard.press("Escape");
  await settle(pageB, 200);
  if (await pageB.locator('button[aria-label="Create channel"]').count()) {
    throw new Error("B should NOT have a create-channel button yet");
  }
  log("B (no perms) has no create-channel button ✓");

  // ── A creates a role with Manage-channels + Kick and assigns it to B ──
  await pageA.getByRole("button", { name: /See who's here/i }).click();
  await pageA.waitForSelector('button:has-text("Manage roles")', { timeout: 5000 });
  await pageA.click('button:has-text("Manage roles")');
  await pageA.waitForSelector("text=Roles & permissions", { timeout: 5000 });
  await pageA.fill('input[aria-label="Role name"]', "Mods");
  await pageA.click('button:has-text("Manage channels")');
  await pageA.click('button:has-text("Kick members")');
  await pageA.click('button:has-text("Create role")');
  // the role appears with an assignment chip for Bob
  await pageA.waitForSelector("text=Mods", { timeout: 6000 });
  await pageA.waitForSelector('button:has-text("Bob")', { timeout: 6000 });
  log("A created the Mods role ✓");
  await shot(pageA, "26-roles");
  await pageA.click('button:has-text("Bob")');
  // chip flips to assigned (✓)
  await pageA.waitForFunction(() => /✓\s*Bob/.test(document.body.innerText), { timeout: 6000 });
  log("A assigned Mods → Bob (chip shows ✓) ✓");
  await shot(pageA, "27-role-assigned");

  // ── LIVE propagation: B gains Manage-channels with NO reload ──
  await pageB.waitForSelector('button[aria-label="Create channel"]', { timeout: 8000 });
  log("B gained Manage-channels LIVE (no reload, via gateway) ✓");

  console.log("\n✅ ROLES & PERMISSIONS FLOW PASSED (perms-gated UI · create role · assign · LIVE propagation)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
