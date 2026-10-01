import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SystemOneAnswer } from "../core/services";
import { dataDir } from "../core/paths";

/**
 * Disk-backed answer cache keyed by sha256(model + state + question). Kept simple and fast:
 * an in-memory Map, lazily hydrated from an append-only JSON-lines file on first use, with
 * new entries appended (not rewritten) as they arrive.
 */
export class DecisionCache {
  private map = new Map<string, SystemOneAnswer>();
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
          const { key, answer } = JSON.parse(line) as { key: string; answer: SystemOneAnswer };
          if (key && answer) this.map.set(key, answer);
        } catch {
          // skip a corrupt line
        }
      }
    } catch {
      // best effort; start with an empty cache
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
    try {
      appendFileSync(this.file, `${JSON.stringify({ key, answer })}\n`);
    } catch {
      // keep the in-memory entry even if persistence fails
    }
  }
}
