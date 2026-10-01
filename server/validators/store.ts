import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataDir, repoDataFile } from "../core/paths";

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
  const file = repoDataFile(dataDir("validator-state"), repo);
  return readJson<Record<string, boolean>>(file, {});
}

export function writeEnabledState(repo: string, state: Record<string, boolean>): void {
  const file = repoDataFile(dataDir("validator-state"), repo);
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function dismissalFile(repo: string, number: number): string {
  return repoDataFile(dataDir("dismissals"), repo, number);
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
