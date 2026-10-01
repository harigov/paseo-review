import type { StructuralDiff, StructuralKind } from "../../shared/types";
import { diffJsonYaml } from "./structural/json-yaml";
import { diffLockfile } from "./structural/lockfiles";

// Structural (table) diffs for files that read badly as text: lockfiles, JSON and YAML.
// Deterministic, no model involvement. `structuralKindFor` runs in the analysis pipeline for
// every file (cheap, name-based); `computeStructuralDiff` runs lazily per file from the
// `prr.file.structural` RPC with the base and head contents already read from the mirror.

const LOCKFILE_FORMATS: Record<string, string> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "pnpm-lock.yaml": "pnpm",
  "cargo.lock": "cargo",
  "poetry.lock": "poetry",
  "go.sum": "go",
  "gemfile.lock": "bundler",
  "composer.lock": "composer",
  "pipfile.lock": "pipenv",
};

function baseName(path: string): string {
  return path.split("/").pop()?.toLowerCase() ?? "";
}

/** Lockfile flavour by file name, or null when the path isn't a known lockfile. */
export function lockfileFormat(path: string): string | null {
  return LOCKFILE_FORMATS[baseName(path)] ?? null;
}

/** Which structural view (if any) a path is eligible for. Name-based so it can run on every file. */
export function structuralKindFor(path: string): StructuralKind | null {
  const base = baseName(path);
  if (LOCKFILE_FORMATS[base]) return "lockfile";
  if (base.endsWith(".json")) return "json";
  if (base.endsWith(".yaml") || base.endsWith(".yml")) return "yaml";
  return null;
}

/**
 * Computes the structural diff of one file between base and head. `oldText` / `newText` are
 * null when the file is absent on that side (added / deleted file). Synchronous, pure, and
 * never throws: any parse failure on either side is reported via `error` with empty entries so
 * the client can fall back to the text diff.
 */
export function computeStructuralDiff(path: string, kind: StructuralKind, oldText: string | null, newText: string | null): StructuralDiff {
  try {
    if (kind === "lockfile") return diffLockfile(path, lockfileFormat(path), oldText, newText);
    return diffJsonYaml(path, kind, oldText, newText);
  } catch (err) {
    return {
      path,
      kind,
      format: kind === "lockfile" ? lockfileFormat(path) : null,
      entries: [],
      truncated: false,
      error: err instanceof Error ? err.message.split("\n")[0] : "Structural diff failed.",
    };
  }
}
