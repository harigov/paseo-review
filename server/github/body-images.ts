// Inlines repo-hosted images in a PR body's GitHub-rendered HTML as data: URIs. Owned by
// workstream E; see docs/plan-round4.md §5.
//
// For private repos, relative image paths in a PR body come back from GitHub's `bodyHTML` as
// URLs that need a GitHub session: `github.com/<o>/<r>/blob|raw/<ref>/<path>` (sometimes with a
// `?raw=true` suffix), the same root-relative to github.com, or
// `raw.githubusercontent.com/<o>/<r>/<ref>/<path>`. Those break in the sandboxed description
// iframe, so we fetch the bytes server-side (where `gh` is authenticated) and inline them.
//
// Fetching: `gh api`'s raw-bytes mode (`-H "Accept: application/vnd.github.raw"`) would hand back
// arbitrary binary on stdout, but `server/core/exec.ts`'s `run()` collects stdout as a `Buffer`
// and then does `.toString("utf8")` — a lossy, one-way trip for bytes that aren't valid UTF-8
// (which most images aren't). Rather than duplicate `run()`'s spawn/timeout/kill handling here
// with a second, Buffer-preserving code path, we use the Contents API's default (JSON) response
// and `--jq .content` to print just the base64 field: base64 is plain ASCII, so it survives the
// Buffer -> utf8 string round trip intact, and we decode it back to bytes ourselves. Files over
// the Contents API's ~1 MB inline cap come back with empty `content`; those are re-fetched by sha
// from the blob API, which returns base64 too.
import { run } from "../core/exec";
import { splitRepo } from "./gh";

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
const CACHE_MAX = 100;
/** Failures are cached only briefly, so a missing/renamed image isn't refetched on every PR
 * load, but a transient error (or a since-fixed path) isn't stuck forever either. */
const FAILURE_TTL_MS = 60_000;

const EXT_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

function mimeForPath(filePath: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(filePath);
  if (!match) return null;
  return EXT_MIME[match[1].toLowerCase()] ?? null;
}

// ---------- attribute entity decoding ----------
// A small local copy (not client/render/html-subset.ts's decodeEntities, which is owned by
// workstream E2 and is for client rendering) — just enough to undo GitHub's `&amp;` etc. in a
// `src` attribute value.
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

function decodeEntities(text: string): string {
  if (!text || text.indexOf("&") === -1) return text;
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const num = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(num);
      } catch {
        return whole;
      }
    }
    const value = NAMED_ENTITIES[body];
    return value !== undefined ? value : whole;
  });
}

// ---------- <img src> scanning ----------

const IMG_SRC_RE = /<img\b[^>]*\ssrc\s*=\s*(["'])([^"']*)\1[^>]*>/gi;
const SRC_ATTR_RE = /\ssrc\s*=\s*(["'])([^"']*)\1/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** If `src` (already entity-decoded) points at a file in `owner/name`, returns the ambiguous
 * "<ref>/<path>" remainder; otherwise null (including when it names a different repo). */
function matchRepoImageUrl(src: string, owner: string, name: string): string | null {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const o = escapeRegExp(owner);
  const r = escapeRegExp(name);
  const patterns = [
    new RegExp(`^https?://github\\.com/${o}/${r}/(?:blob|raw)/(.+)$`, "i"),
    new RegExp(`^/${o}/${r}/(?:blob|raw)/(.+)$`, "i"),
    new RegExp(`^https?://raw\\.githubusercontent\\.com/${o}/${r}/(.+)$`, "i"),
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(withoutQuery);
    if (found?.[1]) return found[1];
  }
  return null;
}

function withSrc(tagText: string, newSrc: string): string {
  return tagText.replace(SRC_ATTR_RE, (_whole, quote: string) => ` src=${quote}${newSrc}${quote}`);
}

function toDataUri(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

// ---------- fetch cache (LRU, ~100 entries; failures expire quickly) ----------

type CacheEntry = { ok: true; bytes: Buffer } | { ok: false; at: number };
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (!entry.ok && Date.now() - entry.at > FAILURE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry); // re-insert at the end (most recently used)
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Fetches the raw bytes of `owner/name@ref:path`, or null when unavailable. Never throws. */
export type FetchBytes = (owner: string, name: string, ref: string, path: string) => Promise<Buffer | null>;

async function cachedFetch(owner: string, name: string, ref: string, path: string, fetchBytes: FetchBytes): Promise<Buffer | null> {
  const key = `${owner}/${name}#${ref}#${path}`;
  const cached = cacheGet(key);
  if (cached) return cached.ok ? cached.bytes : null;
  let bytes: Buffer | null;
  try {
    bytes = await fetchBytes(owner, name, ref, path);
  } catch {
    bytes = null;
  }
  cacheSet(key, bytes ? { ok: true, bytes } : { ok: false, at: Date.now() });
  return bytes;
}

/**
 * Resolves one "<ref>/<path>" remainder to its bytes + mime type. The split between ref and path
 * is ambiguous (branch names can contain slashes), so this tries ref = the first 1, 2, then 3
 * slash-separated segments, stopping at the first split point that fetches successfully.
 */
async function resolveImage(owner: string, name: string, refAndPath: string, fetchBytes: FetchBytes): Promise<{ mime: string; bytes: Buffer } | null> {
  const lastSlash = refAndPath.lastIndexOf("/");
  const fileName = lastSlash === -1 ? refAndPath : refAndPath.slice(lastSlash + 1);
  const mime = mimeForPath(fileName);
  if (!mime) return null; // unsupported/unknown extension — don't even try fetching

  const segments = refAndPath.split("/").filter(Boolean);
  for (let refSegments = 1; refSegments <= 3; refSegments += 1) {
    if (segments.length <= refSegments) continue; // no path left over at this split point
    const ref = segments.slice(0, refSegments).join("/");
    const path = segments.slice(refSegments).join("/");
    const bytes = await cachedFetch(owner, name, ref, path, fetchBytes);
    if (!bytes) continue;
    // A successful fetch means this split point was correct; stop here either way (too big
    // still means "found the right file", not "try another split").
    return bytes.length <= MAX_IMAGE_BYTES ? { mime, bytes } : null;
  }
  return null;
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function lane(): Promise<void> {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
}

/**
 * Rewrites `<img src>` URLs that point at files in `repo` (github.com/<o>/<r>/blob|raw/<ref>/<path>,
 * root-relative /<o>/<r>/blob|raw/..., raw.githubusercontent.com/<o>/<r>/<ref>/<path>) to data:
 * URIs fetched through `fetchBytes`. Those URLs need a GitHub session for private repos, which the
 * sandboxed description iframe doesn't have. Never throws: anything it can't fetch is left as is.
 */
export async function inlineRepoImagesWith(html: string, repo: string, fetchBytes: FetchBytes): Promise<string> {
  try {
    const { owner, name } = splitRepo(repo);
    const matches = [...html.matchAll(IMG_SRC_RE)];
    if (matches.length === 0) return html;

    const eligible: { match: RegExpMatchArray; refAndPath: string }[] = [];
    for (const match of matches) {
      if (eligible.length >= MAX_IMAGES) break;
      const rawSrc = match[2] ?? "";
      const refAndPath = matchRepoImageUrl(decodeEntities(rawSrc).trim(), owner, name);
      if (refAndPath) eligible.push({ match, refAndPath });
    }
    if (eligible.length === 0) return html;

    const replacements = new Map<RegExpMatchArray, string>();
    let totalBytes = 0;
    await runWithConcurrency(eligible, CONCURRENCY, async ({ match, refAndPath }) => {
      const resolved = await resolveImage(owner, name, refAndPath, fetchBytes);
      if (!resolved) return;
      // Synchronous check-then-add (no `await` in between) — safe against the concurrent lanes
      // above despite the shared counter, because nothing else can run until this turn yields.
      if (totalBytes + resolved.bytes.length > MAX_TOTAL_BYTES) return;
      totalBytes += resolved.bytes.length;
      replacements.set(match, toDataUri(resolved.mime, resolved.bytes));
    });
    if (replacements.size === 0) return html;

    let out = "";
    let lastEnd = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      out += html.slice(lastEnd, index);
      const newSrc = replacements.get(match);
      out += newSrc ? withSrc(match[0], newSrc) : match[0];
      lastEnd = index + match[0].length;
    }
    out += html.slice(lastEnd);
    return out;
  } catch {
    return html;
  }
}

async function fetchViaGh(owner: string, name: string, ref: string, path: string): Promise<Buffer | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `repos/${owner}/${name}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  // The contents API only inlines files up to ~1 MB; above that `content` is empty, so fall back
  // to the blob API (base64 up to 100 MB) by sha. Our own 5 MB cap still applies afterwards.
  const result = await run("gh", ["api", url, "--jq", 'if (.content // "") != "" then .content else "sha:" + .sha end'], {
    timeoutMs: FETCH_TIMEOUT_MS,
    allowFailure: true,
  });
  if (result.code !== 0) return null;
  let base64 = result.stdout.replace(/\s+/g, "");
  if (base64.startsWith("sha:")) {
    const sha = base64.slice("sha:".length);
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) return null;
    const blob = await run("gh", ["api", `repos/${owner}/${name}/git/blobs/${sha}`, "--jq", ".content"], {
      timeoutMs: FETCH_TIMEOUT_MS,
      allowFailure: true,
    });
    if (blob.code !== 0) return null;
    base64 = blob.stdout.replace(/\s+/g, "");
  }
  if (!base64 || base64 === "null") return null;
  try {
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

export async function inlineRepoImages(html: string, repo: string): Promise<string> {
  return inlineRepoImagesWith(html, repo, fetchViaGh);
}
