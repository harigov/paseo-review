import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Plugin data lives outside the install root, which `paseo plugin remove` deletes. */
export function dataDir(...segments: string[]): string {
  const home = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
  const dir = path.join(home, "plugin-data", "pr-review", ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SLUG_PART = /^[A-Za-z0-9_.-]+$/;

/**
 * File name for per-repo (and optionally per-PR) data: `<owner>__<name>[__<number>].json`.
 * Rejects anything that is not a plain owner/name slug so callers can't escape `dir`.
 */
export function repoDataFile(dir: string, repo: string, number?: number): string {
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length || !SLUG_PART.test(owner) || !SLUG_PART.test(name) || owner.startsWith(".") || name.startsWith(".")) {
    throw new Error(`Invalid repo slug: ${repo}`);
  }
  if (number !== undefined && !(Number.isInteger(number) && number > 0)) {
    throw new Error(`Invalid PR number: ${number}`);
  }
  const base = number === undefined ? `${owner}__${name}` : `${owner}__${name}__${number}`;
  return path.join(dir, `${base.toLowerCase()}.json`);
}
