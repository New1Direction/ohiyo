// Isolated real-component browser tests; no account, server or live YouTube required.
// KIKKA_CHROMIUM=/path/to/chromium npm run test:watch-dream
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const executablePath = process.env.KIKKA_CHROMIUM;
test("Dream mode preserves media, isolates surroundings and cleans up", { skip: !executablePath }, async () => {
  const server = await createServer({ server: { port: 1437, strictPort: true } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1454, height: 864 } });
    // Deliberately stub the cross-origin media, never claim playback was exercised.
    const playerHtml = `<body style="margin:0;background:linear-gradient(120deg,#171c88,#8e9be5);color:white;display:grid;place-items:center;height:100vh"><button style="position:absolute;bottom:16px;left:16px">Video controls (test stand-in)</button><h1>Sharp video center</h1><script>
      let volume = 55;
      window.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.event === 'listening') {
          parent.postMessage(JSON.stringify({event:'onReady'}), '*');
          parent.postMessage(JSON.stringify({event:'infoDelivery',info:{volume,currentTime:48,playerState:2}}), '*');
        }
        if (message.func === 'setVolume') {
          volume = message.args[0];
          parent.postMessage(JSON.stringify({event:'infoDelivery',info:{volume}}), '*');
        }
      });
    </script></body>`;
    await page.route("https://www.youtube-nocookie.com/**", route => route.fulfill({ contentType: "text/html", body: playerHtml }));
    await page.route("https://i.ytimg.com/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><defs><linearGradient id="g"><stop stop-color="#2222a5"/><stop offset="1" stop-color="#adb7df"/></linearGradient></defs><path fill="url(#g)" d="M0 0h480v360H0z"/></svg>' }));
    if (process.env.KIKKA_SHOTS) await mkdir(process.env.KIKKA_SHOTS, { recursive: true });
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
    assert.ok((await page.locator(".kc-watch").boundingBox()).height > bounds.height);
    await page.waitForFunction(() => { const image = document.querySelector(".kc-watch-ambient img"); return image?.complete && image.naturalWidth > 0; });
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
    const rail = page.getByRole("slider", { name: "Your listening volume" });
    await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow") === "55");
    await rail.focus();
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow") === "60");
    const railBounds = await rail.boundingBox();
    const frameBounds = await page.locator("iframe").boundingBox();
    assert.ok(railBounds.x >= frameBounds.x + frameBounds.width, "volume rail never overlays provider");
    await page.mouse.move(railBounds.x + 22, railBounds.y + railBounds.height * .6);
    await page.mouse.down();
    await page.mouse.move(railBounds.x + 22, railBounds.y + railBounds.height * .3, { steps: 6 });
    await page.mouse.up();
    assert.ok(Number(await rail.getAttribute("aria-valuenow")) > 60);
    assert.equal(await frame.evaluate(node => node === document.querySelector("iframe")), true);
    assert.deepEqual(await page.evaluate(() => window.dreamFixture.controls), []);
    const surround = page.locator(".kc-watch-gesture-surround");
    await surround.dblclick({ position: { x: 10, y: 50 } });
    await page.waitForFunction(() => window.dreamFixture.controls.includes("play"));
    await surround.dblclick({ position: { x: 10, y: 50 } });
    await page.waitForFunction(() => window.dreamFixture.controls.includes("pause"));
    await page.setViewportSize({ width: 390, height: 844 });
    if (process.env.KIKKA_SHOTS) await page.screenshot({ path: `${process.env.KIKKA_SHOTS}/watch-dream-mobile.png` });
    const mobileRail = await rail.boundingBox();
    const mobileFrame = await page.locator("iframe").boundingBox();
    assert.ok(mobileRail.x >= mobileFrame.x + mobileFrame.width);
    await page.setViewportSize({ width: 1454, height: 864 });
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
    assert.equal(await page.locator(".kc-watch-gesture-surround").isDisabled(), true);
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
