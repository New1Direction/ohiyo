// Isolated real-component browser tests; no account, server or live YouTube required.
// KIKKA_CHROMIUM=/path/to/chromium npm run test:watch-dream
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const executablePath = process.env.KIKKA_CHROMIUM;
test("Dream mode preserves media, isolates surroundings and cleans up", { skip: !executablePath }, async () => {
  const server = await createServer({ server: { port: 1437, strictPort: true } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1454, height: 864 } });
    // Deliberately stub the cross-origin media, never claim playback was exercised.
    await page.route("https://www.youtube-nocookie.com/**", route => route.fulfill({ contentType: "text/html", body: '<body style="margin:0;background:#121319;color:#fff;display:grid;place-items:center;height:100vh"><button>Video controls (test stand-in)</button></body>' }));
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const load = () => page.goto("http://localhost:1437/test/fixtures/watchDream.html");
    const toggle = page.getByRole("button", { name: "Dream mode" });
    const enabled = () => toggle.getAttribute("aria-pressed");
    await load();
    await page.locator("iframe").waitFor();
    const frame = await page.locator("iframe").elementHandle();
    const bounds = await page.locator(".kc-watch").boundingBox();
    await toggle.click();
    assert.equal(await enabled(), "true");
    await page.waitForTimeout(300);
    assert.deepEqual(await page.locator(".kc-watch").boundingBox(), bounds);
    assert.equal(await frame.evaluate(node => node === document.querySelector("iframe")), true);
    assert.equal(await page.locator("aside").evaluate(node => getComputedStyle(node).filter), "blur(12px) brightness(0.8)");
    assert.equal(await page.locator("aside").evaluate(node => node.inert), true);
    assert.equal(await page.locator("footer").evaluate(node => node.inert), true);
    assert.equal(await frame.evaluate(node => {
      for (let el = node; el; el = el.parentElement) if (getComputedStyle(el).filter !== "none" || el.inert) return false;
      return true;
    }), true);
    await page.getByRole("button", { name: "Invite", includeHidden: true }).evaluate(node => node.focus());
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "Cinema", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "End", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("iframe").evaluate(node => node === document.activeElement), true);
    await page.evaluate(() => window.dreamFixture.addSibling());
    await page.waitForFunction(() => document.querySelector("#new-sibling")?.inert);
    await toggle.focus();
    await page.keyboard.press("Escape");
    assert.equal(await enabled(), "false");
    assert.equal(await page.locator("iframe").count(), 1);
    assert.equal(await page.locator("aside").evaluate(node => node.inert), false);
    for (let i = 0; i < 4; i++) await toggle.click();
    assert.equal(await enabled(), "false");
    assert.equal(await frame.evaluate(node => node === document.querySelector("iframe")), true);
    await toggle.click();
    if (process.env.KIKKA_SHOTS) await page.screenshot({ path: `${process.env.KIKKA_SHOTS}/watch-dream-desktop.png` });
    await page.evaluate(() => window.dreamFixture.navigate());
    // External fixture callbacks schedule React work; wait for the new channel commit.
    await page.waitForFunction(() => document.querySelector("main header button")?.textContent === "# another");
    assert.equal(await enabled(), "false");
    assert.equal(await page.locator("[inert]").count(), 0);
    await toggle.click();
    await page.getByRole("button", { name: "End", exact: true }).click();
    assert.equal(await page.locator("iframe").count(), 0);
    assert.equal(await page.locator(".kc-watch-surrounding").count(), 0);
    await load();
    await page.evaluate(() => window.dreamFixture.guest());
    await toggle.click();
    assert.equal(await page.getByRole("button", { name: "End", exact: true }).count(), 0);
    await page.evaluate(() => window.dreamFixture.endRemotely());
    await page.locator("iframe").waitFor({ state: "detached" });
    assert.equal(await page.locator("[inert]").count(), 0);
    await load();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await toggle.click();
    assert.equal(await page.locator("aside").evaluate(node => getComputedStyle(node).transitionDuration), "0s");
    await toggle.click();
    const cinemaFrame = await page.locator("iframe").elementHandle();
    await page.getByRole("button", { name: "Cinema", exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains("kc-watch"));
    assert.equal(await page.locator(".kc-watch").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(0, 0, 0)");
    assert.equal(await cinemaFrame.evaluate(node => node === document.querySelector("iframe")), true);
    await page.getByRole("button", { name: "Exit Cinema", exact: true }).click();
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await cinemaFrame.evaluate(node => node === document.querySelector("iframe")), true);
    await page.evaluate(() => window.dreamFixture.unmount());
    assert.equal(await page.locator(".kc-watch-surrounding, [inert]").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
