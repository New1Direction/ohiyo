// Real settings page, with a fixture profile and no account/backend needed.
// KIKKA_CHROMIUM=/path/to/chromium bun run test:profile-editor
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const executablePath = process.env.KIKKA_CHROMIUM;
test("profile editing, save validation, avatar stacking and responsive layout", { skip: !executablePath }, async () => {
  const server = await createServer({ optimizeDeps: { entries: ["test/fixtures/profileEditor.html"] }, server: { port: 1439, strictPort: true } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const profile = { display_name: "Kikka", username: "Kikka", bio: "Making a little corner of the internet.", custom_status: "Building something cool", banner_color: "#f2683c", profile_theme: { vibe: "sunset", emoji: "✨" }, top_songs: [{ title: "Pink + White", artist: "Frank Ocean", url: "https://open.spotify.com/track/example" }], social_github: "kikka" };
    const writes = [];
    await page.route("**/users/@me/profile", async route => {
      if (route.request().method() !== "GET") writes.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(profile) });
    });
    await page.goto("http://localhost:1439/test/fixtures/profileEditor.html");
    await page.getByRole("button", { name: /^Pink \+ White/ }).waitFor();
    if (process.env.KIKKA_SHOTS) await page.screenshot({ path: `${process.env.KIKKA_SHOTS}/profile-initial.png` });
    await page.getByRole("button", { name: /^Pink \+ White/ }).click();
    await page.getByLabel("Custom status", { exact: true }).fill("A fresh status");
    await page.getByLabel("Song title", { exact: true }).fill("Changed song");
    await page.getByLabel("Listen link", { exact: false }).fill("javascript:alert(1)");
    assert.equal(await page.getByRole("button", { name: "Save profile", exact: true }).isDisabled(), true);
    // Save is disabled: the focus trap must skip hidden song/banner inputs.
    const firstControl = page.getByRole("dialog").getByRole("button").first();
    await firstControl.focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.getByRole("button", { name: "Upload image", exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await firstControl.evaluate(el => el === document.activeElement), true);
    await page.getByLabel("Listen link", { exact: false }).fill("https://youtube.com/watch?v=example");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await page.getByLabel("Save result").filter({ hasText: "Profile saved" }).waitFor();
    assert.equal(writes.at(-1).top_songs[0].title, "Changed song");
    assert.equal(writes.at(-1).custom_status, "A fresh status");
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ["chrome-blue", "daybreak"]) {
        await page.evaluate(theme => window.setProfileTheme(theme), theme);
        await page.locator(".kc-profile-preview").scrollIntoViewIfNeeded();
        assert.equal(await page.locator(".kc-profile-editor").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
        assert.equal(await page.locator(".kc-profile-details").evaluate(el => {
          const avatar = el.firstElementChild.firstElementChild;
          const bounds = avatar.getBoundingClientRect();
          return avatar.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 5));
        }), true);
        if (process.env.KIKKA_SHOTS) await page.screenshot({ path: `${process.env.KIKKA_SHOTS}/profile-${width}-${theme}.png` });
      }
    }
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".kc-profile-editor").count(), 0);
  } finally { await browser?.close(); await server.close(); }
});

test("theme imports preview without saving, reject CSS, and restore on cancel or leaving", { skip: !executablePath }, async () => {
  const server = await createServer({ optimizeDeps: { entries: ["test/fixtures/profileEditor.html"] }, server: { port: 1439, strictPort: true } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const writes = [];
    await page.route("**/users/@me/prefs", async route => {
      if (route.request().method() !== "GET") writes.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.addInitScript(() => localStorage.setItem("kikkacord:accent", "#aa33cc"));
    await page.goto("http://localhost:1439/test/fixtures/profileEditor.html?tab=appearance");
    await page.getByRole("heading", { name: "Make Ohiyo comfy for you." }).waitFor();
    const saved = await page.evaluate(() => localStorage.getItem("kikkacord:theme"));
    const imported = { id: "chrome-blue", name: "Friend's Daybreak", vars: { "--bg-base": "#f4e9dd", "--bg-channel": "#fffcf8", "--accent": "#345678" } };
    const preview = async (value = imported) => {
      const details = page.locator(".kc-advanced-theme");
      if (!await details.evaluate(el => el.open)) await details.locator("summary").click();
      await page.getByRole("textbox", { name: "Theme JSON" }).fill(JSON.stringify(value));
      await page.getByRole("button", { name: "Preview this look", exact: true }).click();
    };
    const color = () => page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"));
    const unchanged = async () => {
      assert.equal(await page.evaluate(() => localStorage.getItem("kikkacord:theme")), saved);
      assert.equal(await page.evaluate(() => localStorage.getItem("kikkacord:custom-themes")), null);
      assert.equal(writes.length, 0);
    };
    await preview({ ...imported, vars: { ...imported.vars, "background-image": "url(https://example.com/track)" } });
    await page.getByRole("alert").filter({ hasText: "known color tokens" }).waitFor();
    assert.equal(await color(), "#aa33cc");
    await unchanged();
    await preview();
    assert.equal(await color(), "#345678");
    await unchanged();
    await page.getByRole("button", { name: "Reset draft colors", exact: true }).click();
    assert.equal(await color(), "#62b0dc");
    await unchanged();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await color(), "#aa33cc");
    await preview();
    await page.getByRole("button", { name: "Voice & video Mic and push to talk" }).click();
    assert.equal(await color(), "#aa33cc");
    await unchanged();
    await page.getByRole("button", { name: "Appearance Colors and comfort" }).click();
    await preview();
    await page.keyboard.press("Escape");
    assert.equal(await color(), "#aa33cc");
    await unchanged();
    await page.getByRole("button", { name: "Open profile", exact: true }).click();
    await preview();
    await page.getByRole("button", { name: "Save this look", exact: true }).click();
    const added = await page.evaluate(() => JSON.parse(localStorage.getItem("kikkacord:custom-themes")));
    assert.equal(added.length, 1);
    assert.equal(added[0].name, imported.name);
    assert.notEqual(added[0].id, imported.id);
    assert.equal(await color(), "#345678");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("kikkacord:theme")).name === "Friend's Daybreak");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole("button", { name: /Customize colors/ }).click();
      assert.equal(await page.locator(".kc-theme-editor").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  } finally { await browser?.close(); await server.close(); }
});

test("caption disclosures remain keyboard accessible inside Settings", { skip: !executablePath }, async () => {
  const server = await createServer({ optimizeDeps: { entries: ["test/fixtures/profileEditor.html"] }, server: { port: 1439, strictPort: true } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto("http://localhost:1439/test/fixtures/profileEditor.html?tab=voice");
    const first = page.getByRole("dialog").getByRole("button").first();
    const measurements = page.locator("summary").filter({ hasText: "Session measurements & evaluation limits" });
    await page.getByRole("button", { name: "Check my mic", exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("summary").filter({ hasText: "Sources & licenses" }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await measurements.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await first.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await measurements.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.equal(await measurements.evaluate(el => el.parentElement.open), true);
  } finally { await browser?.close(); await server.close(); }
});
