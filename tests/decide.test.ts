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
import { PrReviewSettingsSchema } from "../shared/settings";

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

describe("normalizeAnswer", () => {
  it("normalizes a noul answer and clamps out-of-range values", () => {
    expect(normalizeAnswer({ noul: 0.73 }, "noul")).toEqual({ type: "noul", noul: 0.73 });
    expect(normalizeAnswer({ noul: 4 }, "noul")).toEqual({ type: "noul", noul: 1 });
    expect(normalizeAnswer(undefined, "noul")).toEqual({ type: "noul", noul: 0 });
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

  it("normalizes a score answer", () => {
    const answer = normalizeAnswer({ score: 2.4, probabilities: { "0": 0.1, "1": 0.2, "2": 0.5, "3": 0.1, "4": 0.1 } }, "score");
    expect(answer.type).toBe("score");
    expect((answer as { score: number }).score).toBe(2.4);
  });
});

describe("scoreTo1to5", () => {
  it("shifts a 0-indexed score into the 1..5 range", () => {
    const value = scoreTo1to5({ score: 2, probabilities: { "0": 0.1, "1": 0.2, "2": 0.4, "3": 0.2, "4": 0.1 } });
    expect(value).toBe(3);
  });

  it("leaves a 1-indexed score as-is", () => {
    const value = scoreTo1to5({ score: 4, probabilities: { "1": 0.1, "2": 0.2, "3": 0.2, "4": 0.4, "5": 0.1 } });
    expect(value).toBe(4);
  });

  it("clamps to the 1..5 range", () => {
    expect(scoreTo1to5({ score: -3, probabilities: {} })).toBe(1);
    expect(scoreTo1to5({ score: 99, probabilities: {} })).toBe(5);
  });
});

describe("probsToOrderedArray", () => {
  it("orders numeric-keyed probabilities ascending", () => {
    expect(probsToOrderedArray({ "2": 0.1, "0": 0.5, "1": 0.4 })).toEqual([0.5, 0.4, 0.1]);
  });

  it("falls back to insertion order for non-numeric keys", () => {
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
});
