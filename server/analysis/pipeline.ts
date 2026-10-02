import type { JobUpdate } from "../core/jobs";
import { services } from "../core/services";
import type { Analysis, AnalyzedFile, Module, OutlineEntry, ThreadTriage } from "../../shared/types";
import { extractRichHtml } from "../../shared/rich-html";
import { annotateMovesAndWhitespace, parseUnifiedDiff, type ParsedFile } from "./diff";
import { ensureMirror, fetchPrRefs, mergeBase as computeMergeBase, rawDiff, showFile } from "./git";
import { classifyHeuristic, DEFAULT_MODULES, loadRepoOverride, parseGitAttributes, resolveTaxonomy, type HeuristicResult, type ModuleDef } from "./modules";
import { buildImportGraph, computeChronoOrder, computeFoundationsOrder, computeRiskOrder, toPositionMap } from "./order";
import { computeOutlines } from "./outline";
import { ANALYSIS_VERSION, loadAnalysis, loadOverrides, saveAnalysis } from "./store";
import { structuralKindFor } from "./structural";
import { buildUnitsFromGathered } from "./units";
import { computeViewedFields } from "./viewed";
import { resolveRepo } from "./core";

type Assignment = HeuristicResult & { risk: number | null; complexity: number | null };

function hunkWithMostChange(file: ParsedFile) {
  return file.hunks.reduce<ParsedFile["hunks"][number] | null>((best, h) => {
    const changed = h.lines.filter((l) => l.kind !== "context").length;
    const bestChanged = best ? best.lines.filter((l) => l.kind !== "context").length : -1;
    return changed > bestChanged ? h : best;
  }, null);
}

function hunkToText(hunk: ParsedFile["hunks"][number]): string {
  const lines = [hunk.header, ...hunk.lines.map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text)];
  return lines.join("\n").slice(0, 2000);
}

/** X4: a ±20-line window of `path` at `ref` around `centerLine`, for thread-triage context. */
async function threadContextWindow(mirror: string, ref: string, path: string, centerLine: number | null): Promise<string> {
  if (centerLine === null) return "";
  const content = await showFile(mirror, ref, path);
  if (!content) return "";
  const lines = content.split("\n");
  const start = Math.max(0, centerLine - 20 - 1);
  const end = Math.min(lines.length, centerLine + 20);
  return lines.slice(start, end).join("\n").slice(0, 3000);
}

export async function runAnalysisPipeline(repoSlug: string, number: number, force: boolean, update: JobUpdate): Promise<Analysis> {
  update.stage("fetch", 0.02);
  const repo = await resolveRepo(repoSlug);
  // A10: always fetch a fresh PR head for the short-circuit check below, regardless of
  // `force` (which only means "recompute even if the head hasn't changed"). Reusing `force`
  // as the GitHub refresh flag let the pipeline decide "nothing changed" off of GitHub's own
  // up-to-20s-stale cache, serving a stale analysis right after a push.
  const detail = await services.github.getPr(repoSlug, number, true);
  const headSha = detail.summary.headSha;
  const baseSha = detail.baseSha;
  const baseRef = detail.summary.baseRef;

  const existing = loadAnalysis(repo.slug, number);
  if (!force && existing && existing.headSha === headSha && existing.version === ANALYSIS_VERSION) return existing;

  const mirror = await ensureMirror(repo);
  await fetchPrRefs(mirror, number, baseRef);
  const mergeBaseSha = await computeMergeBase(mirror, baseSha, headSha, baseRef);

  // A7: let a diff-stage failure end the job in error instead of silently saving an empty
  // analysis. `rawDiff` now throws on a non-zero exit or on buffer truncation (previously it
  // always returned `result.stdout`, so any git failure looked exactly like "no changes").
  update.stage("diff", 0.15);
  const raw = await rawDiff(mirror, mergeBaseSha, headSha);
  const parsedFiles: ParsedFile[] = parseUnifiedDiff(raw);
  annotateMovesAndWhitespace(parsedFiles);

  // Declaration-level outline per file. Best-effort: a failure here must not sink the analysis.
  update.stage("outline", 0.22);
  let outlines = new Map<string, OutlineEntry[] | null>();
  try {
    outlines = await computeOutlines(parsedFiles, (side, path) => showFile(mirror, side === "base" ? mergeBaseSha : headSha, path));
  } catch (error) {
    console.error("[pr-review] outline stage failed:", error);
  }

  update.stage("modules", 0.3);
  let taxonomy: ModuleDef[] = DEFAULT_MODULES;
  const assignments = new Map<string, Assignment>();
  try {
    const override = await loadRepoOverride(mirror, headSha);
    taxonomy = resolveTaxonomy(override.modules);
    const gaRaw = await showFile(mirror, headSha, ".gitattributes");
    const gaRules = parseGitAttributes(gaRaw ?? "");
    for (const file of parsedFiles) {
      const h = classifyHeuristic(file.path, file, override.rules, gaRules, taxonomy);
      assignments.set(file.path, { ...h, risk: null, complexity: null });
    }
  } catch (error) {
    console.error("[pr-review] module heuristics failed:", error);
    for (const file of parsedFiles) assignments.set(file.path, { moduleId: "core", source: "fallback", confidence: null, noiseReason: null, risk: null, complexity: null });
  }

  update.stage("decisions", 0.45);
  let decisionError: string | null = null;
  let changeType: string | null = null;
  let severity: number | null = null;
  let severityProbabilities: number[] | null = null;
  const decisionsEnabled = repo.decisionsEnabled;
  let decisionsConfigured = false;
  if (decisionsEnabled) {
    try {
      const status = await services.decide.status();
      decisionsConfigured = status.configured;
      if (status.configured) {
        const candidates = parsedFiles.filter((f) => !f.binary && assignments.get(f.path)?.source === "fallback");
        if (candidates.length > 0) {
          const modulesMap: Record<string, string> = {};
          for (const m of taxonomy) modulesMap[m.id] = m.description;
          const inputs = candidates.map((f) => ({
            path: f.path,
            language: f.path.split(".").pop() ?? "",
            diff: f.hunks.map(hunkToText).join("\n").slice(0, 4000),
            prTitle: detail.summary.title,
            modules: modulesMap,
          }));
          const results = await services.decide.classifyFiles(inputs);
          for (const result of results) {
            const assignment = assignments.get(result.path);
            if (!assignment) continue;
            assignment.risk = result.risk;
            assignment.complexity = result.complexity;
            if (result.noiseProbability !== null && result.noiseProbability >= 0.85) {
              assignment.moduleId = "noise";
              assignment.source = "decision";
              assignment.noiseReason = "decision: mechanical change";
            } else if (result.moduleId && result.moduleConfidence !== null && result.moduleConfidence >= 0.6) {
              assignment.moduleId = result.moduleId;
              assignment.source = "decision";
              assignment.confidence = result.moduleConfidence;
            }
          }
        }

        const ranked = [...parsedFiles].sort((a, b) => (assignments.get(b.path)?.risk ?? -1) - (assignments.get(a.path)?.risk ?? -1));
        const topHunks = ranked
          .slice(0, 5)
          .map((f) => {
            const h = hunkWithMostChange(f);
            return h ? hunkToText(h) : "";
          })
          .filter(Boolean);
        const totals = {
          files: parsedFiles.length,
          additions: parsedFiles.reduce((s, f) => s + f.additions, 0),
          deletions: parsedFiles.reduce((s, f) => s + f.deletions, 0),
        };
        const sev = await services.decide.prSeverity({
          title: detail.summary.title,
          body: detail.body.slice(0, 2000),
          stats: `files=${totals.files} additions=${totals.additions} deletions=${totals.deletions}`,
          topHunks,
        });
        severity = sev.severity;
        severityProbabilities = sev.probabilities;
        changeType = sev.changeType;
      }
    } catch (error) {
      decisionError = error instanceof Error ? error.message : String(error);
      console.error("[pr-review] decision stage failed:", error);
    }
  }

  // X4: thread triage — only for unresolved threads, run in its own try/catch so a failure
  // here doesn't blow away severity/changeType/module results that already succeeded.
  const threadTriage: Record<string, { triage: ThreadTriage; probability: number }> = {};
  if (decisionsEnabled && decisionsConfigured) {
    try {
      const unresolved = detail.threads.filter((t) => !t.isResolved);
      if (unresolved.length > 0) {
        const inputs = await Promise.all(
          unresolved.map(async (t) => {
            const comment = t.comments[t.comments.length - 1]?.body ?? t.comments[0]?.body ?? "";
            const originalHunk = await threadContextWindow(mirror, mergeBaseSha, t.path, t.originalLine ?? t.line);
            const currentHunk = await threadContextWindow(mirror, headSha, t.path, t.line ?? t.originalLine);
            return { threadId: t.id, comment: comment.slice(0, 3000), originalHunk, currentHunk };
          }),
        );
        const triaged = await services.decide.triageThreads(inputs);
        for (const r of triaged) {
          if (r.triage !== null && r.probability !== null) threadTriage[r.threadId] = { triage: r.triage, probability: r.probability };
        }
      }
    } catch (error) {
      decisionError = decisionError ?? (error instanceof Error ? error.message : String(error));
      console.error("[pr-review] thread triage failed:", error);
    }
  }

  // User overrides applied last.
  try {
    const overrides = loadOverrides(repo.slug, number);
    for (const [path, moduleId] of Object.entries(overrides)) {
      const assignment = assignments.get(path);
      if (!assignment) continue;
      assignment.moduleId = moduleId;
      assignment.source = "user";
      assignment.confidence = null;
      assignment.noiseReason = moduleId === "noise" ? "user override" : assignment.noiseReason;
    }
  } catch (error) {
    console.error("[pr-review] overrides failed:", error);
  }

  update.stage("validators", 0.6);
  let validators: Analysis["validators"] = [];
  if (decisionsEnabled && decisionsConfigured) {
    try {
      const { validators: loaded } = await services.validators.loadValidators(repoSlug, { mirrorPath: mirror, ref: headSha });
      const enabled = loaded.filter((v) => v.enabled);
      if (enabled.length > 0) {
        const units = await buildUnitsFromGathered(detail, mirror, headSha, parsedFiles, assignments);
        validators = await services.validators.evaluate({ validators: enabled, units, repo: repoSlug, number });
      }
    } catch (error) {
      decisionError = decisionError ?? (error instanceof Error ? error.message : String(error));
      console.error("[pr-review] validators stage failed:", error);
    }
  }

  update.stage("viewed", 0.75);
  let viewedByPath = new Map<string, { viewed: Analysis["files"][number]["viewed"]; changedSinceLastReview: boolean; rebaseOnly: boolean; changedSinceViewedProbability: number | null }>();
  let sinceAnchorSha: string | null = null;
  try {
    const computed = await computeViewedFields(mirror, detail, repo.owner, repo.name, headSha, baseSha, baseRef, mergeBaseSha, decisionsEnabled);
    viewedByPath = computed.perFile;
    sinceAnchorSha = computed.sinceAnchorSha;
  } catch (error) {
    console.error("[pr-review] viewed stage failed:", error);
  }

  update.stage("order", 0.85);
  const orderable = parsedFiles.map((f) => {
    const a = assignments.get(f.path);
    return { path: f.path, moduleId: a?.moduleId ?? "core", risk: a?.risk ?? null, complexity: a?.complexity ?? null, effectiveLines: f.effectiveLines, binary: f.binary };
  });
  let foundationsOrder: string[] = orderable.map((f) => f.path);
  try {
    const graph = await buildImportGraph(mirror, headSha, orderable.map((f) => f.path));
    foundationsOrder = computeFoundationsOrder(orderable, taxonomy, graph);
  } catch (error) {
    console.error("[pr-review] foundations order failed:", error);
  }
  const riskOrder = computeRiskOrder(orderable);
  let chronoOrder: string[] = orderable.map((f) => f.path);
  try {
    chronoOrder = await computeChronoOrder(mirror, mergeBaseSha, headSha, orderable.map((f) => f.path));
  } catch (error) {
    console.error("[pr-review] chrono order failed:", error);
  }
  const foundationsPos = toPositionMap(foundationsOrder);
  const riskPos = toPositionMap(riskOrder);
  const chronoPos = toPositionMap(chronoOrder);

  const files: AnalyzedFile[] = parsedFiles.map((f) => {
    const a = assignments.get(f.path);
    const v = viewedByPath.get(f.path);
    return {
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      binary: f.binary,
      additions: f.additions,
      deletions: f.deletions,
      effectiveLines: f.effectiveLines,
      movedLines: f.movedLines,
      moduleId: a?.moduleId ?? "core",
      moduleSource: a?.source ?? "fallback",
      moduleConfidence: a?.confidence ?? null,
      noiseReason: a?.noiseReason ?? null,
      risk: a?.risk ?? null,
      complexity: a?.complexity ?? null,
      viewed: v?.viewed ?? "UNVIEWED",
      changedSinceViewedProbability: v?.changedSinceViewedProbability ?? null,
      changedSinceLastReview: v?.changedSinceLastReview ?? false,
      rebaseOnly: v?.rebaseOnly ?? false,
      order: {
        foundations: foundationsPos.get(f.path) ?? 0,
        risk: riskPos.get(f.path) ?? 0,
        chrono: chronoPos.get(f.path) ?? 0,
      },
      outline: outlines.get(f.path) ?? null,
      structuralKind: f.binary ? null : structuralKindFor(f.path),
    };
  });

  const modules: Module[] = taxonomy.map((m) => {
    const inModule = files.filter((f) => f.moduleId === m.id);
    const risks = inModule.map((f) => f.risk).filter((r): r is number => r !== null);
    return {
      id: m.id,
      title: m.title,
      rank: m.rank,
      description: m.description,
      fileCount: inModule.length,
      additions: inModule.reduce((s, f) => s + f.additions, 0),
      deletions: inModule.reduce((s, f) => s + f.deletions, 0),
      effectiveLines: inModule.reduce((s, f) => s + f.effectiveLines, 0),
      maxRisk: risks.length ? Math.max(...risks) : null,
      viewedFiles: inModule.filter((f) => f.viewed === "VIEWED").length,
      summary: existing && existing.headSha === headSha ? existing.modules.find((em) => em.id === m.id)?.summary ?? null : null,
    };
  });

  update.stage("assemble", 0.95);
  const richDescriptionHtml = extractRichHtml(detail.body);

  const guidanceFiles: string[] = [];
  for (const name of ["REVIEW.md", "AGENTS.md", "CLAUDE.md"]) {
    try {
      if ((await showFile(mirror, headSha, name)) !== null) guidanceFiles.push(name);
    } catch {
      // ignore
    }
  }

  const analysis: Analysis = {
    repo: repoSlug,
    number,
    version: ANALYSIS_VERSION,
    headSha,
    baseSha,
    mergeBaseSha,
    analyzedAt: new Date().toISOString(),
    decisionsEnabled,
    decisionError,
    changeType,
    severity,
    severityProbabilities,
    totals: {
      files: parsedFiles.length,
      additions: parsedFiles.reduce((s, f) => s + f.additions, 0),
      deletions: parsedFiles.reduce((s, f) => s + f.deletions, 0),
      effectiveLines: parsedFiles.reduce((s, f) => s + f.effectiveLines, 0),
      movedLines: parsedFiles.reduce((s, f) => s + f.movedLines, 0),
      noiseFiles: files.filter((f) => f.moduleId === "noise").length,
    },
    modules,
    files,
    validators,
    sinceAnchorSha,
    summary: existing && existing.headSha === headSha ? existing.summary : null,
    richDescriptionHtml,
    visualOverviewHtml: existing && existing.headSha === headSha ? existing.visualOverviewHtml : null,
    guidanceFiles,
    threadTriage,
  };

  saveAnalysis(repo.slug, number, analysis);
  return analysis;
}
