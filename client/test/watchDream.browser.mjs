// Isolated real-component browser tests; no account, server or live YouTube required.
// KIKKA_CHROMIUM=/path/to/chromium npm run test:watch-dream
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { inflateSync } from "node:zlib";

// Chromium PNG screenshots use 8-bit RGB/RGBA. A 1x1 crop needs no filter-neighbor reconstruction.
function screenshotPixel(png) {
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      assert.equal(png.readUInt32BE(offset + 8), 1);
      assert.equal(png.readUInt32BE(offset + 12), 1);
      assert.equal(png[offset + 16], 8);
      assert.ok([2, 6].includes(png[offset + 17]));
    }
    if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}


const executablePath = process.env.KIKKA_CHROMIUM;
test("Dream mode preserves media, isolates surroundings and cleans up", { skip: !executablePath }, async () => {
  const server = await createServer({ server: { port: 1437, strictPort: true } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1454, height: 864 }, hasTouch: true });
    // Deliberately stub the cross-origin media, never claim playback was exercised.
    const playerHtml = `<body style="margin:0;background:rgb(25,85,245);color:white;display:grid;place-items:center;height:100vh"><button style="position:absolute;bottom:16px;left:16px">Video controls (test stand-in)</button><h1>Sharp video center</h1><button style="position:absolute;bottom:16px;right:16px" onclick="document.body.style.background='rgb(245,40,30)'">Red scene</button><script>
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
    if (process.env.KIKKA_SHOTS) await mkdir(process.env.KIKKA_SHOTS, { recursive: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const load = () => page.goto("http://localhost:1437/test/fixtures/watchDream.html");
    const toggle = page.getByRole("button", { name: "Dream mode" });
    const enabled = () => toggle.getAttribute("aria-pressed");
    await load();
    await page.locator("iframe").waitFor();
    await page.frameLocator("iframe").getByRole("heading", { name: "Sharp video center" }).waitFor();
    const frame = await page.locator("iframe").elementHandle();
    const bounds = await page.locator(".kc-watch").boundingBox();
    await toggle.click();
    assert.equal(await enabled(), "true");
    await page.waitForTimeout(300);
    assert.ok((await page.locator(".kc-watch").boundingBox()).height > bounds.height);
    assert.equal(await page.locator(".kc-watch-ambient img, .kc-watch-dream-edge").count(), 0);
    await page.waitForFunction(() => document.querySelector(".kc-watch-ambient")?.getAttribute("data-ready") === "true");
    const hole = await page.locator(".kc-watch-ambient").evaluate(node => {
      const media = document.querySelector("iframe").getBoundingClientRect();
      const style = getComputedStyle(node);
      const x = parseFloat(style.getPropertyValue("--halo-x"));
      const y = parseFloat(style.getPropertyValue("--halo-y"));
      const width = parseFloat(style.getPropertyValue("--halo-width"));
      const height = parseFloat(style.getPropertyValue("--halo-height"));
      return x < media.left && y < media.top && x + width > media.right && y + height > media.bottom;
    });
    assert.equal(hole, true, "every provider pixel is inside the guarded mask hole");
    const frameWithHalo = await page.locator("iframe").screenshot();
    await page.locator(".kc-watch-ambient").evaluate(node => { node.style.visibility = "hidden"; });
    const frameWithoutHalo = await page.locator("iframe").screenshot();
    assert.deepEqual(frameWithHalo, frameWithoutHalo, "whole iframe pixels remain unaltered");
    await page.locator(".kc-watch-ambient").evaluate(node => node.style.removeProperty("visibility"));
    const colorBounds = await page.locator("iframe").boundingBox();
    const colorClip = { x: Math.floor(colorBounds.x + colorBounds.width / 2), y: Math.floor(colorBounds.y) - 24, width: 1, height: 1 };
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const blue = screenshotPixel(await page.screenshot({ clip: colorClip }));
    if (process.env.KIKKA_SHOTS) await page.screenshot({ path: `${process.env.KIKKA_SHOTS}/watch-dream-live-blue.png` });
    await page.frameLocator("iframe").getByRole("button", { name: "Red scene" }).click();
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const red = screenshotPixel(await page.screenshot({ clip: colorClip }));
    console.log("live-color sample diagnostics", { blue, red, colorClip, colorBounds });
    assert.ok(blue[2] > blue[0] + 10, `blue live halo: ${blue}`);
    assert.ok(red[0] > red[2] + 10, `red live halo: ${red}`);
    console.log("outside-only live-color pixel proof", { blue, red, colorClip });
    if (process.env.KIKKA_SHOTS) await page.screenshot({ path: `${process.env.KIKKA_SHOTS}/watch-dream-live-red.png` });
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
    assert.deepEqual(await page.evaluate(() => window.dreamFixture.positions), [48, 48], "stalled player position, not advancing session clock, drives host gestures");
    const surroundBounds = await surround.boundingBox();
    await page.touchscreen.tap(surroundBounds.x + 10, surroundBounds.y + 50);
    await page.touchscreen.tap(surroundBounds.x + 10, surroundBounds.y + 50);
    await page.waitForFunction(() => window.dreamFixture.controls.length === 3);
    assert.equal(await page.evaluate(() => window.dreamFixture.controls.at(-1)), "play", "real touch sequence includes terminal pointerleave");
    await page.setViewportSize({ width: 390, height: 844 });
    if (process.env.KIKKA_SHOTS) await page.screenshot({ path: `${process.env.KIKKA_SHOTS}/watch-dream-mobile.png` });
    const mobileRail = await rail.boundingBox();
    const mobileFrame = await page.locator("iframe").boundingBox();
    assert.ok(mobileRail.x >= mobileFrame.x + mobileFrame.width);
    await page.waitForFunction(() => {
      const halo = document.querySelector(".kc-watch-ambient");
      const media = document.querySelector("iframe").getBoundingClientRect();
      const style = getComputedStyle(halo);
      const x = parseFloat(style.getPropertyValue("--halo-x"));
      const width = parseFloat(style.getPropertyValue("--halo-width"));
      return x < media.left && x + width > media.right;
    });
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
    assert.equal(await page.locator(".kc-watch-ambient").evaluate(node => getComputedStyle(node).animationName), "none");
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
