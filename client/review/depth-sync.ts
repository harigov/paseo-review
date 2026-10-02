import { useEffect, useMemo, useRef } from "react";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { Analysis } from "../../shared/types";
import { depthRulesHash } from "../../shared/levels";
import { prReviewSettings } from "../../shared/settings";
import { depthRecomputeRpc } from "../../shared/rpc";
import { useJobRunner } from "../data/hooks";

// Keeps `analysis.modules[].recommendedLevel` in step with Settings → Review depth: when the
// current rules' `depthRulesHash` differs from `analysis.depthRulesHash`, start
// `prr.depth.recompute` (once per head + hash) and refetch the analysis when it finishes.
// Owned by workstream F; see docs/plan-round4.md §2.

export function useDepthSync(input: {
  repo: string;
  number: number;
  analysis: Analysis | null;
  refetchAnalysis(): unknown;
}): void {
  const { repo, number, analysis, refetchAnalysis } = input;
  const settings = useSettings(prReviewSettings);
  const recompute = useRpc(depthRecomputeRpc);
  const runner = useJobRunner();
  // Guards against starting the same recompute twice (e.g. a re-render before the job settles);
  // keyed by head + hash, so a genuinely new head or a further rule change tries again.
  const triedKeyRef = useRef<string | null>(null);

  // `settings.revision` (not `.values`, a fresh object on every read) keeps this stable across
  // renders that don't actually change the rules.
  const currentHash = useMemo(
    () => (settings.status === "ready" ? depthRulesHash(settings.values.reviewDepth.rules) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.status, settings.status === "ready" ? settings.revision : null],
  );

  useEffect(() => {
    if (currentHash === null || !analysis) return; // settings not loaded yet, or no analysis to patch
    // No rules configured and the analysis was never scored either — nothing to clear.
    if (currentHash === "" && analysis.depthRulesHash === null) return;
    if (analysis.depthRulesHash === currentHash) return;

    const key = `${analysis.headSha}:${currentHash}`;
    if (triedKeyRef.current === key || runner.running) return;
    triedKeyRef.current = key;

    runner
      .run(() => recompute({ repo, number }))
      .then((job) => {
        if (job.status === "error") {
          console.error(`[pr-review] depth recompute failed: ${job.error ?? "unknown error"}`);
          return undefined;
        }
        return refetchAnalysis();
      })
      .catch((error) => {
        // Best-effort: the module tab just keeps using the default level until the next trigger.
        console.error("[pr-review] depth recompute failed:", error);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHash, analysis?.headSha, analysis?.depthRulesHash, runner.running]);
}
