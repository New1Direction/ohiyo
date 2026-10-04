// Bundles one client entry with Vite (an SSR build with every dependency inlined) and
// imports it, so tests under plain `node --test` can load modules that use extensionless
// imports, JSX or browser-only packages. Same setup as chatPaneRender.test.ts.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Alias } from "vite";

export const fixtures = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(fixtures, "..", "..");

type Chunk = { type: string; fileName: string; code?: string; isEntry?: boolean };

export type Bundle<T> = { mod: T; cleanup: () => Promise<void> };

export async function bundleEntry<T>(entry: string, alias: Alias[] = []): Promise<Bundle<T>> {
  const result = await build({
    configFile: false,
    root: clientRoot,
    envDir: fixtures, // no .env here: nothing from a developer's env lands in the bundle
    logLevel: "silent",
    esbuild: { jsx: "automatic" },
    resolve: { alias },
    ssr: { noExternal: true },
    build: { ssr: entry, write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as { output: Chunk[] }[];
  const chunks = outputs[0].output.filter((o) => o.type === "chunk" && o.code);
  const main = chunks.find((o) => o.isEntry);
  if (!main) throw new Error(`vite produced no bundle for ${entry}`);
  const outDir = await mkdtemp(join(tmpdir(), "ohiyo-bundle-"));
  // Write every chunk (a dynamic import would split the bundle), then load the entry.
  for (const c of chunks) {
    const path = join(outDir, c.fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, c.code!);
  }
  const mod = (await import(pathToFileURL(join(outDir, main.fileName)).href)) as T;
  return { mod, cleanup: () => rm(outDir, { recursive: true, force: true }) };
}
