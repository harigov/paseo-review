import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../core/paths";

function slugFileName(repo: string): string {
  const [owner, name] = repo.split("/");
  return `${owner || "unknown"}__${name || repo || "unknown"}`;
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Per-repo enable/disable overrides, keyed by validator id. Default (absent) = enabled. */
export function readEnabledState(repo: string): Record<string, boolean> {
  const file = path.join(dataDir("validator-state"), `${slugFileName(repo)}.json`);
  return readJson<Record<string, boolean>>(file, {});
}

export function writeEnabledState(repo: string, state: Record<string, boolean>): void {
  const file = path.join(dataDir("validator-state"), `${slugFileName(repo)}.json`);
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function dismissalFile(repo: string, number: number): string {
  return path.join(dataDir("dismissals"), `${slugFileName(repo)}__${number}.json`);
}

/** Set of "validatorId::unitKey" dismissed finding keys for one PR. */
export function readDismissals(repo: string, number: number): Set<string> {
  const list = readJson<string[]>(dismissalFile(repo, number), []);
  return new Set(list);
}

export function dismissFinding(repo: string, number: number, validatorId: string, unitKey: string): void {
  const set = readDismissals(repo, number);
  set.add(`${validatorId}::${unitKey}`);
  writeFileSync(dismissalFile(repo, number), JSON.stringify([...set], null, 2));
}
