import { launchBrowser, register, log, shot, uniq } from "./harness.mjs";

// The Plugins settings page: every switch has a name and a state, shows that state
// (the knob used to sit on the "on" side when off), says which plugin it changed, and the
// plugin then does what its line says. Also: ||spoilers|| work with no plugin at all, and
// Focus mode never hides the drawer on a phone.
const browser = await launchBrowser();
let failed = false;

const composer = (page) => page.locator('input[placeholder*="Say something"]');
async function say(page, text) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}
async function openPlugins(page) {
  await page.keyboard.press("Control+,");
  await page.waitForSelector('[role="dialog"] >> text=Plugins', { timeout: 6000 });
  await page.click('[role="dialog"] button:has-text("Plugins")');
  await page.waitForSelector("text=Small extras you can switch on or off", { timeout: 6000 });
}
const pluginSwitch = (page, name) => page.locator(`button[role="switch"][aria-label="${name}"]`);
const knobLeft = (page, name) =>
  pluginSwitch(page, name).evaluate((el) => {
    const track = el.getBoundingClientRect();
    const knob = el.firstElementChild.getBoundingClientRect();
    return Math.round(knob.left - track.left);
  });

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  await register(page, `pl_${uniq()}`, "Plugin Pat");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Plugins HQ");
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // Spoilers need no plugin.
  await say(page, "the ending: ||everyone lives||");
  await page.waitForSelector('button[data-spoiler][aria-pressed="false"]', { timeout: 6000 });
  await page.click("button[data-spoiler]");
  await page.waitForSelector('button[data-spoiler][aria-pressed="true"]', { timeout: 3000 });
  log("||spoilers|| hide and reveal with every plugin off ✓");

  await openPlugins(page);
  const names = await page.locator('button[role="switch"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  if (names.length < 6 || names.some((n) => !n)) throw new Error(`plugin switches need names: ${JSON.stringify(names)}`);
  if (await page.locator("text=/v1\\.0\\.0|ES module/").count()) throw new Error("developer text is still on the page");
  log(`plugins page: ${names.length} named switches, no developer text ✓`);
  await shot(page, "29-plugins-page");

  // Off looks off, on looks on.
  const offLeft = await knobLeft(page, "Big emoji");
  if ((await pluginSwitch(page, "Big emoji").getAttribute("aria-checked")) !== "false") throw new Error("Big emoji should start off");
  await pluginSwitch(page, "Big emoji").click();
  await page.waitForSelector('button[role="switch"][aria-label="Big emoji"][aria-checked="true"]', { timeout: 3000 });
  await page.waitForSelector("text=Big emoji is on", { timeout: 4000 });
  await page.waitForFunction(
    ([name, from]) => {
      const el = document.querySelector(`button[role="switch"][aria-label="${name}"]`);
      return el.firstElementChild.getBoundingClientRect().left - el.getBoundingClientRect().left >= from + 16;
    },
    ["Big emoji", offLeft],
    { timeout: 3000 },
  ).catch(() => { throw new Error("the knob did not move to the on side"); });
  if (offLeft > 4) throw new Error(`the knob sat ${offLeft}px in while off: off looked like on`);
  log("switch: off sits left, on sits right, and the toast names the plugin ✓");
  await shot(page, "29-plugins-on");

  // The choice survives a reload, and the plugin does what it says.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  await say(page, "🎉");
  await page.waitForSelector(".big-emoji-char", { timeout: 6000 });
  log("Big emoji stays on after a reload and enlarges an emoji-only message ✓");

  // Focus mode: sidebars go on a wide window, Ctrl+, still reaches Settings.
  await openPlugins(page);
  await pluginSwitch(page, "Focus mode").click();
  await page.waitForSelector("text=Focus mode is on", { timeout: 4000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".channel-sidebar", { state: "hidden", timeout: 4000 });
  log("Focus mode hides the sidebars on a wide window ✓");

  // On a phone the sidebars are the drawer; Focus mode must leave it alone.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.locator('button[aria-label="Open channels"]').first().click();
  await page.waitForSelector(".kc-nav >> text=TEXT CHANNELS", { state: "visible", timeout: 4000 });
  log("Focus mode leaves the phone drawer alone ✓");
  await page.locator(".kc-nav button").filter({ hasText: /^general/ }).first().click();

  await page.setViewportSize({ width: 1280, height: 860 });
  await openPlugins(page);
  await pluginSwitch(page, "Focus mode").click();
  await page.waitForSelector("text=Focus mode is off", { timeout: 4000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".channel-sidebar", { state: "visible", timeout: 4000 });
  log("Ctrl+, opens Settings in Focus mode, and switching it off brings the sidebars back ✓");

  console.log("\n✅ PLUGINS PAGE PASSED");
} catch (err) {
  failed = true;
  console.error("\n❌ PLUGINS PAGE FAILED:", err?.message ?? err);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
