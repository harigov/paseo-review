import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpServer, type McpHandle } from "../server/agents/mcp";
import { services } from "../server/core/services";
import type { Analysis, PrDetail, Repo } from "../shared/types";

const repo: Repo = {
  slug: "acme/widgets",
  owner: "acme",
  name: "widgets",
  projectId: "proj_1",
  projectName: "widgets",
  rootPath: "/tmp/widgets",
  decisionsEnabled: false,
};

const analysis: Analysis = {
  repo: repo.slug,
  number: 42,
  headSha: "head123",
  baseSha: "base123",
  mergeBaseSha: "merge123",
  analyzedAt: new Date().toISOString(),
  decisionsEnabled: false,
  decisionError: null,
  changeType: null,
  severity: null,
  severityProbabilities: null,
  totals: { files: 1, additions: 1, deletions: 0, effectiveLines: 1, movedLines: 0, noiseFiles: 0 },
  modules: [
    { id: "core", title: "Core", rank: 0, description: "", fileCount: 1, additions: 1, deletions: 0, effectiveLines: 1, maxRisk: null, viewedFiles: 0, summary: null },
  ],
  files: [
    {
      path: "src/index.ts",
      oldPath: null,
      status: "modified",
      binary: false,
      additions: 1,
      deletions: 0,
      effectiveLines: 1,
      movedLines: 0,
      moduleId: "core",
      moduleSource: "git",
      moduleConfidence: null,
      noiseReason: null,
      risk: null,
      complexity: null,
      viewed: "UNVIEWED",
      changedSinceViewedProbability: null,
      changedSinceLastReview: false,
      rebaseOnly: false,
      order: { foundations: 0, risk: 0, chrono: 0 },
    },
  ],
  validators: [],
  sinceAnchorSha: null,
  summary: null,
  richDescriptionHtml: null,
  visualOverviewHtml: null,
  guidanceFiles: [],
};

const prDetail: PrDetail = {
  summary: {
    repo: repo.slug,
    number: 42,
    title: "Add widget",
    url: "https://github.com/acme/widgets/pull/42",
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
    headSha: "head123",
    sections: ["mine"],
    changeType: null,
    severity: null,
    attention: null,
    changedSinceMyReview: null,
  },
  body: "Adds a widget.",
  nodeId: "node_1",
  baseSha: "base123",
  commits: 1,
  viewer: "octocat",
  myLastReviewSha: null,
  files: [],
  threads: [],
  checks: [],
};

beforeAll(() => {
  services.github = {
    listRepos: async () => ({ repos: [repo], errors: [] }),
    findRepo: async () => repo,
    getViewer: async () => "octocat",
    listInbox: async () => ({ viewer: "octocat", prs: [], fetchedAt: new Date().toISOString(), errors: [] }),
    getPr: async () => prDetail,
    setViewed: async () => "VIEWED",
  };
  services.analysis = {
    startAnalysis: () => "job_1",
    getAnalysis: async () => analysis,
    ensurePrRefs: async () => ({ mirrorPath: "/tmp/mirror", headSha: "head123", baseSha: "base123", mergeBaseSha: "merge123" }),
    getFileDiff: async () => ({ path: "src/index.ts", oldPath: null, binary: false, truncated: false, hunks: [] }),
    getRawDiff: async () => "diff --git a/src/index.ts b/src/index.ts\n+added line\n",
    readFileAtRef: async (_repo, _ref, filePath) => (filePath === "REVIEW.md" ? "Review carefully." : null),
    searchAtRef: async () => ["src/index.ts:1:added line"],
    buildPrUnits: async () => [],
    buildLocalUnits: async () => [],
    moveFile: async () => undefined,
    patchAnalysis: async () => undefined,
  };
});

describe("pr-review MCP server", () => {
  let mcp: McpHandle | null = null;

  beforeAll(async () => {
    mcp = await startMcpServer(repo, 42);
  });

  afterAll(async () => {
    await mcp?.close();
  });

  async function call(method: string, params?: Record<string, unknown>, id: number = 1) {
    if (!mcp) throw new Error("MCP server did not start");
    const res = await fetch(mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${mcp.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return res;
  }

  it("starts and exposes a url + token", () => {
    expect(mcp).not.toBeNull();
    expect(mcp?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(mcp?.toolNames).toContain("pr_overview");
  });

  it("rejects requests without a valid bearer token", async () => {
    if (!mcp) throw new Error("MCP server did not start");
    const res = await fetch(mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
  });

  it("answers initialize", async () => {
    const res = await call("initialize");
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("pr-review");
  });

  it("lists the read-only toolset", async () => {
    const res = await call("tools/list");
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "pr_overview",
        "list_files",
        "get_diff",
        "read_file",
        "search",
        "list_threads",
        "list_findings",
        "repo_guidance",
      ]),
    );
  });

  it("calls pr_overview via tools/call", async () => {
    const res = await call("tools/call", { name: "pr_overview", arguments: {} });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.summary.title).toBe("Add widget");
  });

  it("calls repo_guidance via tools/call", async () => {
    const res = await call("tools/call", { name: "repo_guidance", arguments: {} });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.files["REVIEW.md"]).toBe("Review carefully.");
  });
});
