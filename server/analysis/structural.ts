import type { StructuralDiff, StructuralKind } from "../../shared/types";

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
 * null when the file is absent on that side (added / deleted file).
 */
export function computeStructuralDiff(path: string, kind: StructuralKind, oldText: string | null, newText: string | null): StructuralDiff {
  void oldText;
  void newText;
  // TODO(structural-server): implement lockfile, JSON and YAML diffs.
  return {
    path,
    kind,
    format: kind === "lockfile" ? lockfileFormat(path) : null,
    entries: [],
    truncated: false,
    error: "Structural diff is not implemented yet.",
  };
}
