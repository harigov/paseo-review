import type { DepthRule } from "./settings";
import type { AnalyzedFile, DetailLevel, Module } from "./types";

// Review depth ("levels of detail"): how deep a reviewer reads a module or a file.
//   files        — one row per file (header only)
//   declarations — changed classes/functions (the outline), or the key table for JSON/YAML/lockfiles
//   code         — the full diff
// Pure helpers shared by the server (decision-model rules) and the client (module tab, overview).

export const DETAIL_LEVELS: readonly DetailLevel[] = ["files", "declarations", "code"];

export const DETAIL_LEVEL_LABELS: Record<DetailLevel, string> = {
  files: "Files",
  declarations: "Declarations",
  code: "Code",
};

/** A rule matches when the decision model's probability for it is at least this. */
export const DEPTH_RULE_MATCH_THRESHOLD = 0.7;

/** Above this many effective lines a module defaults to Declarations when outlines cover it. */
const LARGE_MODULE_LINES = 600;
/** Share of a module's (non-binary) files that need an outline or structural view for Declarations to be useful. */
const OUTLINE_COVERAGE = 0.6;

export function levelRank(level: DetailLevel): number {
  return DETAIL_LEVELS.indexOf(level);
}

/** The deeper (more detailed) of two levels. */
export function deeperLevel(a: DetailLevel, b: DetailLevel): DetailLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

type ModuleLike = Pick<Module, "id" | "maxRisk" | "effectiveLines">;
type FileLike = Pick<AnalyzedFile, "moduleId" | "binary" | "outline" | "structuralKind">;

/**
 * Deterministic default depth for a module, used when no depth rule produced a recommendation:
 * noise → Files; max risk ≥ 4 → Code; large modules (> 600 effective lines) whose files mostly
 * have an outline or structural view → Declarations; everything else → Code.
 */
export function defaultModuleLevel(module: ModuleLike, files: readonly FileLike[]): DetailLevel {
  if (module.id === "noise") return "files";
  if (module.maxRisk !== null && module.maxRisk >= 4) return "code";
  if (module.effectiveLines > LARGE_MODULE_LINES) {
    const candidates = files.filter((file) => file.moduleId === module.id && !file.binary);
    if (candidates.length > 0) {
      const covered = candidates.filter((file) => (file.outline?.length ?? 0) > 0 || file.structuralKind !== null).length;
      if (covered / candidates.length >= OUTLINE_COVERAGE) return "declarations";
    }
  }
  return "code";
}

export type LevelSource = "user" | "rule" | "default";

/** Effective module depth: the user's choice, else the rule-based recommendation, else the default. */
export function resolveModuleLevel(
  userLevel: DetailLevel | null | undefined,
  module: ModuleLike & Pick<Module, "recommendedLevel">,
  files: readonly FileLike[],
): { level: DetailLevel; source: LevelSource } {
  if (userLevel) return { level: userLevel, source: "user" };
  if (module.recommendedLevel) return { level: module.recommendedLevel, source: "rule" };
  return { level: defaultModuleLevel(module, files), source: "default" };
}

/** Effective file depth: a per-file override, else its module's depth. */
export function resolveFileLevel(fileOverride: DetailLevel | null | undefined, moduleLevel: DetailLevel): DetailLevel {
  return fileOverride ?? moduleLevel;
}

/** Enabled rules with non-blank conditions, in order — the only ones ever sent to the model. */
export function activeDepthRules(rules: readonly DepthRule[]): DepthRule[] {
  return rules.filter((rule) => rule.enabled !== false && rule.when.trim().length > 0);
}

/**
 * Stable fingerprint of the active rules (order matters); "" when there are none. FNV-1a over
 * the normalized JSON — no node:crypto, because the client computes it too.
 */
export function depthRulesHash(rules: readonly DepthRule[]): string {
  const active = activeDepthRules(rules);
  if (active.length === 0) return "";
  const text = JSON.stringify(active.map((rule) => [rule.when.trim(), rule.level]));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v1:${active.length}:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Combines per-rule match results (aligned with `rules`) into one recommendation: the deepest
 * level among matching rules, ties going to the earlier rule; null when nothing matched.
 */
export function pickRuleLevel(rules: readonly DepthRule[], matches: readonly boolean[]): { level: DetailLevel; reason: string } | null {
  let best: { level: DetailLevel; reason: string } | null = null;
  rules.forEach((rule, index) => {
    if (!matches[index]) return;
    if (!best || levelRank(rule.level) > levelRank(best.level)) best = { level: rule.level, reason: rule.when.trim() };
  });
  return best;
}
