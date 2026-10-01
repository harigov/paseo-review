import type { OutlineEntry } from "../../shared/types";
import type { ParsedFile } from "./diff";

// Declaration-level ("outline") diff: which functions, classes, types, etc. were added,
// removed, modified, had their signature changed, were renamed or moved. Deterministic
// regex extraction per language (tree-sitter can replace an extractor later behind the same
// interface). Runs in the analysis pipeline for every supported file in the PR.

export type OutlineSide = "base" | "head";

/** Reads a file's full contents at the merge base ("base") or the PR head ("head"); null when absent. */
export type ReadFile = (side: OutlineSide, path: string) => Promise<string | null>;

export const OUTLINE_LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
};

/** Language id for the outline extractor, or null when the file type isn't supported. */
export function outlineLanguageOf(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return OUTLINE_LANGUAGE_BY_EXT[ext] ?? null;
}

/** Files above this many bytes on either side are skipped (outline = null). */
export const OUTLINE_MAX_BYTES = 200 * 1024;

/**
 * Declaration-level diff for every supported file in the PR. Returns path → entries; null for
 * files that were skipped (binary, unsupported language, too large). Renames and moves are
 * resolved across the whole set of files, so a function that moved between files is reported
 * as "moved" in both files rather than as a removal plus an addition.
 */
export async function computeOutlines(files: ParsedFile[], readFile: ReadFile): Promise<Map<string, OutlineEntry[] | null>> {
  void readFile;
  // TODO(outline-server): implement extraction + categorisation.
  const out = new Map<string, OutlineEntry[] | null>();
  for (const file of files) out.set(file.path, null);
  return out;
}
