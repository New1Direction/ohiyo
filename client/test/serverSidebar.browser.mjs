// Isolated real-component UI coverage; no backend/account required.
// KIKKA_CHROMIUM=/path/to/chromium npm run test:server-sidebar
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const executablePath = process.env.KIKKA_CHROMIUM;
test("home rail uses the brand mark, removes the lightning shortcut and preserves navigation", { skip: !executablePath }, async () => {
  const server = await createServer({ optimizeDeps: { entries: ["test/fixtures/serverSidebar.html"] }, server: { port: 1438, strictPort: true } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 500, height: 650 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://localhost:1438/test/fixtures/serverSidebar.html");
    const official = page.getByRole("button", { name: "Switch to Ohiyo" });
    const custom = page.getByRole("button", { name: "Switch to Friends" });
    await official.waitFor();
    assert.equal(await official.getByRole("img", { name: "Ohiyo" }).count(), 1);
    assert.equal(await official.textContent(), "");
    assert.equal(await custom.textContent(), "FR");
    assert.equal(await page.getByRole("button", { name: "Create or manage Instant Servers" }).count(), 0);
    assert.equal((await page.locator("body").textContent()).includes("⚡"), false);
    for (let i = 0; i < 2; i++) {
      await custom.click();
      assert.equal(await custom.getAttribute("aria-pressed"), "true");
      assert.equal(await official.getAttribute("aria-pressed"), "false");
      await official.focus();
      await page.keyboard.press("Enter");
      assert.equal(await official.getAttribute("aria-pressed"), "true");
    }
    for (const [name, action] of [["Add an Ohiyo home", "add-home"], ["Direct Messages", "dm"], ["Create a space", "create"], ["Saved messages", "saved"]]) {
      await page.getByRole("button", { name, exact: true }).click();
      assert.equal(await page.getByLabel("Last action").textContent(), action);
    }
    for (const theme of ["chrome-blue", "daybreak"]) {
      await page.evaluate(theme => window.setRailTheme(theme), theme);
      const bounds = await official.getByRole("img").boundingBox();
      assert.equal(bounds.width, 23);
      assert.equal(bounds.height, 23);
      if (process.env.KIKKA_SHOTS) await page.screenshot({ path: `${process.env.KIKKA_SHOTS}/home-rail-${theme}.png` });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
