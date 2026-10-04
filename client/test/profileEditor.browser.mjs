// Real settings page, with a fixture profile and no account/backend needed.
// KIKKA_CHROMIUM=/path/to/chromium npm run test:profile-editor
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
    await page.getByRole("button", { name: /Pink \+ White/ }).click();
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
