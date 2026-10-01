import { readFileSync, writeFileSync } from "node:fs";
import { dataDir, repoDataFile } from "../core/paths";
import { AnalysisSchema, type Analysis } from "../../shared/types";

/**
 * Bump when the pipeline starts producing data that older cached analyses lack (the UI treats
 * an older version as "not analyzed yet" and re-runs; see `getAnalysis`). The pipeline still
 * reads older caches so agent-generated artifacts (summary, visual overview) carry over.
 *   1: original schema
 *   2: per-file `outline` and `structuralKind`
 */
export const ANALYSIS_VERSION = 2;

/** Latest stored analysis for the PR, any version. Fills schema defaults so older caches still parse. */
export function loadAnalysis(repo: string, number: number): Analysis | null {
  try {
    const raw = readFileSync(repoDataFile(dataDir("analysis"), repo, number), "utf8");
    const parsed = AnalysisSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * X12: refuse to overwrite a newer analysis. Two forced re-analyses can race (join-dedup is
 * skipped for `force`), and a slow job can finish after a newer one already completed — in
 * either case the later write would otherwise clobber fresher data with stale data.
 */
export function saveAnalysis(repo: string, number: number, analysis: Analysis): void {
  const file = repoDataFile(dataDir("analysis"), repo, number);
  try {
    const existing = JSON.parse(readFileSync(file, "utf8")) as Analysis;
    if (existing.analyzedAt && analysis.analyzedAt && existing.analyzedAt > analysis.analyzedAt) return;
  } catch {
    // no existing (or unreadable) analysis — proceed with the write
  }
  writeFileSync(file, JSON.stringify(analysis));
}

export function loadOverrides(repo: string, number: number): Record<string, string> {
  try {
    const raw = readFileSync(repoDataFile(dataDir("overrides"), repo, number), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveOverride(repo: string, number: number, filePath: string, moduleId: string): void {
  const current = loadOverrides(repo, number);
  current[filePath] = moduleId;
  writeFileSync(repoDataFile(dataDir("overrides"), repo, number), JSON.stringify(current));
}
