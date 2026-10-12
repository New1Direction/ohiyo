// The app serves its own typefaces. Loading them from Google Fonts held back the first paint
// and told Google the IP address of everyone who opened Ohiyo (the privacy page had to say so).
//   node --experimental-strip-types --test test/selfHostedFonts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const client = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

const sources = [
  join(client, "index.html"),
  join(client, "vite.config.ts"),
  join(client, "src-tauri", "tauri.conf.json"),
  ...walk(join(client, "src"), (path) => /\.(css|ts|tsx|html)$/.test(path)),
];
const stylesheets = walk(join(client, "src"), (path) => path.endsWith(".css"));

type FontFace = { file: string; family: string; weight: string; display: string; urls: string[] };

function fontFaces(): FontFace[] {
  return stylesheets.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
      file,
      family: body.match(/font-family:\s*["']?([^"';]+)["']?\s*;/)?.[1].trim() ?? "",
      weight: body.match(/font-weight:\s*([^;]+);/)?.[1].trim() ?? "",
      display: body.match(/font-display:\s*([^;]+);/)?.[1].trim() ?? "",
      urls: [...body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]),
    })),
  );
}

function resolveUrl(stylesheet: string, url: string): string {
  return url.startsWith("/") ? join(client, "public", url) : join(dirname(stylesheet), url);
}

test("nothing in the app loads anything from Google Fonts", () => {
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /fonts\.googleapis\.com|fonts\.gstatic\.com/, `${relative(client, file)} still names Google Fonts`);
  }
});

test("the three typefaces the app uses are its own, in every weight it asks for", () => {
  const faces = fontFaces();
  for (const family of ["Inter", "Sora", "Geist Mono"]) {
    const mine = faces.filter((face) => face.family === family);
    assert.ok(mine.length > 0, `${family} has an @font-face rule`);
    for (const face of mine) {
      assert.equal(face.weight, "400 800", `${family} covers weights 400 to 800`);
      assert.equal(face.display, "swap", `${family} shows text at once, in a fallback, while it loads`);
    }
  }
});

test("every font file named by an @font-face rule is there, with its licence beside it", () => {
  const faces = fontFaces();
  assert.ok(faces.length > 0, "there are @font-face rules");
  for (const face of faces) {
    assert.ok(face.urls.length > 0, `${face.family} names a file`);
    for (const url of face.urls) {
      assert.match(url, /\.woff2$/, `${url} is a woff2 file`);
      const path = resolveUrl(face.file, url);
      assert.ok(existsSync(path), `${url} (from ${relative(client, face.file)}) exists`);
      assert.ok(existsSync(join(dirname(path), "OFL.txt")), `the SIL Open Font License sits beside ${url}`);
    }
  }
});
