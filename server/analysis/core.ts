import { services } from "../core/services";
import type { PrDetail, Repo } from "../../shared/types";
import { annotateMovesAndWhitespace, parseUnifiedDiff, type ParsedFile } from "./diff";
import { ensureMirror, fetchPrRefs, mergeBase as computeMergeBase, rawDiff, showFile } from "./git";
import { classifyHeuristic, loadRepoOverride, parseGitAttributes, resolveTaxonomy, type HeuristicResult, type ModuleDef } from "./modules";

export interface PrRefsResolved {
  mirrorPath: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  baseRef: string;
}

export async function resolveRepo(repoSlug: string): Promise<Repo> {
  const repo = await services.github.findRepo(repoSlug);
  if (!repo) throw new Error(`Repo not found or not registered with Paseo: ${repoSlug}`);
  return repo;
}

export async function resolvePrRefs(repoSlug: string, number: number, detail?: PrDetail): Promise<{ repo: Repo; detail: PrDetail; refs: PrRefsResolved }> {
  const repo = await resolveRepo(repoSlug);
  const prDetail = detail ?? (await services.github.getPr(repoSlug, number));
  const mirror = await ensureMirror(repo);
  await fetchPrRefs(mirror, number, prDetail.summary.baseRef);
  const headSha = prDetail.summary.headSha;
  const baseSha = prDetail.baseSha;
  const mergeBaseSha = await computeMergeBase(mirror, baseSha, headSha, prDetail.summary.baseRef);
  return { repo, detail: prDetail, refs: { mirrorPath: mirror, headSha, baseSha, mergeBaseSha, baseRef: prDetail.summary.baseRef } };
}

export interface GatheredPr {
  repo: Repo;
  detail: PrDetail;
  refs: PrRefsResolved;
  parsedFiles: ParsedFile[];
  moduleOf: Map<string, HeuristicResult>;
  taxonomy: ModuleDef[];
}

/** Stages 1-3 of the pipeline (fetch, diff, heuristic modules), shared by the pipeline and buildPrUnits/getFileDiff. */
export async function gatherPr(repoSlug: string, number: number, detail?: PrDetail): Promise<GatheredPr> {
  const { repo, detail: prDetail, refs } = await resolvePrRefs(repoSlug, number, detail);
  const raw = await rawDiff(refs.mirrorPath, refs.mergeBaseSha, refs.headSha);
  const parsedFiles = parseUnifiedDiff(raw);
  annotateMovesAndWhitespace(parsedFiles);

  const override = await loadRepoOverride(refs.mirrorPath, refs.headSha);
  const taxonomy = resolveTaxonomy(override.modules);
  const gitattributesRaw = await showFile(refs.mirrorPath, refs.headSha, ".gitattributes");
  const gaRules = parseGitAttributes(gitattributesRaw ?? "");

  const moduleOf = new Map<string, HeuristicResult>();
  for (const file of parsedFiles) {
    moduleOf.set(file.path, classifyHeuristic(file.path, file, override.rules, gaRules, taxonomy));
  }

  return { repo, detail: prDetail, refs, parsedFiles, moduleOf, taxonomy };
}
