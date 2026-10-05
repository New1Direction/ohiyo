// Checks on the static landing site in /site (ohiyo.gg). It has no build step, so nothing else
// catches a broken link, a missing image or a claim the hosted service no longer keeps.
//   node --experimental-strip-types --test test/siteLanding.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "site");
const pages = readdirSync(site).filter((name) => name.endsWith(".html"));
const css = readFileSync(join(site, "site.css"), "utf8");

function parse(page: string) {
  const window = new Window();
  window.document.write(readFileSync(join(site, page), "utf8"));
  return window.document;
}

const isExternal = (url: string) => /^(https?:)?\/\//.test(url);
const isSkippable = (url: string) => url === "" || url.startsWith("mailto:") || url.startsWith("data:");
/** "/#how" and "page.html#x" → the file that should exist, and the anchor in it. */
function target(url: string, from: string): { file: string; anchor: string } {
  const [path, anchor = ""] = url.split("#");
  const clean = path.split("?")[0];
  const file = clean === "" ? from : clean === "/" ? "index.html" : clean.replace(/^\//, "");
  return { file, anchor };
}
/** Every URL a page loads as a resource (not links people click). */
function resources(document: ReturnType<typeof parse>): string[] {
  const urls: string[] = [];
  for (const el of document.querySelectorAll("img[src], script[src], link[href], source[src]")) {
    urls.push(el.getAttribute("src") ?? el.getAttribute("href") ?? "");
  }
  for (const el of document.querySelectorAll("img[srcset], source[srcset]")) {
    for (const part of (el.getAttribute("srcset") ?? "").split(",")) urls.push(part.trim().split(/\s+/)[0]);
  }
  // <link rel="canonical"> is a pointer, not a download.
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  return urls.filter((url) => url !== canonical);
}
const cssUrls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);

test("the site has the pages people link to", () => {
  for (const page of ["index.html", "privacy.html", "terms.html", "threat-model.html", "status.html"]) {
    assert.ok(pages.includes(page), `${page} exists`);
  }
});

test("every file a page or the stylesheet loads exists", () => {
  const missing: string[] = [];
  for (const page of pages) {
    for (const url of resources(parse(page))) {
      if (isExternal(url) || isSkippable(url)) continue;
      if (!existsSync(join(site, target(url, page).file))) missing.push(`${page} → ${url}`);
    }
  }
  for (const url of cssUrls) {
    if (!isExternal(url) && !isSkippable(url) && !existsSync(join(site, url))) missing.push(`site.css → ${url}`);
  }
  assert.deepEqual(missing, []);
});

test("every internal link lands on a page and an anchor that exist", () => {
  const broken: string[] = [];
  const documents = new Map(pages.map((page) => [page, parse(page)]));
  for (const [page, document] of documents) {
    for (const link of document.querySelectorAll("a[href]")) {
      const url = link.getAttribute("href") ?? "";
      if (isExternal(url) || isSkippable(url)) continue;
      const { file, anchor } = target(url, page);
      const destination = documents.get(file);
      if (!destination) broken.push(`${page} → ${url} (no such page)`);
      else if (anchor && !destination.getElementById(anchor)) broken.push(`${page} → ${url} (no such anchor)`);
    }
  }
  assert.deepEqual(broken, []);
});

test("pages load nothing from other websites (fonts and scripts are self-hosted)", () => {
  const thirdParty: string[] = [];
  for (const page of pages) {
    for (const url of resources(parse(page))) if (isExternal(url)) thirdParty.push(`${page} → ${url}`);
  }
  for (const url of cssUrls) if (isExternal(url)) thirdParty.push(`site.css → ${url}`);
  assert.equal(/@import/.test(css), false, "the stylesheet imports nothing");
  assert.deepEqual(thirdParty, []);
});

test("every image says what it is and reserves its space", () => {
  const problems: string[] = [];
  for (const page of pages) {
    for (const img of parse(page).querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (!img.hasAttribute("alt")) problems.push(`${page}: ${src} has no alt`);
      if (page !== "og.html" && (!img.getAttribute("width") || !img.getAttribute("height"))) problems.push(`${page}: ${src} has no width/height`);
    }
  }
  assert.deepEqual(problems, []);
});

test("each page has one main heading and a way to skip to the content", () => {
  for (const page of pages.filter((name) => name !== "og.html")) {
    const document = parse(page);
    assert.equal(document.querySelectorAll("h1").length, 1, `${page} has exactly one h1`);
    assert.ok(document.querySelector("main#main"), `${page} has <main id="main">`);
    assert.equal(document.querySelector("a.skip-link")?.getAttribute("href"), "#main", `${page} has a skip link`);
    assert.ok((document.querySelector("title")?.textContent ?? "").length > 5, `${page} has a title`);
  }
});

test("the site does not promise what the hosted service does not do today", () => {
  for (const page of pages) {
    const html = readFileSync(join(site, page), "utf8");
    // The hosted server moved off Fly, and the released desktop builds still point at the old one.
    assert.equal(/fly\.dev/.test(html), false, `${page} does not name the old server`);
    assert.equal(/releases\/(latest\/)?download/.test(html), false, `${page} does not offer the outdated desktop builds`);
  }
  const home = readFileSync(join(site, "index.html"), "utf8");
  // Instant Servers are off on the hosted service.
  assert.equal(/Instant Server/i.test(home), false, "the home page does not advertise Instant Servers");
  // Channels in a space are not end-to-end encrypted, and the page has to say so.
  assert.match(home, /Channels inside a space\. Our server can read those/);
});

test("the landscape is decoration, and matches the script that draws it", () => {
  const document = parse("index.html");
  const scenes = [...document.querySelectorAll(".scene")];
  assert.equal(scenes.length, 4, "meadow, night, sunrise and morning");
  for (const scene of scenes) assert.equal(scene.getAttribute("aria-hidden"), "true", "hidden from screen readers");
  // The scenes are generated. Editing them by hand would be lost on the next run.
  const check = spawnSync("python3", [join(site, "..", "scripts", "site-scenery.py"), "--check"], { encoding: "utf8" });
  if (check.error) return; // no python3 on this machine
  assert.equal(check.status, 0, check.stderr || check.stdout);
});
