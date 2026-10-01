import { services } from "../core/services";
import { getLocalViewedRecords } from "../github/viewed-store";
import type { PrDetail, ViewedState } from "../../shared/types";
import { gitAt, mergeBase as computeMergeBase, nameOnlyDiff, patchId, rawDiff } from "./git";

export { getLocalViewedRecords };

export interface ViewedFileFields {
  viewed: ViewedState;
  changedSinceLastReview: boolean;
  rebaseOnly: boolean;
  changedSinceViewedProbability: number | null;
}

export interface ViewedComputation {
  sinceAnchorSha: string | null;
  perFile: Map<string, ViewedFileFields>;
}

/**
 * Computes per-file viewed/since-last-review fields. Best-effort: any failure degrades to
 * false/null rather than throwing, so one bad ref doesn't break the whole analysis stage.
 */
export async function computeViewedFields(
  mirror: string,
  detail: PrDetail,
  owner: string,
  name: string,
  headSha: string,
  baseSha: string,
  baseRef: string,
  mergeBaseSha: string,
  decisionsEnabled: boolean,
): Promise<ViewedComputation> {
  const viewedByPath = new Map<string, ViewedState>();
  for (const f of detail.files) viewedByPath.set(f.path, f.viewed);

  const anchor = detail.myLastReviewSha;
  let changedPaths = new Set<string>();
  let anchorMergeBase: string | null = null;
  if (anchor) {
    try {
      await gitAt(mirror, ["fetch", "origin", anchor], { allowFailure: true, timeoutMs: 30_000 });
      changedPaths = new Set(await nameOnlyDiff(mirror, anchor, headSha));
      anchorMergeBase = await computeMergeBase(mirror, baseSha, anchor, baseRef);
    } catch {
      changedPaths = new Set();
    }
  }

  const localRecords = await getLocalViewedRecords(`${owner}/${name}`, detail.summary.number);
  let decideConfigured = false;
  if (decisionsEnabled) {
    try {
      decideConfigured = (await services.decide.status()).configured;
    } catch {
      decideConfigured = false;
    }
  }

  const perFile = new Map<string, ViewedFileFields>();
  for (const file of detail.files) {
    const viewed = viewedByPath.get(file.path) ?? "UNVIEWED";
    let changedSinceLastReview = anchor ? changedPaths.has(file.path) : false;
    let rebaseOnly = false;

    if (anchor && anchorMergeBase && changedSinceLastReview) {
      try {
        const oldId = await patchId(mirror, [`${anchorMergeBase}..${anchor}`, "--", file.path]);
        const newId = await patchId(mirror, [`${mergeBaseSha}..${headSha}`, "--", file.path]);
        if (oldId !== null && newId !== null && oldId === newId) {
          rebaseOnly = true;
          changedSinceLastReview = false;
        }
      } catch {
        // leave as computed from name-only diff
      }
    }

    let changedSinceViewedProbability: number | null = null;
    if (viewed === "DISMISSED") {
      const record = localRecords[file.path];
      if (record && decideConfigured) {
        try {
          const delta = await rawDiff(mirror, record.headSha, headSha, file.path);
          if (delta.trim()) {
            const [p] = await services.decide.substantiveChange([{ path: file.path, delta: delta.slice(0, 8000) }]);
            changedSinceViewedProbability = p ?? null;
          } else {
            changedSinceViewedProbability = 0;
          }
        } catch {
          changedSinceViewedProbability = null;
        }
      }
    }

    perFile.set(file.path, { viewed, changedSinceLastReview, rebaseOnly, changedSinceViewedProbability });
  }

  return { sinceAnchorSha: anchor, perFile };
}
