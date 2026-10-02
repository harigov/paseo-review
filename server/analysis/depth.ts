import type { Analysis } from "../../shared/types";
import type { ModuleDepthInput } from "../core/services";
import { services } from "../core/services";
import { depthRulesHash } from "../../shared/levels";
import { getSettings } from "../core/settings";
import { resolveRepo } from "./core";
import { loadAnalysis, saveAnalysis } from "./store";

// Review depth from the user's rules (Settings → Review depth), via the decision model.
// Owned by workstream F; see docs/plan-round4.md §2.

/** Per-module caps so a module with hundreds of files/declarations doesn't blow up the request. */
const MAX_FILES_PER_MODULE = 60;
const MAX_DECLARATIONS_PER_MODULE = 80;

function fileLine(file: Pick<Analysis["files"][number], "status" | "path" | "additions" | "deletions">): string {
  return `${file.status} ${file.path} (+${file.additions} -${file.deletions})`;
}

/** "<change> <kind> <name>" per changed declaration across a module's files, capped. */
function declarationLines(files: readonly Analysis["files"][number][]): string[] {
  const lines: string[] = [];
  for (const file of files) {
    if (!file.outline) continue;
    for (const entry of file.outline) {
      lines.push(`${entry.change} ${entry.kind} ${entry.name}`);
      if (lines.length >= MAX_DECLARATIONS_PER_MODULE) return lines;
    }
  }
  return lines;
}

/** Clears any previously computed recommendation (used when depth can't/shouldn't be recomputed). */
function withNullDepth(modules: Analysis["modules"]): Analysis["modules"] {
  return modules.map((m) => ({ ...m, recommendedLevel: null, levelReason: null }));
}

/**
 * Pipeline stage: fills `recommendedLevel` / `levelReason` on each module and returns the
 * `depthRulesHash` they were computed from. Best-effort — never throws; on any failure (or no
 * rules, or the repo not opted in) modules keep null and the hash is still returned so the
 * client doesn't loop on recompute.
 */
export async function computeModuleDepth(
  analysis: Pick<Analysis, "repo" | "modules" | "files" | "decisionsEnabled"> & { prTitle: string },
): Promise<{ modules: Analysis["modules"]; depthRulesHash: string }> {
  const settings = await getSettings();
  const rules = settings.reviewDepth.rules;
  const hash = depthRulesHash(rules);

  // No active rules, or the repo hasn't opted in to sending code off-machine: the client falls
  // back to `defaultModuleLevel` on its own, so there's nothing to compute here.
  if (hash === "" || !analysis.decisionsEnabled) {
    return { modules: withNullDepth(analysis.modules), depthRulesHash: hash };
  }

  try {
    const status = await services.decide.status();
    if (!status.configured) return { modules: withNullDepth(analysis.modules), depthRulesHash: hash };

    // Every module with files, except `noise` — it defaults to Files regardless of what a rule
    // would say, so asking the model about it would be wasted work.
    const candidates = analysis.modules.filter((m) => m.fileCount > 0 && m.id !== "noise");
    if (candidates.length === 0) return { modules: withNullDepth(analysis.modules), depthRulesHash: hash };

    const filesByModule = new Map<string, Analysis["files"][number][]>();
    for (const file of analysis.files) {
      const list = filesByModule.get(file.moduleId);
      if (list) list.push(file);
      else filesByModule.set(file.moduleId, [file]);
    }

    const inputs: ModuleDepthInput[] = candidates.map((module) => {
      const files = filesByModule.get(module.id) ?? [];
      return {
        moduleId: module.id,
        title: module.title,
        description: module.description,
        prTitle: analysis.prTitle,
        stats: `files=${module.fileCount} additions=${module.additions} deletions=${module.deletions} effective_lines=${module.effectiveLines} max_risk=${module.maxRisk ?? "none"}`,
        files: files.slice(0, MAX_FILES_PER_MODULE).map(fileLine),
        declarations: declarationLines(files),
      };
    });

    const results = await services.decide.reviewDepth(inputs, rules);
    const resultByModuleId = new Map(candidates.map((module, i) => [module.id, results[i]]));
    const modules = analysis.modules.map((m) => {
      const result = resultByModuleId.get(m.id) ?? null;
      return { ...m, recommendedLevel: result?.level ?? null, levelReason: result?.reason ?? null };
    });
    return { modules, depthRulesHash: hash };
  } catch (error) {
    console.error("[pr-review] review-depth stage failed:", error);
    return { modules: withNullDepth(analysis.modules), depthRulesHash: hash };
  }
}

/** Recomputes depth for the cached analysis of `slug#number` and patches it in place. */
export async function recomputeDepth(slug: string, number: number): Promise<void> {
  const analysis = loadAnalysis(slug, number);
  if (!analysis) return;
  // Re-resolve the repo's *current* decision opt-in rather than trusting the cached analysis's
  // `decisionsEnabled`, which reflects whatever it was when the pipeline last ran — the whole
  // point of a standalone recompute is to react to settings changes without a full re-run.
  const repo = await resolveRepo(slug);
  const detail = await services.github.getPr(slug, number);
  const { modules, depthRulesHash: hash } = await computeModuleDepth({
    repo: slug,
    modules: analysis.modules,
    files: analysis.files,
    decisionsEnabled: repo.decisionsEnabled,
    prTitle: detail.summary.title,
  });
  saveAnalysis(slug, number, { ...analysis, modules, depthRulesHash: hash });
}
