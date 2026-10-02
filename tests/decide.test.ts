import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKey,
  normalizeAnswer,
  probsToOrderedArray,
  resolveConfig,
  scoreTo1to5,
  unwrapResponse,
} from "../server/decide/client";
import { createDecisionService } from "../server/decide";
import { setSettingsHandle } from "../server/core/settings";
import { PrReviewSettingsSchema, type DepthRule } from "../shared/settings";
import type { ModuleDepthInput } from "../server/core/services";

function useProvider(provider: "openrouter" | "cloudflare" | "jev" | "custom", extra: Record<string, unknown> = {}) {
  const values = PrReviewSettingsSchema.parse({ decision: { provider, ...extra } });
  setSettingsHandle({
    read: async () => ({ status: "ready", revision: "1", values }),
    subscribe: () => () => {},
  } as never);
}

beforeAll(() => {
  process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pr-review-decide-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.SYSTEMONE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  useProvider("openrouter");
});

const FIVE_LEVELS = ["L0: trivial", "L1: low", "L2: moderate", "L3: high", "L4: critical"];

describe("normalizeAnswer", () => {
  it("normalizes a noul answer and clamps out-of-range values", () => {
    expect(normalizeAnswer({ noul: 0.73 }, "noul")).toEqual({ type: "noul", noul: 0.73 });
    expect(normalizeAnswer({ noul: 4 }, "noul")).toEqual({ type: "noul", noul: 1 });
  });

  it("returns null (not a guessed default) for a malformed/missing noul answer, so it is never cached as a false confident 0", () => {
    expect(normalizeAnswer(undefined, "noul")).toBeNull();
    expect(normalizeAnswer({}, "noul")).toBeNull();
    expect(normalizeAnswer({ foo: "bar" }, "noul")).toBeNull();
  });

  it("normalizes a choice answer", () => {
    const answer = normalizeAnswer({ choice: "violation", probabilities: { violation: 0.9, compliant: 0.1 }, confidence: 0.9 }, "choice");
    expect(answer).toEqual({
      type: "choice",
      choice: "violation",
      probabilities: { violation: 0.9, compliant: 0.1 },
      confidence: 0.9,
    });
  });

  it("returns null for a malformed/missing choice answer (missing choice or probabilities)", () => {
    expect(normalizeAnswer(undefined, "choice")).toBeNull();
    expect(normalizeAnswer({ choice: "" }, "choice")).toBeNull();
    expect(normalizeAnswer({ choice: "violation" }, "choice")).toBeNull();
  });

  it("returns null for a malformed/missing score answer", () => {
    expect(normalizeAnswer(undefined, "score", FIVE_LEVELS)).toBeNull();
    expect(normalizeAnswer({ probabilities: {} }, "score", FIVE_LEVELS)).toBeNull();
  });

  it("maps a 0-indexed numeric-keyed score answer onto 1..N criteria positions (documented fallback assumption)", () => {
    const answer = normalizeAnswer(
      { score: 2, probabilities: { "0": 0.1, "1": 0.2, "2": 0.4, "3": 0.2, "4": 0.1 } },
      "score",
      FIVE_LEVELS,
    );
    expect(answer?.type).toBe("score");
    if (answer?.type === "score") {
      // Re-keyed to canonical "1".."5"; weighted average = 1*.1+2*.2+3*.4+4*.2+5*.1 = 3.0
      expect(answer.probabilities).toEqual({ "1": 0.1, "2": 0.2, "3": 0.4, "4": 0.2, "5": 0.1 });
      expect(answer.score).toBeCloseTo(3.0);
    }
  });

  it("maps a 1-indexed numeric-keyed score answer onto 1..N criteria positions as-is", () => {
    const answer = normalizeAnswer(
      { score: 4, probabilities: { "1": 0.1, "2": 0.1, "3": 0.1, "4": 0.6, "5": 0.1 } },
      "score",
      FIVE_LEVELS,
    );
    expect(answer?.type).toBe("score");
    if (answer?.type === "score") {
      expect(answer.probabilities).toEqual({ "1": 0.1, "2": 0.1, "3": 0.1, "4": 0.6, "5": 0.1 });
    }
  });

  it("prefers a legend (key -> level text) over numeric-key guessing when both are present", () => {
    // Legend says key "9" is actually our 3rd level ("L2: moderate"), contradicting what a
    // naive numeric sort would assume -- the legend must win.
    const answer = normalizeAnswer(
      {
        score: 9,
        probabilities: { "9": 1 },
        legend: { "9": "L2: moderate" },
      },
      "score",
      FIVE_LEVELS,
    );
    expect(answer?.type).toBe("score");
    if (answer?.type === "score") {
      expect(answer.probabilities).toEqual({ "3": 1 });
      expect(answer.score).toBe(3);
    }
  });

  it("returns null (rather than trusting object insertion order) for non-numeric keys with no usable legend", () => {
    expect(
      normalizeAnswer({ score: 1, probabilities: { feature: 0.6, fix: 0.4 } }, "score", FIVE_LEVELS),
    ).toBeNull();
  });
});

describe("scoreTo1to5", () => {
  it("clamps an already-normalized score to the 1..5 range", () => {
    expect(scoreTo1to5({ score: -3, probabilities: {} })).toBe(1);
    expect(scoreTo1to5({ score: 99, probabilities: {} })).toBe(5);
    expect(scoreTo1to5({ score: 3.4, probabilities: {} })).toBeCloseTo(3.4);
  });
});

describe("probsToOrderedArray", () => {
  it("orders numeric-keyed probabilities ascending (the shape normalizeAnswer always produces for score answers)", () => {
    expect(probsToOrderedArray({ "2": 0.1, "0": 0.5, "1": 0.4 })).toEqual([0.5, 0.4, 0.1]);
  });

  it("falls back to plain insertion order for non-numeric keys (legacy/defensive path only)", () => {
    expect(probsToOrderedArray({ feature: 0.6, fix: 0.4 })).toEqual([0.6, 0.4]);
  });
});

describe("unwrapResponse", () => {
  it("unwraps the Cloudflare envelope", () => {
    const body = { result: { model: "clef-flash", answers: { a: { type: "noul", noul: 0.5 } } }, success: true, errors: [] };
    expect(unwrapResponse("cloudflare", body)).toEqual(body.result);
  });

  it("throws when Cloudflare reports failure", () => {
    expect(() => unwrapResponse("cloudflare", { success: false, errors: [{ message: "boom" }] })).toThrow("boom");
  });

  it("passes through a bare jev response", () => {
    const body = { model: "jev-latest", answers: { a: { type: "noul", noul: 0.2 } } };
    expect(unwrapResponse("jev", body)).toEqual(body);
  });

  it("unwraps an optional {result} envelope for custom endpoints", () => {
    const body = { result: { answers: { a: { type: "noul", noul: 0.2 } } } };
    expect(unwrapResponse("custom", body)).toEqual(body.result);
  });
});

describe("cacheKey", () => {
  it("is stable for identical inputs and differs when state or question changes", () => {
    const question = { type: "noul" as const, instructions: "is this noise?" };
    const k1 = cacheKey("clef-flash", { path: "a.ts" }, question);
    const k2 = cacheKey("clef-flash", { path: "a.ts" }, question);
    const k3 = cacheKey("clef-flash", { path: "b.ts" }, question);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
});

describe("resolveConfig", () => {
  it("defaults to OpenRouter's System One endpoint with Jev", async () => {
    useProvider("openrouter");
    expect((await resolveConfig()).reason).toMatch(/OpenRouter/);
    process.env.OPENROUTER_API_KEY = "or-key";
    const { config, reason } = await resolveConfig();
    expect(reason).toBeNull();
    expect(config?.provider).toBe("openrouter");
    expect(config?.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(config?.model).toBe("typesafe/jev-1.13");
    expect(config?.apiKey).toBe("or-key");
  });

  it("lets the endpoint URL override any provider (self-hosted)", async () => {
    useProvider("openrouter", { endpointUrl: "http://localhost:9000/v1/systemone", apiKey: "k" });
    const { config } = await resolveConfig();
    expect(config?.url).toBe("http://localhost:9000/v1/systemone");
  });

  it("reports not configured for cloudflare with no credentials", async () => {
    useProvider("cloudflare");
    const { config, reason } = await resolveConfig();
    expect(config).toBeNull();
    expect(reason).toMatch(/Cloudflare/);
  });

  it("resolves a cloudflare config from env vars", async () => {
    useProvider("cloudflare");
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
    process.env.CLOUDFLARE_API_TOKEN = "token123";
    const { config, reason } = await resolveConfig();
    expect(reason).toBeNull();
    expect(config?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash");
    expect(config?.apiKey).toBe("token123");
  });
});

describe("createDecisionService", () => {
  beforeEach(() => {
    useProvider("cloudflare");
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
    process.env.CLOUDFLARE_API_TOKEN = "token123";
  });

  it("status() reflects configuration state", async () => {
    const service = createDecisionService();
    const status = await service.status();
    expect(status.configured).toBe(true);
    expect(status.provider).toBe("cloudflare");
  });

  it("sends a request to the resolved endpoint and normalizes a Cloudflare-wrapped response", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("ai/run/@cf/cloudflare/clef-flash");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("clef-flash");
      expect(body.questions.noise.type).toBe("noul");
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: {
            model: "clef-flash",
            answers: { noise: { type: "noul", noul: 0.12 } },
            usage: { input_tokens: 42, output_tokens: 0 },
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = createDecisionService();
    const [res] = await service.evaluate([
      { state: { path: "a.ts" }, questions: { noise: { type: "noul", instructions: "mechanical?" } } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.answers.noise).toEqual({ type: "noul", noul: 0.12 });
      expect(res.inputTokens).toBe(42);
    }
  });

  it("returns a per-request error instead of throwing when the call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), { status: 400 })),
    );
    const service = createDecisionService();
    const [res] = await service.evaluate([
      { state: { path: "failing-case.ts" }, questions: { noise: { type: "noul", instructions: "mechanical?" } } },
    ]);
    expect("error" in res).toBe(true);
  });

  it("omits a malformed/unusable answer instead of caching a guessed default (D5)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: true, errors: [], result: { answers: { noise: {} }, usage: { input_tokens: 1 } } }),
            { status: 200 },
          ),
      ),
    );
    const service = createDecisionService();
    const [res] = await service.evaluate([
      { state: { path: "d5-malformed-test.ts" }, questions: { noise: { type: "noul", instructions: "mechanical?" } } },
    ]);
    expect("error" in res).toBe(false);
    if (!("error" in res)) expect(res.answers.noise).toBeUndefined();
  });

  it("shares one concurrency limiter across separate evaluate() calls, not one per call (D7)", async () => {
    useProvider("cloudflare", { concurrency: 1 });
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
    process.env.CLOUDFLARE_API_TOKEN = "token123";
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return new Response(
        JSON.stringify({ success: true, errors: [], result: { answers: { noise: { type: "noul", noul: 0.1 } }, usage: {} } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = createDecisionService();
    await Promise.all([
      service.evaluate([{ state: { path: "a.ts" }, questions: { noise: { type: "noul", instructions: "x" } } }]),
      service.evaluate([{ state: { path: "b.ts" }, questions: { noise: { type: "noul", instructions: "x" } } }]),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("classifyFiles degrades to nulls when not configured", async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const service = createDecisionService();
    const [result] = await service.classifyFiles([
      { path: "a.ts", language: "ts", diff: "+x", prTitle: "t", modules: { core: "Core logic" } },
    ]);
    expect(result).toEqual({
      path: "a.ts",
      moduleId: null,
      moduleConfidence: null,
      noiseProbability: null,
      risk: null,
      complexity: null,
    });
  });

  describe("reviewDepth", () => {
    const rules: DepthRule[] = [
      { when: "Only tests or fixtures", level: "files", enabled: true },
      { when: "Touches authentication", level: "code", enabled: true },
    ];

    function moduleInput(overrides: Partial<ModuleDepthInput> = {}): ModuleDepthInput {
      return {
        moduleId: "core",
        title: "Core",
        description: "Core business logic",
        prTitle: "Add feature",
        stats: "files=3 additions=10 deletions=2 effective_lines=12 max_risk=2",
        files: ["modified src/core.ts (+10 -2)"],
        declarations: ["modified function run"],
        ...overrides,
      };
    }

    function cloudflareNoulResponse(answers: Record<string, { type: "noul"; noul: number } | Record<string, never>>) {
      return new Response(
        JSON.stringify({ success: true, errors: [], result: { answers, usage: { input_tokens: 1 } } }),
        { status: 200 },
      );
    }

    it("asks one noul question per active rule (named rule_<i>), with module/description/pr_title/stats/files/declarations state", async () => {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.questions.rule_0.type).toBe("noul");
        expect(body.questions.rule_0.instructions).toContain("Only tests or fixtures");
        expect(body.questions.rule_1.instructions).toContain("Touches authentication");
        expect(body.state).toEqual({
          module: "Core",
          description: "Core business logic",
          pr_title: "Add feature",
          stats: "files=3 additions=10 deletions=2 effective_lines=12 max_risk=2",
          files: ["modified src/core.ts (+10 -2)"],
          declarations: ["modified function run"],
        });
        return cloudflareNoulResponse({ rule_0: { type: "noul", noul: 0.1 }, rule_1: { type: "noul", noul: 0.9 } });
      });
      vi.stubGlobal("fetch", fetchMock);

      const service = createDecisionService();
      const [result] = await service.reviewDepth([moduleInput()], rules);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ level: "code", reason: "Touches authentication" });
    });

    it("matches a rule only at P >= DEPTH_RULE_MATCH_THRESHOLD (0.7)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => cloudflareNoulResponse({ rule_0: { type: "noul", noul: 0.69 }, rule_1: { type: "noul", noul: 0.3 } })),
      );
      const service = createDecisionService();
      // Unique `title` (part of `state`) so this doesn't collide with another test's cached
      // answer for the same (model, state, question) — the on-disk decision cache is shared
      // across the whole file via `PASEO_HOME`.
      const [result] = await service.reviewDepth([moduleInput({ title: "Core (threshold test)" })], rules);
      expect(result).toBeNull(); // both below threshold -> no match
    });

    it("picks the deepest matching rule, ties going to the earlier one (pickRuleLevel)", async () => {
      const threeRules: DepthRule[] = [
        { when: "Only tests or fixtures", level: "files", enabled: true },
        { when: "Touches authentication", level: "code", enabled: true },
        { when: "Additive API surface", level: "declarations", enabled: true },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          cloudflareNoulResponse({
            rule_0: { type: "noul", noul: 0.9 },
            rule_1: { type: "noul", noul: 0.9 },
            rule_2: { type: "noul", noul: 0.9 },
          }),
        ),
      );
      const service = createDecisionService();
      const [result] = await service.reviewDepth([moduleInput({ title: "Core (tie-break test)" })], threeRules);
      // "code" (rule_1) outranks "declarations" (rule_2) even though rule_2 comes later.
      expect(result).toEqual({ level: "code", reason: "Touches authentication" });
    });

    it("treats a missing/malformed answer for a rule as no match, not as an error", async () => {
      // rule_1's answer is malformed; `evaluateOne` drops it from `answers` rather than failing
      // the whole response, so reviewDepth must fall back to "no match" for that rule only.
      vi.stubGlobal("fetch", vi.fn(async () => cloudflareNoulResponse({ rule_0: { type: "noul", noul: 0.95 }, rule_1: {} })));
      const service = createDecisionService();
      const [result] = await service.reviewDepth([moduleInput({ title: "Core (malformed-answer test)" })], rules);
      expect(result).toEqual({ level: "files", reason: "Only tests or fixtures" });
    });

    it("returns null for a module when the whole request errors", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), { status: 400 })),
      );
      const service = createDecisionService();
      const [result] = await service.reviewDepth([moduleInput({ title: "Core (request-error test)" })], rules);
      expect(result).toBeNull();
    });

    it("returns null for every module without calling the API when there are no active rules", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const service = createDecisionService();
      const noRules: DepthRule[] = [
        { when: "   ", level: "code", enabled: true },
        { when: "Disabled", level: "code", enabled: false },
      ];
      const results = await service.reviewDepth([moduleInput(), moduleInput({ moduleId: "ui" })], noRules);
      expect(results).toEqual([null, null]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns null for every module without calling the API when the decision model isn't configured", async () => {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      delete process.env.CLOUDFLARE_API_TOKEN;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const service = createDecisionService();
      const results = await service.reviewDepth([moduleInput()], rules);
      expect(results).toEqual([null]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
