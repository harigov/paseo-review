import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SystemOneAnswer } from "../core/services";
import { dataDir } from "../core/paths";

/** Bump whenever the cached `SystemOneAnswer` shape/semantics change (e.g. score indexing) so
 * entries written under old semantics are dropped instead of silently reused as if they still
 * mean the same thing. */
const CACHE_SCHEMA_VERSION = 2;

/** Once the on-disk file holds more than this many entries, compact it down to the most
 * recently-written `MAX_ENTRIES` on next load, so it never grows without bound. */
const MAX_ENTRIES = 20_000;

/**
 * Disk-backed answer cache keyed by sha256(model + state + question). Kept simple and fast:
 * an in-memory Map, lazily hydrated from an append-only JSON-lines file on first use, with
 * new entries appended (not rewritten) as they arrive — except when the file has grown past
 * `MAX_ENTRIES`, when it's compacted (rewritten keeping only the most recent `MAX_ENTRIES`).
 */
export class DecisionCache {
  private map = new Map<string, SystemOneAnswer>();
  /** Insertion order of `map`'s keys, oldest first; used to compact down to the most recent N. */
  private order: string[] = [];
  private loaded = false;
  private readonly file: string;

  constructor(fileName = "cache.jsonl") {
    this.file = path.join(dataDir("decisions"), fileName);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      const text = readFileSync(this.file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { key?: string; answer?: SystemOneAnswer; v?: number };
          if (parsed.key && parsed.answer && parsed.v === CACHE_SCHEMA_VERSION) {
            if (!this.map.has(parsed.key)) this.order.push(parsed.key);
            this.map.set(parsed.key, parsed.answer);
          }
          // Entries with no version, or an older version, were written under semantics we no
          // longer trust (e.g. pre-fix 0/1-indexed score guessing) -- drop them silently; they
          // will simply be re-fetched from the API next time they're needed.
        } catch {
          // skip a corrupt line
        }
      }
    } catch {
      // best effort; start with an empty cache
    }
    if (this.map.size > MAX_ENTRIES) this.compact();
  }

  /** Rewrites the on-disk file keeping only the most recently-written `MAX_ENTRIES` entries. */
  private compact(): void {
    const keep = this.order.slice(-MAX_ENTRIES);
    const keepSet = new Set(keep);
    for (const key of this.order) {
      if (!keepSet.has(key)) this.map.delete(key);
    }
    this.order = keep;
    try {
      const lines = keep.map((key) => `${JSON.stringify({ key, answer: this.map.get(key), v: CACHE_SCHEMA_VERSION })}\n`);
      writeFileSync(this.file, lines.join(""));
    } catch {
      // best effort; keep serving the compacted set from memory even if the rewrite fails
    }
  }

  get(key: string): SystemOneAnswer | undefined {
    this.load();
    return this.map.get(key);
  }

  set(key: string, answer: SystemOneAnswer): void {
    this.load();
    if (this.map.has(key)) return;
    this.map.set(key, answer);
    this.order.push(key);
    try {
      appendFileSync(this.file, `${JSON.stringify({ key, answer, v: CACHE_SCHEMA_VERSION })}\n`);
    } catch {
      // keep the in-memory entry even if persistence fails
    }
    // Compact periodically rather than on every write once we're well past the cap.
    if (this.order.length > MAX_ENTRIES * 1.5) this.compact();
  }
}
