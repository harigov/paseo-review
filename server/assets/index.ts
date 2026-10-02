import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handle } from "../core/handle";
import { assetGetRpc, type AssetName } from "../../shared/rpc";

// Serves large client-side runtimes (mermaid) from the plugin's own production dependencies so
// they stay out of the client bundle. Owned by workstream E2; see docs/plan-round4.md §5.
//
// This file must never `require`/`import` the asset's own package (esbuild would then bundle
// its entire tree into this server bundle, defeating the point). Only `fs` is used, at a path
// discovered at runtime, because we couldn't confirm where Paseo's compiled server bundle ends
// up running from relative to the plugin's own `node_modules` — so we try several candidates.

// Chunks are counted in UTF-16 code units of the decoded text (`String.slice`), not raw bytes.
// For the plain-ASCII minified JS this serves, the two are effectively the same; treating the
// cap as approximate keeps the slicing logic simple and the offset/nextOffset cursor opaque to
// the client either way.
const CHUNK_SIZE = 512 * 1024;

const ASSET_RELATIVE_PATH: Record<AssetName, string> = {
  mermaid: path.join("mermaid", "dist", "mermaid.min.js"),
};

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Yields `<ancestor>/node_modules/<relative>` for `start` and every ancestor directory above
 * it, up to the filesystem root — covers the compiled server bundle running from either its own
 * directory or a few levels of wrapper/launcher above it. */
function* nodeModulesCandidates(start: string, relative: string): Generator<string> {
  let dir = path.resolve(start);
  while (true) {
    yield path.join(dir, "node_modules", relative);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** `$PASEO_HOME/plugins/pr-review/<uuid>/checkout/node_modules/<relative>`, most recently
 * modified checkout first — a plugin reinstall can leave an older checkout dir behind.
 * `paseoHome` overrides `$PASEO_HOME`/`~/.paseo`, for tests. */
function pluginCheckoutCandidates(relative: string, paseoHome?: string): string[] {
  const home = paseoHome ?? process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  const pluginsDir = path.join(home, "plugins", "pr-review");
  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    return [];
  }
  const checkouts = entries
    .map((name) => path.join(pluginsDir, name, "checkout"))
    .map((checkout) => {
      try {
        return { checkout, mtime: statSync(checkout).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { checkout: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);
  return checkouts.map((entry) => path.join(entry.checkout, "node_modules", relative));
}

/** First existing candidate across __dirname-relative, cwd-relative, and plugin-checkout
 * locations, in that order; null (not an error) when none of them exist. `roots` overrides the
 * three starting points (real `__dirname`/`process.cwd()`/`$PASEO_HOME` by default) — exported
 * for tests, which can't relocate this module or the process's cwd/env. */
export function findAssetFile(
  name: AssetName,
  roots: { dirnameRoot?: string; cwdRoot?: string; paseoHome?: string } = {},
): string | null {
  const relative = ASSET_RELATIVE_PATH[name];
  const candidates = [
    ...nodeModulesCandidates(roots.dirnameRoot ?? __dirname, relative),
    ...nodeModulesCandidates(roots.cwdRoot ?? process.cwd(), relative),
    ...pluginCheckoutCandidates(relative, roots.paseoHome),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type AssetCacheEntry = { text: string } | { error: string };

// Resolved once per daemon lifetime (the file never changes under a running daemon), so repeat
// `prr.asset.get` calls — one per ≤512 KiB chunk — don't re-walk the candidate list each time.
const cache = new Map<AssetName, AssetCacheEntry>();

function loadAsset(name: AssetName): AssetCacheEntry {
  const cached = cache.get(name);
  if (cached) return cached;
  const filePath = findAssetFile(name);
  const entry: AssetCacheEntry = filePath
    ? readAsset(filePath)
    : { error: `Could not find ${ASSET_RELATIVE_PATH[name]} under any of this plugin's node_modules locations.` };
  cache.set(name, entry);
  return entry;
}

function readAsset(filePath: string): AssetCacheEntry {
  try {
    return { text: readFileSync(filePath, "utf8") };
  } catch (error) {
    return { error: `Could not read ${filePath}: ${errMessage(error)}` };
  }
}

/** Pure chunk slicing: `offset` 0 then each returned `nextOffset` in turn reconstructs `text`
 * in ≤ `CHUNK_SIZE`-unit pieces, ending when `nextOffset` is null. Exported standalone (no fs)
 * so the chunking math is tested without a filesystem fixture. */
export function sliceChunk(text: string, offset: number): { text: string; nextOffset: number | null; total: number } {
  const total = text.length;
  if (offset >= total) return { text: "", nextOffset: null, total };
  const end = Math.min(offset + CHUNK_SIZE, total);
  return { text: text.slice(offset, end), nextOffset: end < total ? end : null, total };
}

export function registerAssetHandlers(server: PluginServerContext): void {
  handle(server, assetGetRpc, async ({ name, offset }) => {
    const entry = loadAsset(name);
    if ("error" in entry) {
      return { text: null, nextOffset: null, total: 0, message: entry.error };
    }
    return { ...sliceChunk(entry.text, offset), message: null };
  });
}
