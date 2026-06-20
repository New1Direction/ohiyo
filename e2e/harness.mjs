// Shared E2E harness: resolves a cached Chromium + playwright-core and exposes
// small helpers. Tests import from here instead of hardcoding machine paths.
import { mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// playwright-core is a devDependency of the client.
const pw = require(join(__dirname, "..", "client", "node_modules", "playwright-core", "index.js"));
const { chromium } = pw;

export const ORIGIN = process.env.KIKKA_ORIGIN ?? "http://localhost:1420";
export const SHOTS = process.env.KIKKA_SHOTS ?? "/tmp/kikka-shots";
mkdirSync(SHOTS, { recursive: true });

/** Locate the Playwright-managed "Chrome for Testing" binary (arm64/x64 mac). */
function resolveChromium() {
  if (process.env.KIKKA_CHROMIUM) return process.env.KIKKA_CHROMIUM;
  const cache = join(process.env.HOME, "Library/Caches/ms-playwright");
  for (const arch of ["chrome-mac-arm64", "chrome-mac-x64", "chrome-mac"]) {
    for (const ver of ["chromium-1223", "chromium-1224", "chromium-1187"]) {
      const p = join(cache, ver, arch, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("No cached Chromium found — set KIKKA_CHROMIUM or run `npx playwright install chromium`.");
}

export async function launchBrowser(options = {}) {
  const args = [...(options.args ?? [])];
  if (options.fakeMedia) {
    args.push("--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream");
  }
  return chromium.launch({ executablePath: resolveChromium(), headless: true, args });
}

export const PASS = "supersecret123";
export const log = (...a) => console.log("•", ...a);

export async function currentToken(page) {
  return page.evaluate(() => {
    const legacy = localStorage.getItem("token");
    if (legacy) return legacy;
    const homes = JSON.parse(localStorage.getItem("kc:homes:v1") || "[]");
    const active = localStorage.getItem("kc:active-home:v1");
    return (homes.find((h) => h.id === active) || homes[0] || {}).token || null;
  });
}
export const settle = (page, ms = 300) => page.waitForTimeout(ms);
export const uniq = () => Date.now().toString(36).slice(-6) + Math.floor(performance.now()).toString(36).slice(-2);

export async function shot(page, name) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  await settle(page, 200);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Register a fresh account (clears storage first) and submit. */
export async function register(page, username, displayName) {
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Create an account", { timeout: 10000 });
  await page.click("text=Create an account");
  await page.waitForSelector("text=Join Ohiyo");
  await page.fill('input[autocomplete="username"]', username);
  if (displayName) await page.fill('input[autocomplete="nickname"]', displayName);
  await page.fill("#kc-password", PASS);
  await page.click('button:has-text("Create my account")');
}
