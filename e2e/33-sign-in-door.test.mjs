import { launchBrowser, ORIGIN, log, shot } from "./harness.mjs";

// The sign-in screen. It greets you by the hour with the painting that matches, and the
// whole form fits the window: at the desktop app's default size (1180x760) the old card was
// taller than the window, and at its smallest (940x600) more so.
const browser = await launchBrowser();
let failed = false;

async function door(hour, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("  ERR:", e.message));
  // A clock fixed at the hour under test.
  await page.addInitScript((hr) => {
    const Real = Date;
    const fixed = new Real(2026, 9, 5, hr, 12, 0).getTime();
    class Fixed extends Real {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    }
    globalThis.Date = Fixed;
  }, hour);
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ohiyo-door", { timeout: 15000 });
  const state = await page.evaluate(() => {
    const stage = document.querySelector(".ohiyo-door__stage");
    const doorEl = document.querySelector(".ohiyo-door");
    const picture = doorEl.querySelector(".ohiyo-door__sky img");
    return {
      scene: doorEl.dataset.scene,
      greeting: document.querySelector(".ohiyo-door__greeting").textContent.trim(),
      scrolls: stage.scrollHeight - stage.clientHeight,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
      hasPicture: Boolean(picture?.getAttribute("src")),
    };
  });
  return { ctx, page, state };
}

try {
  for (const [hour, scene, greeting] of [[6, "sunrise", "Good morning."], [10, "morning", "Good morning."], [14, "day", "Good afternoon."], [19, "sunset", "Good evening."], [23, "night", "Good evening."], [3, "night", "Still up?"]]) {
    const { ctx, state } = await door(hour, 1180, 760);
    if (state.scene !== scene || state.greeting !== greeting) throw new Error(`at ${hour}:00 the door shows ${JSON.stringify(state)}`);
    if (!state.hasPicture) throw new Error(`no painting at ${hour}:00`);
    await ctx.close();
  }
  log("door: the painting and the greeting follow the hour ✓");

  for (const [width, height] of [[1180, 760], [940, 600]]) {
    const { ctx, page, state } = await door(14, width, height);
    if (state.scrolls > 1) throw new Error(`at ${width}x${height} the sign-in form does not fit: ${state.scrolls}px to scroll`);
    if (state.sideways > 1) throw new Error(`at ${width}x${height} the screen is ${state.sideways}px too wide`);
    if (width === 1180) await shot(page, "33-sign-in-door");
    await ctx.close();
  }
  log("door: the whole form fits the desktop app's default and smallest window ✓");

  // A small phone may scroll, but never sideways, and the way to make an account is reachable.
  const phone = await door(21, 320, 568);
  if (phone.state.sideways > 1) throw new Error(`on a small phone the screen is ${phone.state.sideways}px too wide`);
  await phone.page.getByRole("button", { name: "Create an account" }).click();
  await phone.page.waitForSelector("text=Join Ohiyo", { timeout: 4000 });
  await phone.page.getByRole("button", { name: "Sign in" }).last().click();
  await phone.page.waitForSelector(".ohiyo-door__greeting:has-text('Good evening.')", { timeout: 4000 });
  // Password recovery replaces the old explanation. Both returning to sign-in and
  // linking an existing device remain reachable even on the smallest phone.
  await phone.page.getByRole("button", { name: "Forgot your password?" }).click();
  await phone.page.getByRole("heading", { name: "Reset your password" }).waitFor();
  await phone.page.getByRole("textbox", { name: "Username", exact: true }).fill("recovery_preview");
  await phone.page.getByLabel("Account recovery code", { exact: true }).fill("not-a-real-code");
  await phone.page.getByLabel("New password", { exact: true }).fill("not-a-real-password");
  await phone.page.getByLabel("New password again", { exact: true }).fill("not-a-real-password");
  const reset = phone.page.getByRole("button", { name: "Reset password", exact: true });
  await reset.scrollIntoViewIfNeeded();
  if (!(await reset.isEnabled())) throw new Error("the recovery form cannot be submitted");
  const recoveryWidth = await phone.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (recoveryWidth > 1) throw new Error(`the recovery form spills ${recoveryWidth}px sideways`);
  await phone.page.getByRole("button", { name: "Back to sign in", exact: true }).click();
  await phone.page.getByRole("button", { name: "Forgot your password?" }).click();
  if (await phone.page.getByLabel("Account recovery code", { exact: true }).inputValue()) throw new Error("reopening recovery retained its secret");
  if (await phone.page.getByLabel("New password", { exact: true }).inputValue()) throw new Error("reopening recovery retained its password");
  await phone.page.getByRole("button", { name: "Link a device instead" }).click();
  await phone.page.getByRole("heading", { name: "Link this device" }).waitFor();
  await phone.ctx.close();
  log("door: on a small phone nothing spills sideways and every path is reachable ✓");

  console.log("\n✅ SIGN-IN DOOR PASSED");
} catch (e) {
  failed = true;
  console.error("\n❌ FAILED:", e.message);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
