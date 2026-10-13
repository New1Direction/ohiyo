// Checks on the design-partner program in /docs/launch: its links land, the copy that goes
// to prospects keeps to what Ohiyo really does (see docs/launch/design-partners/claims.md),
// and the prospect list holds no one's personal contact details.
//   node --experimental-strip-types --test test/launchDocs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "launch", "design-partners");
const docs = readdirSync(dir).filter((name) => name.endsWith(".md"));
const read = (name: string) => readFileSync(join(dir, name), "utf8");

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
const anchors = (markdown: string) =>
  new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));

test("the program has every document the README lists", () => {
  for (const name of [...read("README.md").matchAll(/\]\(([\w-]+\.md)\)/g)].map((m) => m[1])) {
    assert.ok(docs.includes(name), `${name} exists`);
  }
});

test("every relative link lands on a file, and on a heading that exists", () => {
  const broken: string[] = [];
  for (const name of docs) {
    for (const [, url] of read(name).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(url)) continue;
      const [path, anchor] = url.split("#");
      const file = path === "" ? join(dir, name) : resolve(dir, path);
      if (!existsSync(file)) {
        broken.push(`${name} → ${url}`);
      } else if (anchor && file.endsWith(".md") && !anchors(readFileSync(file, "utf8")).has(anchor)) {
        broken.push(`${name} → ${url} (no such heading)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test("the outreach copy says which parts are not encrypted, and links the threat model", () => {
  const first = read("outreach-templates.md").split("## Short version")[0];
  assert.match(first, /channels in a space are not/);
  assert.match(first, /not anonymous/);
  assert.match(first, /https:\/\/ohiyo\.gg\/threat-model\.html/);
});

test("nothing a prospect reads promises what Ohiyo does not do today", () => {
  // claims.md and the internal README name these on purpose, as things not to say.
  for (const name of ["outreach-templates.md", "offer.md", "onboarding-checklist.md"]) {
    const text = read(name);
    assert.doesNotMatch(text, /Instant Server/i, `${name} does not sell Instant Servers`);
    assert.doesNotMatch(text, /\$\s?\d/, `${name} names no price`);
    assert.doesNotMatch(text, /Signal-grade|fully encrypted|metadata-free|untraceable/i, `${name}`);
    assert.doesNotMatch(text, /(?<!not |isn't |aren't )\banonymous\b/i, `${name} never calls Ohiyo anonymous`);
    assert.doesNotMatch(text, /\bSLA\b|uptime guarantee/i, `${name} promises no uptime`);
  }
});

test("the prospect list holds no email addresses or phone numbers", () => {
  const prospects = read("prospects.md");
  assert.doesNotMatch(prospects, /[\w.+-]+@[\w-]+\.[\w.]+/, "no email addresses");
  assert.doesNotMatch(prospects, /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, "no phone numbers");
});
