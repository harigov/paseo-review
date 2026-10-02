// Pure helpers for the Overview "change map" — the Modules level of the levels-of-detail
// feature (docs/plan-round4.md §2). No React imports, so it's unit-testable under the server
// tsconfig like client/diff/rows.ts.

import type { AnalyzedFile, Module } from "../../shared/types";

export type ChangeMapStatus = "new" | "removed" | "changed";

export interface ChangeMapCounts {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  copied: number;
}

export interface ChangeMapRow {
  module: Module;
  counts: ChangeMapCounts;
  /** New when every file is added, Removed when every file is deleted, else Changed. */
  status: ChangeMapStatus;
  /** e.g. "3 new · 5 modified · 1 deleted" (renamed/copied files count as "modified"; zero
   * counts are omitted). */
  countsLabel: string;
}

/** Modules with at least one file, ordered the way the PR screen's rail orders them: noise
 * last, else by rank (PrScreen.tsx's `moduleOrder`). */
export function orderModulesForChangeMap(modules: readonly Module[]): Module[] {
  return modules
    .filter((m) => m.fileCount > 0)
    .slice()
    .sort((a, b) => {
      const aNoise = a.id === "noise" ? 1 : 0;
      const bNoise = b.id === "noise" ? 1 : 0;
      return aNoise - bNoise || a.rank - b.rank;
    });
}

/** Per-status file counts for one module. */
export function countFilesByStatus(moduleId: string, files: readonly AnalyzedFile[]): ChangeMapCounts {
  const counts: ChangeMapCounts = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0 };
  for (const file of files) {
    if (file.moduleId !== moduleId) continue;
    switch (file.status) {
      case "added":
        counts.added += 1;
        break;
      case "modified":
        counts.modified += 1;
        break;
      case "deleted":
        counts.deleted += 1;
        break;
      case "renamed":
        counts.renamed += 1;
        break;
      case "copied":
        counts.copied += 1;
        break;
    }
  }
  return counts;
}

/** New when every file is added, Removed when every file is deleted, else Changed. A module
 * with no files at all (shouldn't happen here — callers filter those out) counts as Changed. */
export function moduleChangeMapStatus(counts: ChangeMapCounts): ChangeMapStatus {
  const total = counts.added + counts.modified + counts.deleted + counts.renamed + counts.copied;
  if (total > 0 && counts.added === total) return "new";
  if (total > 0 && counts.deleted === total) return "removed";
  return "changed";
}

/** "3 new · 5 modified · 1 deleted"-style label; omits zero counts. Renamed and copied files
 * fold into "modified" — they're neither newly added nor removed. */
export function formatChangeMapCounts(counts: ChangeMapCounts): string {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} new`);
  const modified = counts.modified + counts.renamed + counts.copied;
  if (modified > 0) parts.push(`${modified} modified`);
  if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);
  return parts.join(" · ");
}

/** The ordered rows the Overview "change map" renders, one per module with files. */
export function buildChangeMapRows(modules: readonly Module[], files: readonly AnalyzedFile[]): ChangeMapRow[] {
  return orderModulesForChangeMap(modules).map((module) => {
    const counts = countFilesByStatus(module.id, files);
    return { module, counts, status: moduleChangeMapStatus(counts), countsLabel: formatChangeMapCounts(counts) };
  });
}
