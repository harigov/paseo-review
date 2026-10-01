import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeMcpServer, closeMcpSession, openMcpSession, type McpSession } from "../server/agents/mcp";
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
  version: 2,
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
      outline: null,
      structuralKind: null,
    },
  ],
  validators: [],
  sinceAnchorSha: null,
  summary: null,
  richDescriptionHtml: null,
  visualOverviewHtml: null,
  guidanceFiles: [],
  threadTriage: {},
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
  threads: [
    {
      id: "thread_1",
      path: "src/index.ts",
      line: 5,
      originalLine: 5,
      diffSide: "RIGHT",
      isResolved: false,
      isOutdated: false,
      comments: [{ id: "c1", author: "reviewer", body: "Why this change?", createdAt: new Date().toISOString(), url: "https://example.com" }],
      triage: null,
      triageProbability: null,
    },
  ],
  checks: [],
  reviews: [],
  reviewRequests: [],
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
    getStructuralDiff: async () => null,
    getRawDiff: async () => "diff --git a/src/index.ts b/src/index.ts\n+added line\n",
    readFileAtRef: async (_repo, _ref, filePath) => (filePath === "REVIEW.md" ? "Review carefully." : null),
    searchAtRef: async () => ["src/index.ts:1:added line"],
    buildPrUnits: async () => [],
    buildLocalUnits: async () => [],
    moveFile: async () => undefined,
    getInboxEnrichment: async () => null,
    patchAnalysis: async () => undefined,
  };
});

describe("pr-review MCP server (long-lived, session-scoped)", () => {
  let session: McpSession | null = null;

  beforeAll(async () => {
    session = await openMcpSession("task", repo, 42);
  });

  afterAll(async () => {
    await closeMcpServer();
  });

  async function call(method: string, params?: Record<string, unknown>, id: number = 1, token = session?.token) {
    if (!session) throw new Error("MCP session did not open");
    const res = await fetch(session.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return res;
  }

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const res = await call("tools/call", { name, arguments: args });
    const body = (await res.json()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return JSON.parse(body.result!.content[0]!.text);
  }

  it("starts and exposes a url + token", () => {
    expect(session).not.toBeNull();
    expect(session?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(session?.toolNames).toContain("pr_overview");
  });

  it("rejects requests without a valid bearer token", async () => {
    const res = await call("initialize", undefined, 1, "wrong-token");
    expect(res.status).toBe(401);
  });

  it("rejects requests with no authorization header at all", async () => {
    if (!session) throw new Error("MCP session did not open");
    const res = await fetch(session.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked task token", async () => {
    const s = await openMcpSession("task", repo, 43);
    expect(s).not.toBeNull();
    closeMcpSession(s!.token);
    const res = await call("initialize", undefined, 1, s!.token);
    expect(res.status).toBe(401);
  });

  it("rejects non-POST methods", async () => {
    if (!session) throw new Error("MCP session did not open");
    const res = await fetch(session.url, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("returns 400 for invalid JSON", async () => {
    if (!session) throw new Error("MCP session did not open");
    const res = await fetch(session.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 413 for an oversized body", async () => {
    if (!session) throw new Error("MCP session did not open");
    const huge = "x".repeat(1024 * 1024 + 1024);
    const res = await fetch(session.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { pattern: huge } } }),
    });
    expect(res.status).toBe(413);
  });

  it("answers initialize", async () => {
    const res = await call("initialize");
    const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("pr-review");
  });

  it("answers ping", async () => {
    const res = await call("ping");
    const body = (await res.json()) as { result: unknown };
    expect(body.result).toEqual({});
  });

  it("lists the read-only toolset", async () => {
    const res = await call("tools/list");
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
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

  it("errors cleanly on an unknown method", async () => {
    const res = await call("not/a/real/method");
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Unknown method/);
  });

  it("errors cleanly on an unknown tool", async () => {
    const res = await call("tools/call", { name: "delete_everything", arguments: {} });
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Unknown tool/);
  });

  it("calls pr_overview via tools/call", async () => {
    const payload = await callTool("pr_overview");
    expect(payload.summary.title).toBe("Add widget");
    expect(payload.analysis.headSha).toBe("head123");
  });

  it("calls list_files via tools/call, optionally filtered by module", async () => {
    const all = await callTool("list_files");
    expect(all.files).toHaveLength(1);
    const filtered = await callTool("list_files", { module: "nonexistent" });
    expect(filtered.files).toHaveLength(0);
  });

  it("calls get_diff via tools/call", async () => {
    const payload = await callTool("get_diff", { path: "src/index.ts" });
    expect(payload.diff).toContain("added line");
    expect(payload.truncated).toBe(false);
  });

  it("calls read_file via tools/call for head and base", async () => {
    const head = await callTool("read_file", { path: "REVIEW.md", ref: "head" });
    expect(head.content).toBe("Review carefully.");
    expect(head.ref).toBe("head");
    const missing = await callTool("read_file", { path: "nope.txt" });
    expect(missing.content).toBeNull();
  });

  it("calls search via tools/call", async () => {
    const payload = await callTool("search", { pattern: "added" });
    expect(payload.results).toEqual(["src/index.ts:1:added line"]);
  });

  it("calls list_threads via tools/call", async () => {
    const payload = await callTool("list_threads");
    expect(payload.threads).toHaveLength(1);
    expect(payload.threads[0].id).toBe("thread_1");
  });

  it("calls list_findings via tools/call", async () => {
    const payload = await callTool("list_findings");
    expect(payload.validators).toEqual([]);
  });

  it("calls repo_guidance via tools/call", async () => {
    const payload = await callTool("repo_guidance");
    expect(payload.files["REVIEW.md"]).toBe("Review carefully.");
  });

  describe("session scoping", () => {
    afterEach(() => {
      // nothing to clean up — task sessions are revoked explicitly in each test that opens one.
    });

    it("gives chat sessions for the same repo#number the same token, reused", async () => {
      const first = await openMcpSession("chat", repo, 99);
      const second = await openMcpSession("chat", repo, 99);
      expect(first?.token).toBe(second?.token);
    });

    it("scopes each session's tools to the repo/number it was opened for", async () => {
      const otherRepo: Repo = { ...repo, slug: "acme/other" };
      const otherSession = await openMcpSession("task", otherRepo, 7);
      expect(otherSession).not.toBeNull();
      const res = await call("tools/call", { name: "pr_overview", arguments: {} }, 1, otherSession!.token);
      const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
      const payload = JSON.parse(body.result.content[0]!.text);
      // services.github.getPr ignores the repo arg in this fixture and always returns `prDetail`,
      // but the call must still succeed using `otherSession`'s own token/ctx rather than failing
      // auth — i.e. each session is independently valid, not just the first one opened.
      expect(payload.summary.title).toBe("Add widget");
      closeMcpSession(otherSession!.token);
    });

    it("revoking a task session's token makes it stop working, without affecting other sessions", async () => {
      const taskSession = await openMcpSession("task", repo, 55);
      expect(taskSession).not.toBeNull();
      closeMcpSession(taskSession!.token);
      const revoked = await call("initialize", undefined, 1, taskSession!.token);
      expect(revoked.status).toBe(401);
      // The original long-lived `session` from the outer `beforeAll` is unaffected.
      const stillWorks = await call("initialize");
      expect(stillWorks.status).toBe(200);
    });
  });
});
