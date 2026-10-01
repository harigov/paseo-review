import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../server/core/exec";
import type { PrDetail } from "../shared/types";

let mirror: string;
let paseoHome: string;
let headSha: string;
let baseSha: string;

beforeAll(async () => {
  paseoHome = mkdtempSync(path.join(tmpdir(), "pr-review-paseo-home-"));
  process.env.PASEO_HOME = paseoHome;

  mirror = mkdtempSync(path.join(tmpdir(), "pr-review-mirror-"));
  await run("git", ["init", "-q", "--bare", mirror]);

  const work = mkdtempSync(path.join(tmpdir(), "pr-review-work-"));
  await run("git", ["init", "-q", work]);
  await run("git", ["-C", work, "config", "user.email", "a@a.com"]);
  await run("git", ["-C", work, "config", "user.name", "a"]);
  await run("git", ["-C", work, "commit", "--allow-empty", "-q", "-m", "base"]);
  baseSha = (await run("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await run("git", ["-C", work, "commit", "--allow-empty", "-q", "-m", "head"]);
  headSha = (await run("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await run("git", ["-C", work, "push", "-q", mirror, "HEAD:refs/heads/main"]);
  // Deliberately NOT configuring an `origin` remote on `mirror`, and NOT pushing/fetching the
  // bogus anchor sha below anywhere — `fetchSha`/`objectExists` must fail for it.
});

afterAll(() => {
  rmSync(mirror, { recursive: true, force: true });
  rmSync(paseoHome, { recursive: true, force: true });
});

function detailWith(anchor: string | null): PrDetail {
  return {
    summary: {
      repo: "acme/widgets",
      number: 1,
      title: "t",
      url: "https://github.com/acme/widgets/pull/1",
      author: "a",
      authorAvatarUrl: null,
      isDraft: false,
      state: "OPEN",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      reviewDecision: "NONE",
      checks: "none",
      unresolvedThreads: 0,
      labels: [],
      baseRef: "main",
      headRef: "feature",
      headSha,
      sections: [],
      changeType: null,
      severity: null,
      attention: null,
      changedSinceMyReview: null,
    },
    body: "",
    nodeId: "node1",
    baseSha,
    commits: 1,
    viewer: "me",
    myLastReviewSha: anchor,
    files: [{ path: "src/a.ts", additions: 1, deletions: 0, changeType: "modified", viewed: "UNVIEWED" }],
    threads: [],
    checks: [],
    reviews: [],
    reviewRequests: [],
  };
}

describe("computeViewedFields (A9: fail open on an unresolvable anchor)", () => {
  it("marks every file changed and reports sinceAnchorSha=null when the anchor can't be fetched/resolved", async () => {
    const { computeViewedFields } = await import("../server/analysis/viewed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bogusAnchor = "f".repeat(40);
    const result = await computeViewedFields(mirror, detailWith(bogusAnchor), "acme", "widgets", headSha, baseSha, "main", baseSha, false);
    expect(result.sinceAnchorSha).toBeNull();
    expect(result.perFile.get("src/a.ts")?.changedSinceLastReview).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports sinceAnchorSha=null and changedSinceLastReview=false when the viewer never reviewed", async () => {
    const { computeViewedFields } = await import("../server/analysis/viewed");
    const result = await computeViewedFields(mirror, detailWith(null), "acme", "widgets", headSha, baseSha, "main", baseSha, false);
    expect(result.sinceAnchorSha).toBeNull();
    expect(result.perFile.get("src/a.ts")?.changedSinceLastReview).toBe(false);
  });
});
