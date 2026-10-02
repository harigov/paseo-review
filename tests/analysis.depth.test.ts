import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { computeModuleDepth, recomputeDepth } from "../server/analysis/depth";
import { loadAnalysis, saveAnalysis } from "../server/analysis/store";
import { services, type DecisionService, type ModuleDepthInput } from "../server/core/services";
import { setSettingsHandle } from "../server/core/settings";
import { DepthRuleSchema, PrReviewSettingsSchema, type DepthRule } from "../shared/settings";
import type { Analysis, AnalyzedFile, Module, OutlineEntry, PrDetail, Repo } from "../shared/types";

beforeAll(() => {
  process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pr-review-depth-"));
});

function useRules(rules: DepthRule[]) {
  const values = PrReviewSettingsSchema.parse({ reviewDepth: { rules: rules.map((r) => DepthRuleSchema.parse(r)) } });
  setSettingsHandle({
    read: async () => ({ status: "ready", revision: "1", values }),
    subscribe: () => () => {},
  } as never);
}

/** A `DecisionService` whose entry points all throw — used to assert they're never called. */
function unreachableDecide(overrides: Partial<DecisionService> = {}): DecisionService {
  const fail = (name: string) => async () => {
    throw new Error(`${name}() must not be called`);
  };
  return {
    status: fail("status") as DecisionService["status"],
    evaluate: fail("evaluate") as DecisionService["evaluate"],
    classifyFiles: fail("classifyFiles") as DecisionService["classifyFiles"],
    prSeverity: fail("prSeverity") as DecisionService["prSeverity"],
    triageThreads: fail("triageThreads") as DecisionService["triageThreads"],
    substantiveChange: fail("substantiveChange") as DecisionService["substantiveChange"],
    attention: fail("attention") as DecisionService["attention"],
    reviewDepth: fail("reviewDepth") as DecisionService["reviewDepth"],
    ...overrides,
  };
}

function outlineEntry(overrides: Partial<OutlineEntry> = {}): OutlineEntry {
  return {
    name: "run",
    kind: "function",
    change: "modified",
    exported: true,
    signature: "function run()",
    oldSignature: null,
    newStart: 1,
    newEnd: 5,
    oldStart: 1,
    oldEnd: 4,
    changedLines: 3,
    counterpart: null,
    ...overrides,
  };
}

function makeFile(overrides: Partial<AnalyzedFile> = {}): AnalyzedFile {
  return {
    path: "src/core.ts",
    oldPath: null,
    status: "modified",
    binary: false,
    additions: 10,
    deletions: 2,
    effectiveLines: 12,
    movedLines: 0,
    moduleId: "core",
    moduleSource: "git",
    moduleConfidence: null,
    noiseReason: null,
    risk: 2,
    complexity: 2,
    viewed: "UNVIEWED",
    changedSinceViewedProbability: null,
    changedSinceLastReview: false,
    rebaseOnly: false,
    order: { foundations: 0, risk: 0, chrono: 0 },
    outline: [outlineEntry()],
    structuralKind: null,
    ...overrides,
  };
}

function makeModule(overrides: Partial<Module> = {}): Module {
  return {
    id: "core",
    title: "Core",
    rank: 0,
    description: "Core business logic",
    fileCount: 1,
    additions: 10,
    deletions: 2,
    effectiveLines: 12,
    maxRisk: 2,
    viewedFiles: 0,
    summary: null,
    recommendedLevel: null,
    levelReason: null,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    repo: "acme/widgets",
    number: 1,
    version: 2,
    headSha: "head1",
    baseSha: "base1",
    mergeBaseSha: "merge1",
    analyzedAt: new Date().toISOString(),
    decisionsEnabled: false,
    decisionError: null,
    changeType: null,
    severity: null,
    severityProbabilities: null,
    totals: { files: 1, additions: 10, deletions: 2, effectiveLines: 12, movedLines: 0, noiseFiles: 0 },
    modules: [makeModule()],
    files: [makeFile()],
    validators: [],
    sinceAnchorSha: null,
    summary: null,
    richDescriptionHtml: null,
    visualOverviewHtml: null,
    guidanceFiles: [],
    threadTriage: {},
    depthRulesHash: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    slug: "acme/widgets",
    owner: "acme",
    name: "widgets",
    projectId: "proj_1",
    projectName: "widgets",
    rootPath: "/tmp/widgets",
    decisionsEnabled: false,
    ...overrides,
  };
}

function makePrDetail(title: string): PrDetail {
  return {
    summary: {
      repo: "acme/widgets",
      number: 1,
      title,
      url: "https://github.com/acme/widgets/pull/1",
      author: "octocat",
      authorAvatarUrl: null,
      isDraft: false,
      state: "OPEN",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      additions: 10,
      deletions: 2,
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
    },
    body: "",
    bodyHtml: "",
    nodeId: "node_1",
    baseSha: "base1",
    commits: 1,
    viewer: "octocat",
    myLastReviewSha: null,
    files: [],
    threads: [],
    checks: [],
    reviews: [],
    reviewRequests: [],
  };
}

const AUTH_RULE: DepthRule = { when: "Touches authentication", level: "code", enabled: true };

describe("computeModuleDepth", () => {
  it("returns nulled modules and hash \"\" when there are no active rules, without touching the decision model", async () => {
    useRules([{ when: "   ", level: "code", enabled: true }, { when: "disabled", level: "code", enabled: false }]);
    services.decide = unreachableDecide();

    const result = await computeModuleDepth({
      repo: "acme/widgets",
      modules: [makeModule({ recommendedLevel: "code", levelReason: "stale" })],
      files: [makeFile()],
      decisionsEnabled: true,
      prTitle: "Add x",
    });

    expect(result.depthRulesHash).toBe("");
    expect(result.modules[0].recommendedLevel).toBeNull();
    expect(result.modules[0].levelReason).toBeNull();
  });

  it("returns nulled modules (but a real hash) when the repo isn't opted in to the decision model", async () => {
    useRules([AUTH_RULE]);
    services.decide = unreachableDecide();

    const result = await computeModuleDepth({
      repo: "acme/widgets",
      modules: [makeModule()],
      files: [makeFile()],
      decisionsEnabled: false,
      prTitle: "Add x",
    });

    expect(result.depthRulesHash).not.toBe("");
    expect(result.modules[0].recommendedLevel).toBeNull();
  });

  it("returns nulled modules when the decision model isn't configured", async () => {
    useRules([AUTH_RULE]);
    services.decide = unreachableDecide({
      status: async () => ({ configured: false, reason: "No API key.", provider: "openrouter", model: "" }),
    });

    const result = await computeModuleDepth({
      repo: "acme/widgets",
      modules: [makeModule()],
      files: [makeFile()],
      decisionsEnabled: true,
      prTitle: "Add x",
    });

    expect(result.modules[0].recommendedLevel).toBeNull();
  });

  it("skips the noise module and modules with no files, but asks about every other module", async () => {
    let seenModuleIds: string[] = [];
    useRules([AUTH_RULE]);
    services.decide = unreachableDecide({
      status: async () => ({ configured: true, reason: null, provider: "openrouter", model: "jev" }),
      reviewDepth: async (inputs) => {
        seenModuleIds = inputs.map((i) => i.moduleId);
        return inputs.map(() => null);
      },
    });

    const modules = [
      makeModule({ id: "noise", title: "Noise", fileCount: 3 }),
      makeModule({ id: "empty", title: "Empty", fileCount: 0 }),
      makeModule({ id: "core", title: "Core", fileCount: 1 }),
    ];
    const files = [makeFile({ moduleId: "noise" }), makeFile({ moduleId: "core" })];

    await computeModuleDepth({ repo: "acme/widgets", modules, files, decisionsEnabled: true, prTitle: "Add x" });

    expect(seenModuleIds).toEqual(["core"]);
  });

  it("caps files at 60 and declarations at 80 per module", async () => {
    let seenInput: ModuleDepthInput | null = null;
    useRules([AUTH_RULE]);
    services.decide = unreachableDecide({
      status: async () => ({ configured: true, reason: null, provider: "openrouter", model: "jev" }),
      reviewDepth: async (inputs) => {
        seenInput = inputs[0];
        return inputs.map(() => null);
      },
    });

    const manyFiles: AnalyzedFile[] = Array.from({ length: 90 }, (_, i) =>
      makeFile({ path: `src/f${i}.ts`, moduleId: "core", outline: [outlineEntry({ name: `fn${i}` })] }),
    );
    const modules = [makeModule({ id: "core", fileCount: manyFiles.length })];

    await computeModuleDepth({ repo: "acme/widgets", modules, files: manyFiles, decisionsEnabled: true, prTitle: "Add x" });

    expect(seenInput).not.toBeNull();
    expect(seenInput!.files.length).toBe(60);
    expect(seenInput!.declarations.length).toBe(80);
  });

  it("never throws — falls back to nulled modules when the decision model errors", async () => {
    useRules([AUTH_RULE]);
    services.decide = unreachableDecide({
      status: async () => {
        throw new Error("network boom");
      },
    });

    const result = await computeModuleDepth({
      repo: "acme/widgets",
      modules: [makeModule()],
      files: [makeFile()],
      decisionsEnabled: true,
      prTitle: "Add x",
    });

    expect(result.modules[0].recommendedLevel).toBeNull();
    expect(result.depthRulesHash).not.toBe("");
  });

  it("maps each module's recommendation back by id, leaving modules the model didn't recommend for at null", async () => {
    useRules([AUTH_RULE]);
    services.decide = unreachableDecide({
      status: async () => ({ configured: true, reason: null, provider: "openrouter", model: "jev" }),
      reviewDepth: async (inputs) =>
        inputs.map((input) => (input.moduleId === "core" ? { level: "declarations" as const, reason: "Additive API surface" } : null)),
    });

    const modules = [makeModule({ id: "core", fileCount: 1 }), makeModule({ id: "ui", title: "UI", fileCount: 1 })];
    const files = [makeFile({ moduleId: "core" }), makeFile({ path: "src/ui.ts", moduleId: "ui" })];

    const result = await computeModuleDepth({ repo: "acme/widgets", modules, files, decisionsEnabled: true, prTitle: "Add x" });

    const core = result.modules.find((m) => m.id === "core")!;
    const ui = result.modules.find((m) => m.id === "ui")!;
    expect(core.recommendedLevel).toBe("declarations");
    expect(core.levelReason).toBe("Additive API surface");
    expect(ui.recommendedLevel).toBeNull();
  });
});

describe("recomputeDepth", () => {
  it("is a no-op when there is no cached analysis for the PR", async () => {
    services.github = {
      listRepos: async () => ({ repos: [], errors: [] }),
      findRepo: async () => {
        throw new Error("findRepo() must not be called when there's no analysis to patch");
      },
      getViewer: async () => "octocat",
      listInbox: async () => ({ viewer: "octocat", prs: [], fetchedAt: new Date().toISOString(), errors: [], refreshing: false }),
      getPr: async () => {
        throw new Error("getPr() must not be called when there's no analysis to patch");
      },
      setViewed: async () => "VIEWED",
    };

    await expect(recomputeDepth("acme/widgets", 9999)).resolves.toBeUndefined();
    expect(loadAnalysis("acme/widgets", 9999)).toBeNull();
  });

  it("patches the cached analysis using the repo's *current* opt-in and the PR's current title, not the stale cached ones", async () => {
    useRules([AUTH_RULE]);
    const repo = makeRepo({ decisionsEnabled: true }); // opted in now, though the cached analysis below says otherwise
    let seenPrTitle: string | null = null;
    services.github = {
      listRepos: async () => ({ repos: [repo], errors: [] }),
      findRepo: async () => repo,
      getViewer: async () => "octocat",
      listInbox: async () => ({ viewer: "octocat", prs: [], fetchedAt: new Date().toISOString(), errors: [], refreshing: false }),
      getPr: async () => makePrDetail("Fresh title from GitHub"),
      setViewed: async () => "VIEWED",
    };
    services.decide = unreachableDecide({
      status: async () => ({ configured: true, reason: null, provider: "openrouter", model: "jev" }),
      reviewDepth: async (inputs) => {
        seenPrTitle = inputs[0]?.prTitle ?? null;
        return inputs.map(() => ({ level: "code" as const, reason: "Touches authentication" }));
      },
    });

    const cached = makeAnalysis({
      number: 7,
      decisionsEnabled: false, // stale: the pipeline ran before this repo opted in
      modules: [makeModule({ id: "core", fileCount: 1, recommendedLevel: null, levelReason: null })],
      files: [makeFile({ moduleId: "core" })],
      depthRulesHash: null,
    });
    saveAnalysis("acme/widgets", 7, cached);

    await recomputeDepth("acme/widgets", 7);

    const patched = loadAnalysis("acme/widgets", 7);
    expect(patched).not.toBeNull();
    expect(patched!.modules[0].recommendedLevel).toBe("code");
    expect(patched!.modules[0].levelReason).toBe("Touches authentication");
    expect(patched!.depthRulesHash).not.toBe("");
    expect(seenPrTitle).toBe("Fresh title from GitHub");
    // Everything else about the cached analysis is left alone.
    expect(patched!.headSha).toBe(cached.headSha);
  });
});
