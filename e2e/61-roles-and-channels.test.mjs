import { currentToken, launchBrowser, register, log, settle, shot, uniq } from "./harness.mjs";

// Roles and channels are editable, end to end:
//   • the owner makes #staff private from Channel settings → Permissions and lets the Mods role in;
//   • a plain member doesn't see #staff; given Mods, #staff appears for them live;
//   • the owner gives Mods a colour in the role editor, and the member's name takes it;
//   • the owner renames the space from the space menu, and the member sees the new name.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `rca_${u}`;
const B = `rcb_${u}`;
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
async function openSpaceMenu(page, item) {
  await page.click('.channel-sidebar button[aria-haspopup="menu"]', { timeout: 8000 });
  await page.click(`[role="menuitem"]:has-text("${item}")`, { timeout: 6000 });
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await onboard(pageA, A, "Robin", "Role HQ");
  const tokenA = await currentToken(pageA);

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await onboard(pageB, B, "Sasha", "Sasha HQ");
  const tokenB = await currentToken(pageB);

  const space = json(await api(tokenA, "/servers")).find((s) => s.name === "Role HQ");
  const staff = json(await api(tokenA, `/servers/${space.id}/channels`, { method: "POST", body: JSON.stringify({ name: "staff", channel_type: "text" }) }));
  const mods = json(await api(tokenA, `/servers/${space.id}/roles`, { method: "POST", body: JSON.stringify({ name: "Mods", permissions: 0 }) }));
  const invite = json(await api(tokenA, `/servers/${space.id}/invites`, { method: "POST", body: "{}" }));
  if ((await api(tokenB, `/invites/${invite.code}`, { method: "POST", body: "{}" })).status !== 200) throw new Error("Sasha couldn't join");
  const meB = json(await api(tokenB, "/users/@me"));
  await pageB.click('button[aria-label="Role HQ"]', { timeout: 15000 });
  await pageB.waitForSelector('.channel-sidebar button:has-text("staff")', { timeout: 8000 });
  log("Sasha joined Role HQ and sees #staff while it's public");

  // Sasha is reading #staff when it goes private.
  await pageB.click('.channel-sidebar button:has-text("staff")', { timeout: 8000 });
  await pageB.waitForSelector('textarea[placeholder*="Say something to #staff"]', { timeout: 8000 });

  // ── Make #staff private, Mods only ──
  await pageA.click('.channel-sidebar button:has-text("staff")', { timeout: 8000 });
  await openSpaceMenu(pageA, "Channel settings");
  await pageA.click('[role="tab"]:has-text("Permissions")', { timeout: 6000 });
  await pageA.click('[aria-label="Private channel"]', { timeout: 6000 });
  await pageA.selectOption('select[aria-label="Let a role in"]', mods.id);
  await pageA.waitForSelector('[aria-label="Mods · View channels: Allow"][aria-pressed="true"]', { timeout: 8000 });
  await shot(pageA, "61-roles-channel-permissions-dark");
  await pageA.keyboard.press("Escape");
  log("Robin made #staff private for Mods");

  await pageB.waitForSelector('.channel-sidebar button:has-text("staff")', { state: "detached", timeout: 10000 });
  await pageB.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 8000 });
  log("#staff is gone for Sasha, who is moved to #general");

  if ((await api(tokenA, `/servers/${space.id}/members/${meB.id}/roles/${mods.id}`, { method: "PUT" })).status !== 204) throw new Error("couldn't give Sasha Mods");
  await pageB.waitForSelector('.channel-sidebar button:has-text("staff")', { timeout: 10000 });
  log("given Mods, Sasha sees #staff appear live");

  // ── Colour the Mods role; Sasha's name takes it ──
  await pageB.click('.channel-sidebar button:has-text("general")', { timeout: 8000 });
  await pageB.fill('textarea[placeholder*="Say something to #general"]', "hello from Sasha");
  await pageB.keyboard.press("Enter");
  await openSpaceMenu(pageA, "Roles");
  await pageA.click('button[aria-label="Edit Mods"]', { timeout: 8000 });
  await pageA.fill('input[aria-label="Custom colour"]', "#e0569a");
  await pageA.click('button:has-text("Save changes")');
  await settle(pageA, 400);
  await shot(pageA, "61-roles-editor-dark");
  await pageA.keyboard.press("Escape");
  await pageA.click('.channel-sidebar button:has-text("general")', { timeout: 8000 });
  await pageA.fill('textarea[placeholder*="Say something to #general"]', "hi Sasha");
  await pageA.keyboard.press("Enter");
  const colors = await pageA.waitForFunction(() => {
    const color = (name) => {
      const el = [...document.querySelectorAll(".msg-meta button")].find((b) => b.textContent?.trim() === name);
      return el ? getComputedStyle(el).color : null;
    };
    const sasha = color("Sasha");
    const robin = color("Robin");
    return sasha && robin && sasha !== robin ? { sasha, robin } : null;
  }, null, { timeout: 10000 });
  const { sasha, robin } = await colors.jsonValue();
  await shot(pageA, "61-roles-colored-name-dark");
  log(`Sasha's name is coloured (${sasha}, Robin's stays ${robin})`);

  // ── Rename the space ──
  await openSpaceMenu(pageA, "Rename space");
  await pageA.fill('input[aria-label="Space name"]', "Crew HQ");
  await pageA.click('button:has-text("Rename")');
  await pageB.waitForSelector('.channel-sidebar :text("Crew HQ")', { timeout: 10000 });
  log("Sasha sees the space's new name");

  // ── Shown separately, in the light theme, and on a phone ──
  await pageA.locator('button[aria-label="Settings"]').first().click();
  await pageA.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await pageA.click('button[aria-label="Use theme: Ohiyo Light"]');
  await pageA.keyboard.press("Escape");
  await settle(pageA, 300);
  await openSpaceMenu(pageA, "Roles");
  await pageA.click('button[aria-label="Edit Mods"]', { timeout: 8000 });
  await pageA.click('label:has-text("Show members separately") input[type="checkbox"]');
  await pageA.click('button:has-text("Save changes")');
  await pageA.waitForSelector("text=Saved ✓", { timeout: 6000 });
  await shot(pageA, "61-roles-editor-light");
  await pageA.keyboard.press("Escape");
  await pageA.getByRole("button", { name: /See who's here/i }).click();
  await pageA.waitForSelector('.kc-members-group:has-text("Mods")', { timeout: 8000 });
  await shot(pageA, "61-roles-member-list-light");
  await pageA.keyboard.press("Escape");
  log("Mods shown separately: the member list gives them their own section");

  await pageA.click('.channel-sidebar button:has-text("staff")', { timeout: 8000 });
  await openSpaceMenu(pageA, "Channel settings");
  await pageA.click('[role="tab"]:has-text("Permissions")', { timeout: 6000 });
  await pageA.waitForSelector('[aria-label="Mods · View channels: Allow"][aria-pressed="true"]', { timeout: 8000 });
  await shot(pageA, "61-roles-channel-permissions-light");
  await pageA.keyboard.press("Escape");

  await pageA.setViewportSize({ width: 390, height: 844 });
  await settle(pageA, 400);
  await pageA.locator('button[aria-label="Open channels"]').first().click();
  await settle(pageA, 450);
  await pageA.locator('.kc-nav button[aria-haspopup="menu"]').first().click();
  await pageA.click('.kc-nav [role="menuitem"]:has-text("Channel settings")', { timeout: 6000 });
  await pageA.click('[role="tab"]:has-text("Permissions")', { timeout: 6000 });
  await pageA.waitForSelector('[aria-label="Mods · View channels: Allow"][aria-pressed="true"]', { timeout: 8000 });
  await shot(pageA, "61-roles-channel-permissions-phone");
  await pageA.keyboard.press("Escape");
  await settle(pageA, 300);
  await pageA.getByRole("button", { name: /See who's here/i }).click();
  await pageA.waitForSelector('[role="dialog"].kc-modal--side .kc-members-group:has-text("Mods")', { timeout: 8000 });
  await shot(pageA, "61-roles-member-list-phone");
  await pageA.keyboard.press("Escape");
  log("channel permissions and the role editor shot in light and on a phone");

  log("ROLES AND CHANNELS PASSED");
} catch (e) {
  failed = true;
  console.error("ROLES AND CHANNELS FAILED:", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
