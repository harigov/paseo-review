import type { PluginServerContext } from "@getpaseo/plugin/server";
import { pollJob, startJob } from "../core/jobs";
import { handle } from "../core/handle";
import { services } from "../core/services";
import type { AnalysisService, ValidationUnit } from "../core/services";
import { fileDiffRpc, fileMoveRpc, jobPollRpc, prAnalysisRpc, prAnalyzeRpc } from "../../shared/rpc";
import type { Analysis, FileDiff } from "../../shared/types";
import { annotateMovesAndWhitespace, parseUnifiedDiff, toFileDiff } from "./diff";
import { ensureMirror, fetchPrRefs, fetchSha, grepAtRef, mergeBase as computeMergeBase, rawDiff, showFile } from "./git";
import { resolveRepo, resolvePrRefs } from "./core";
import { runAnalysisPipeline } from "./pipeline";
import { loadAnalysis, saveAnalysis, saveOverride } from "./store";
import { buildLocalUnits, buildPrUnits } from "./units";
import { getLocalViewedRecords } from "../github/viewed-store";

export function createAnalysisService(): AnalysisService {
  return {
    startAnalysis(repo, number, options) {
      const [owner, name] = repo.split("/");
      const cached = owner && name ? loadAnalysis(owner, name, number) : null;
      const dedupeKey = `${repo}#${number}:${cached?.headSha ?? "pending"}${options?.force ? ":force" : ""}`;
      return startJob(
        "pr-analyze",
        (update) => runAnalysisPipeline(repo, number, Boolean(options?.force), update),
        options?.force ? undefined : dedupeKey,
      );
    },

    async getAnalysis(repo, number): Promise<Analysis | null> {
      const [owner, name] = repo.split("/");
      const analysis = loadAnalysis(owner, name, number);
      if (!analysis) return null;
      try {
        const detail = await services.github.getPr(repo, number);
        if (detail.summary.headSha === analysis.headSha) {
          const viewedByPath = new Map(detail.files.map((f) => [f.path, f.viewed]));
          let changed = false;
          const files = analysis.files.map((f) => {
            const viewed = viewedByPath.get(f.path) ?? f.viewed;
            if (viewed !== f.viewed) changed = true;
            return viewed === f.viewed ? f : { ...f, viewed };
          });
          if (changed) {
            const refreshed = { ...analysis, files };
            saveAnalysis(owner, name, number, refreshed);
            return refreshed;
          }
        }
      } catch {
        // stored analysis is still useful even if the live refresh fails
      }
      return analysis;
    },

    async ensurePrRefs(repo, number) {
      const { refs } = await resolvePrRefs(repo, number);
      return { mirrorPath: refs.mirrorPath, headSha: refs.headSha, baseSha: refs.baseSha, mergeBaseSha: refs.mergeBaseSha };
    },

    async getFileDiff(repo, number, filePath, scope): Promise<FileDiff> {
      const repoObj = await resolveRepo(repo);
      const detail = await services.github.getPr(repo, number);
      const mirror = await ensureMirror(repoObj);
      await fetchPrRefs(mirror, number, detail.summary.baseRef);
      const headSha = detail.summary.headSha;
      const mergeBaseSha = await computeMergeBase(mirror, detail.baseSha, headSha, detail.summary.baseRef);

      let fromRef = mergeBaseSha;
      if (scope === "since_last_review" && detail.myLastReviewSha) {
        const ok = await fetchSha(mirror, detail.myLastReviewSha);
        if (ok || (await showFile(mirror, detail.myLastReviewSha, filePath)) !== null) fromRef = detail.myLastReviewSha;
      } else if (scope === "since_viewed") {
        const records = await getLocalViewedRecords(repo, number);
        const record = records[filePath];
        if (record) {
          await fetchSha(mirror, record.headSha);
          fromRef = record.headSha;
        }
      }

      const raw = await rawDiff(mirror, fromRef, headSha, filePath);
      const parsed = parseUnifiedDiff(raw);
      annotateMovesAndWhitespace(parsed);
      const file = parsed.find((f) => f.path === filePath);
      if (!file) return { path: filePath, oldPath: null, binary: false, truncated: false, hunks: [] };
      return toFileDiff(file);
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
      const [owner, name] = repo.split("/");
      saveOverride(owner, name, number, filePath, moduleId);
      const analysis = loadAnalysis(owner, name, number);
      if (analysis) {
        const files = analysis.files.map((f) =>
          f.path === filePath
            ? { ...f, moduleId, moduleSource: "user" as const, moduleConfidence: null, noiseReason: moduleId === "noise" ? "user override" : f.noiseReason }
            : f,
        );
        saveAnalysis(owner, name, number, { ...analysis, files });
      }
    },

    async patchAnalysis(repo, number, patch) {
      const [owner, name] = repo.split("/");
      const analysis = loadAnalysis(owner, name, number);
      if (!analysis) return;
      saveAnalysis(owner, name, number, { ...analysis, ...patch });
    },
  };
}

export function registerAnalysisHandlers(server: PluginServerContext): void {
  handle(server, prAnalyzeRpc, async ({ repo, number, force }) => {
    const jobId = services.analysis.startAnalysis(repo, number, { force, reason: "user" });
    return { jobId };
  });

  handle(server, jobPollRpc, async ({ jobId, waitMs }) => pollJob(jobId, waitMs ?? 0));

  handle(server, prAnalysisRpc, async ({ repo, number }) => {
    const analysis = await services.analysis.getAnalysis(repo, number);
    return { analysis };
  });

  handle(server, fileDiffRpc, async ({ repo, number, path, scope }) => {
    return services.analysis.getFileDiff(repo, number, path, scope);
  });

  handle(server, fileMoveRpc, async ({ repo, number, path, moduleId }) => {
    await services.analysis.moveFile(repo, number, path, moduleId);
    return { ok: true, message: null };
  });
}
