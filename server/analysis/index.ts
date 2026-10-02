import type { PluginServerContext } from "@getpaseo/plugin/server";
import { pollJob, startJob } from "../core/jobs";
import { handle } from "../core/handle";
import { services } from "../core/services";
import type { AnalysisService, ValidationUnit } from "../core/services";
import { depthRecomputeRpc, FILE_LINES_MAX, fileDiffRpc, fileLinesRpc, fileMoveRpc, fileStructuralDiffRpc, jobPollRpc, prAnalysisRpc, prAnalyzeRpc } from "../../shared/rpc";
import type { Analysis, FileDiff, PrDetail, StructuralDiff } from "../../shared/types";
import { annotateMovesAndWhitespace, countLines, parseUnifiedDiff, toFileDiff } from "./diff";
import { ensureMirror, fetchPrRefs, fetchSha, grepAtRef, mergeBase as computeMergeBase, objectExists, rawDiff, showFile } from "./git";
import { resolveRepo, resolvePrRefs } from "./core";
import { recomputeDepth } from "./depth";
import { runAnalysisPipeline } from "./pipeline";
import { ANALYSIS_VERSION, loadAnalysis, saveAnalysis, saveOverride } from "./store";
import { computeStructuralDiff, structuralKindFor } from "./structural";
import { buildLocalUnits, buildPrUnits } from "./units";
import { getLocalViewedRecords } from "../github/viewed-store";

/**
 * `repo` in every `AnalysisService` call is whatever the RPC input validated (owner/name
 * shape, but not necessarily the canonical casing — `findRepo` is case-insensitive and
 * returns the canonical slug). Store files are keyed by that canonical slug via
 * `repoDataFile`, so every store.ts call must use it, not the raw input string, or two
 * different-cased calls for the same repo fragment into different cache files (and a
 * genuinely malformed string reaches `repoDataFile` with no owner/name to report).
 */
/** Small LRU for per-file structural diffs: deterministic per (merge base, head, path), and the
 * YAML parse of a big lockfile is the slow part of that RPC. */
const STRUCTURAL_CACHE_MAX = 200;
const structuralCache = new Map<string, StructuralDiff>();
function cacheStructural(key: string, value: StructuralDiff): StructuralDiff {
  structuralCache.delete(key);
  structuralCache.set(key, value);
  if (structuralCache.size > STRUCTURAL_CACHE_MAX) {
    const oldest = structuralCache.keys().next().value;
    if (oldest !== undefined) structuralCache.delete(oldest);
  }
  return value;
}

async function canonicalSlug(repo: string): Promise<string> {
  try {
    return (await resolveRepo(repo)).slug;
  } catch {
    return repo;
  }
}

/**
 * A8: per-file RPCs run inside a 30s-capped RPC, not a job — never do an unbounded network
 * fetch there. If the head is already mirrored (the common case: an analysis job already ran),
 * skip the network entirely. If not, try a short, bounded fetch; if that still doesn't get us
 * the head, fail with a clear, actionable error instead of hanging the RPC.
 */
async function ensureHeadMirrored(mirror: string, detail: PrDetail, number: number): Promise<void> {
  const headSha = detail.summary.headSha;
  if (await objectExists(mirror, headSha)) return;
  await fetchPrRefs(mirror, number, detail.summary.baseRef, 20_000);
  if (!(await objectExists(mirror, headSha))) {
    throw new Error(`PR #${number}'s head commit isn't mirrored locally yet. Re-run analysis, then try again.`);
  }
}

export function createAnalysisService(): AnalysisService {
  return {
    startAnalysis(repo, number, options) {
      // X12: dedupe forced re-analyses too. A bare `repo#number` key (not keyed by cached head
      // or by force) means a second force request made while one is already running joins
      // that job instead of kicking off a redundant concurrent pipeline run against the same
      // mirror. `startJob` only reuses the key while the job is queued/running, so this never
      // serves a stale completed result.
      const dedupeKey = `${repo.toLowerCase()}#${number}`;
      return startJob("pr-analyze", (update) => runAnalysisPipeline(repo, number, Boolean(options?.force), update), dedupeKey);
    },

    async getAnalysis(repo, number): Promise<Analysis | null> {
      const slug = await canonicalSlug(repo);
      const analysis = loadAnalysis(slug, number);
      // An analysis from an older pipeline version lacks newer per-file data; report "none" so
      // the PR screen kicks off a fresh run (the pipeline itself still reads the old cache to
      // carry agent artifacts over).
      if (!analysis || analysis.version !== ANALYSIS_VERSION) return null;
      // X2: re-apply current validator enabled/dismissed state on every read, so toggling or
      // dismissing a validator shows up immediately without waiting for the next full re-run.
      const withValidatorState = { ...analysis, validators: services.validators.applyState(slug, number, analysis.validators) };
      try {
        const detail = await services.github.getPr(repo, number);
        if (detail.summary.headSha === withValidatorState.headSha) {
          const viewedByPath = new Map(detail.files.map((f) => [f.path, f.viewed]));
          let changed = false;
          const files = withValidatorState.files.map((f) => {
            const viewed = viewedByPath.get(f.path) ?? f.viewed;
            if (viewed !== f.viewed) changed = true;
            return viewed === f.viewed ? f : { ...f, viewed };
          });
          if (changed) {
            const refreshed = { ...withValidatorState, files };
            saveAnalysis(slug, number, refreshed);
            return refreshed;
          }
        }
      } catch {
        // stored analysis is still useful even if the live refresh fails
      }
      return withValidatorState;
    },

    async getInboxEnrichment(repo, number, headSha) {
      const slug = await canonicalSlug(repo);
      const analysis = loadAnalysis(slug, number);
      if (!analysis || analysis.headSha !== headSha) return null;
      const changedSinceMyReview = analysis.sinceAnchorSha === null ? null : analysis.files.filter((f) => f.changedSinceLastReview).length;
      return { severity: analysis.severity, changeType: analysis.changeType, changedSinceMyReview };
    },

    async ensurePrRefs(repo, number) {
      const { refs } = await resolvePrRefs(repo, number);
      return { mirrorPath: refs.mirrorPath, headSha: refs.headSha, baseSha: refs.baseSha, mergeBaseSha: refs.mergeBaseSha };
    },

    async getFileDiff(repo, number, filePath, scope): Promise<FileDiff> {
      const repoObj = await resolveRepo(repo);
      const detail = await services.github.getPr(repo, number);
      const mirror = await ensureMirror(repoObj);
      const headSha = detail.summary.headSha;
      await ensureHeadMirrored(mirror, detail, number);
      const mergeBaseSha = await computeMergeBase(mirror, detail.baseSha, headSha, detail.summary.baseRef);

      let fromRef = mergeBaseSha;
      if (scope === "since_last_review" && detail.myLastReviewSha) {
        const anchor = detail.myLastReviewSha;
        const present = (await objectExists(mirror, anchor)) || (await fetchSha(mirror, anchor, 20_000));
        if (present) fromRef = anchor;
      } else if (scope === "since_viewed") {
        const records = await getLocalViewedRecords(repo, number);
        // X18: a renamed file's "viewed" record may still be keyed by its path before the
        // rename, since that's the path it had when the user marked it viewed.
        const oldPathForFile = loadAnalysis(repoObj.slug, number)?.files.find((f) => f.path === filePath)?.oldPath ?? null;
        const record = records[filePath] ?? (oldPathForFile ? records[oldPathForFile] : undefined);
        if (record) {
          const present = (await objectExists(mirror, record.headSha)) || (await fetchSha(mirror, record.headSha, 20_000));
          if (present) fromRef = record.headSha;
        }
      }

      const raw = await rawDiff(mirror, fromRef, headSha, filePath);
      const parsed = parseUnifiedDiff(raw);
      annotateMovesAndWhitespace(parsed);
      const file = parsed.find((f) => f.path === filePath);
      if (!file) return { path: filePath, oldPath: null, binary: false, truncated: false, hunks: [], totalLines: null };
      // Head-side line count so the client can offer context below the last hunk without a probe.
      let totalLines: number | null = null;
      if (!file.binary && file.status !== "deleted") {
        const head = await showFile(mirror, headSha, filePath);
        totalLines = head === null ? null : countLines(head);
      }
      return toFileDiff(file, totalLines);
    },

    async getStructuralDiff(repo, number, filePath): Promise<StructuralDiff | null> {
      const kind = structuralKindFor(filePath);
      if (!kind) return null;
      const repoObj = await resolveRepo(repo);
      const detail = await services.github.getPr(repo, number);
      const mirror = await ensureMirror(repoObj);
      const headSha = detail.summary.headSha;
      await ensureHeadMirrored(mirror, detail, number);
      const mergeBaseSha = await computeMergeBase(mirror, detail.baseSha, headSha, detail.summary.baseRef);
      const cacheKey = `${repoObj.slug.toLowerCase()}#${number}:${mergeBaseSha}:${headSha}:${filePath}`;
      const cached = structuralCache.get(cacheKey);
      if (cached) return cached;
      // A renamed file's base-side content lives at its old path.
      const analyzed = loadAnalysis(repoObj.slug, number)?.files.find((f) => f.path === filePath) ?? null;
      const oldPath = analyzed?.oldPath ?? filePath;
      const oldText = analyzed?.status === "added" ? null : await showFile(mirror, mergeBaseSha, oldPath);
      const newText = analyzed?.status === "deleted" ? null : await showFile(mirror, headSha, filePath);
      return cacheStructural(cacheKey, computeStructuralDiff(filePath, kind, oldText, newText));
    },

    async getFileLines(repo, number, filePath, side, start, end) {
      if (end < start) throw new Error("Invalid line range.");
      if (end - start + 1 > FILE_LINES_MAX) throw new Error(`At most ${FILE_LINES_MAX} lines per request.`);
      const repoObj = await resolveRepo(repo);
      const detail = await services.github.getPr(repo, number);
      const mirror = await ensureMirror(repoObj);
      const headSha = detail.summary.headSha;
      await ensureHeadMirrored(mirror, detail, number);
      let ref = headSha;
      let path = filePath;
      if (side === "base") {
        ref = await computeMergeBase(mirror, detail.baseSha, headSha, detail.summary.baseRef);
        const analyzed = loadAnalysis(repoObj.slug, number)?.files.find((f) => f.path === filePath) ?? null;
        path = analyzed?.oldPath ?? filePath;
      }
      const content = await showFile(mirror, ref, path);
      if (content === null) return { lines: [], totalLines: 0 };
      const all = content.split("\n");
      // A trailing newline yields one empty final element that isn't a real line.
      if (all.length && all[all.length - 1] === "") all.pop();
      return { lines: all.slice(start - 1, end), totalLines: all.length };
    },

    async getRawDiff(repo, number, filePath) {
      const { refs } = await resolvePrRefs(repo, number);
      return rawDiff(refs.mirrorPath, refs.mergeBaseSha, refs.headSha, filePath);
    },

    async readFileAtRef(repo, ref, filePath) {
      const repoObj = await resolveRepo(repo);
      const mirror = await ensureMirror(repoObj);
      let content = await showFile(mirror, ref, filePath);
      if (content === null) {
        await fetchSha(mirror, ref);
        content = await showFile(mirror, ref, filePath);
      }
      return content;
    },

    async searchAtRef(repo, ref, pattern, maxResults) {
      const repoObj = await resolveRepo(repo);
      const mirror = await ensureMirror(repoObj);
      return grepAtRef(mirror, ref, pattern, maxResults);
    },

    buildPrUnits(repo, number): Promise<ValidationUnit[]> {
      return buildPrUnits(repo, number);
    },

    buildLocalUnits(cwd, baseRef) {
      return buildLocalUnits(cwd, baseRef);
    },

    async moveFile(repo, number, filePath, moduleId) {
      const slug = await canonicalSlug(repo);
      saveOverride(slug, number, filePath, moduleId);
      const analysis = loadAnalysis(slug, number);
      if (analysis) {
        const files = analysis.files.map((f) =>
          f.path === filePath
            ? { ...f, moduleId, moduleSource: "user" as const, moduleConfidence: null, noiseReason: moduleId === "noise" ? "user override" : f.noiseReason }
            : f,
        );
        saveAnalysis(slug, number, { ...analysis, files });
      }
    },

    async patchAnalysis(repo, number, patch) {
      const slug = await canonicalSlug(repo);
      const analysis = loadAnalysis(slug, number);
      if (!analysis) return;
      saveAnalysis(slug, number, { ...analysis, ...patch });
    },

    async recomputeDepth(repo, number) {
      await recomputeDepth(await canonicalSlug(repo), number);
    },
  };
}

export function registerAnalysisHandlers(server: PluginServerContext): void {
  handle(server, prAnalyzeRpc, async ({ repo, number, force }) => {
    const jobId = services.analysis.startAnalysis(repo, number, { force, reason: "user" });
    return { jobId };
  });

  handle(server, jobPollRpc, async ({ jobId, waitMs }) => pollJob(jobId, waitMs ?? 0));

  handle(server, depthRecomputeRpc, async ({ repo, number }) => {
    const jobId = startJob(
      "depth-recompute",
      async (update) => {
        update.stage("depth", 0.1);
        await services.analysis.recomputeDepth(repo, number);
        update.stage("done", 1);
        return null;
      },
      `depth:${repo.toLowerCase()}#${number}`,
    );
    return { jobId };
  });

  handle(server, prAnalysisRpc, async ({ repo, number }) => {
    const analysis = await services.analysis.getAnalysis(repo, number);
    return { analysis };
  });

  handle(server, fileDiffRpc, async ({ repo, number, path, scope }) => {
    return services.analysis.getFileDiff(repo, number, path, scope);
  });

  handle(server, fileLinesRpc, async ({ repo, number, path, side, start, end }) => {
    return services.analysis.getFileLines(repo, number, path, side, start, end);
  });

  handle(server, fileStructuralDiffRpc, async ({ repo, number, path }) => {
    const diff = await services.analysis.getStructuralDiff(repo, number, path);
    return { diff };
  });

  handle(server, fileMoveRpc, async ({ repo, number, path, moduleId }) => {
    await services.analysis.moveFile(repo, number, path, moduleId);
    return { ok: true, message: null };
  });
}
