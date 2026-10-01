import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPrecomputeStatus, runOnce } from "../server/agents/precompute";
import { pickReadOnlyMode } from "../server/agents/choices";
import { collectGuidanceFiles } from "../server/agents/guidance";
import { rememberPaseo, type PaseoApi } from "../server/core/paseo";
import { services } from "../server/core/services";
import type { PrSummary } from "../shared/types";

beforeAll(() => {
  process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pr-review-agents-"));
  // `runOnce` only runs once a daemon API has been captured (plan §6.8's "paseo inside handlers
  // only" gotcha); a minimal fake is enough since this suite never calls through it.
  rememberPaseo({} as unknown as PaseoApi);
});

function prSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    repo: "acme/widgets",
    number: 1,
    title: "Add widget",
    url: "https://github.com/acme/widgets/pull/1",
    author: "octocat",
    authorAvatarUrl: null,
    isDraft: false,
    state: "OPEN",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "NONE",
    checks: "none",
    unresolvedThreads: 0,
    labels: [],
    baseRef: "main",
    headRef: "feature",
    headSha: "head1",
    sections: ["mine"],
    changeType: null,
    severity: null,
    attention: null,
    changedSinceMyReview: null,
    ...overrides,
  };
}

describe("precompute status (AG5 / AG10): lastError is not clobbered", () => {
  beforeEach(() => {
    services.github = {
      listRepos: async () => ({ repos: [], errors: [] }),
      findRepo: async () => null,
      getViewer: async () => "octocat",
      listInbox: async () => ({ viewer: "octocat", prs: [prSummary()], fetchedAt: new Date().toISOString(), errors: [] }),
      getPr: async () => {
        throw new Error("not used in this suite");
      },
      setViewed: async () => "VIEWED",
    };
    services.analysis = {
      // Throws synchronously, like a real `startAnalysis` call that fails fast (e.g. a bad mirror
      // path). The old code reset `status.lastError = null` unconditionally right after the
      // per-PR loop, so this failure never reached `precomputeStatusRpc`.
      startAnalysis: () => {
        throw new Error("mirror fetch failed");
      },
      getAnalysis: async () => null,
      ensurePrRefs: async () => ({ mirrorPath: "/tmp/mirror", headSha: "h", baseSha: "b", mergeBaseSha: "m" }),
      getFileDiff: async () => ({ path: "x", oldPath: null, binary: false, truncated: false, hunks: [] }),
      getStructuralDiff: async () => null,
      getRawDiff: async () => "",
      readFileAtRef: async () => null,
      searchAtRef: async () => [],
      buildPrUnits: async () => [],
      buildLocalUnits: async () => [],
      moveFile: async () => undefined,
      getInboxEnrichment: async () => null,
      patchAnalysis: async () => undefined,
    };
  });

  it("keeps a per-candidate failure visible on the status after the run finishes", async () => {
    await runOnce();
    const status = getPrecomputeStatus();
    expect(status.lastError).toBe("mirror fetch failed");
    expect(status.lastRunAt).not.toBeNull();
    expect(status.queued).toBe(0); // reset after the run, independent of lastError
  });

  it("clears lastError on a subsequent clean run", async () => {
    await runOnce();
    expect(getPrecomputeStatus().lastError).toBe("mirror fetch failed");

    services.analysis.startAnalysis = () => "job_ok";
    // No PRs this time, so the loop body (and its failure) never runs.
    services.github.listInbox = async () => ({ viewer: "octocat", prs: [], fetchedAt: new Date().toISOString(), errors: [] });

    await runOnce();
    expect(getPrecomputeStatus().lastError).toBeNull();
  });
});

describe("readOnlyModeFor mode matching (AG14)", () => {
  it("prefers an id/label match over provider guesswork", () => {
    expect(pickReadOnlyMode([{ id: "default", label: "Default" }, { id: "plan", label: "Plan" }])).toBe("plan");
    expect(pickReadOnlyMode([{ id: "ASK", label: "Ask Cursor" }])).toBe("ASK");
    expect(pickReadOnlyMode([{ id: "ro", label: "Read-Only" }])).toBe("ro");
  });

  it("omits modeId (returns null) when nothing looks read-only, rather than guessing", () => {
    expect(pickReadOnlyMode([{ id: "default", label: "Default" }, { id: "yolo", label: "Full access" }])).toBeNull();
    expect(pickReadOnlyMode(null)).toBeNull();
    expect(pickReadOnlyMode([])).toBeNull();
  });
});

describe("collectGuidanceFiles ancestor walk (AG9)", () => {
  beforeEach(() => {
    services.analysis = {
      startAnalysis: () => "job",
      getAnalysis: async () => null,
      ensurePrRefs: async () => ({ mirrorPath: "/tmp/mirror", headSha: "h", baseSha: "b", mergeBaseSha: "m" }),
      getFileDiff: async () => ({ path: "x", oldPath: null, binary: false, truncated: false, hunks: [] }),
      getStructuralDiff: async () => null,
      getRawDiff: async () => "",
      // Only these two files "exist" at this ref: a root AGENTS.md and a nested REVIEW.md.
      readFileAtRef: async (_repo, _ref, filePath) => {
        if (filePath === "AGENTS.md") return "root guidance";
        if (filePath === "packages/api/REVIEW.md") return "api guidance";
        return null;
      },
      searchAtRef: async () => [],
      buildPrUnits: async () => [],
      buildLocalUnits: async () => [],
      moveFile: async () => undefined,
      getInboxEnrichment: async () => null,
      patchAnalysis: async () => undefined,
    };
  });

  it("finds the nearest ancestor's guidance file for a touched directory, not just the root", async () => {
    const files = await collectGuidanceFiles("acme/widgets", "head1", ["packages/api/src/handler.ts"]);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["AGENTS.md", "packages/api/REVIEW.md"]);
  });

  it("falls back to the repo root when no ancestor has the file", async () => {
    const files = await collectGuidanceFiles("acme/widgets", "head1", ["packages/ui/src/button.ts"]);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(["AGENTS.md"]);
  });

  it("dedupes the same resolved file across multiple touched directories", async () => {
    const files = await collectGuidanceFiles("acme/widgets", "head1", [
      "packages/api/src/handler.ts",
      "packages/api/src/other.ts",
    ]);
    const apiHits = files.filter((f) => f.path === "packages/api/REVIEW.md");
    expect(apiHits).toHaveLength(1);
  });
});
