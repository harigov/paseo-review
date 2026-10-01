import { createHash } from "node:crypto";
import type { SystemOneAnswer, SystemOneQuestion } from "../core/services";
import { getSettings } from "../core/settings";

export type DecisionProvider = "openrouter" | "cloudflare" | "jev" | "custom";

/** Model used when the settings leave `decision.model` empty. */
export const DEFAULT_MODELS: Record<DecisionProvider, string> = {
  openrouter: "typesafe/jev-1.13",
  cloudflare: "clef-flash",
  jev: "jev-latest",
  custom: "jev-latest",
};

export const OPENROUTER_SYSTEMONE_URL = "https://openrouter.ai/api/v1/systemone";

export interface ResolvedDecisionConfig {
  provider: DecisionProvider;
  model: string;
  url: string;
  apiKey: string | null;
  concurrency: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Resolves provider, endpoint URL and credentials from settings, falling back to env vars. */
export async function resolveConfig(): Promise<{ config: ResolvedDecisionConfig | null; reason: string | null }> {
  const settings = await getSettings();
  const d = settings.decision;
  const provider = d.provider;
  const model = d.model?.trim() || DEFAULT_MODELS[provider] || "jev-latest";
  const concurrency = Math.max(1, Math.min(32, d.concurrency ?? 8));
  const overrideUrl = d.endpointUrl?.trim() || "";
  let apiKey = d.apiKey?.trim() || "";

  if (provider === "openrouter") {
    if (!apiKey) apiKey = process.env.OPENROUTER_API_KEY || "";
    const url = overrideUrl || OPENROUTER_SYSTEMONE_URL;
    if (!apiKey) {
      return {
        config: null,
        reason: "Set an OpenRouter API key in PR Review settings or OPENROUTER_API_KEY on the daemon host.",
      };
    }
    return { config: { provider, model, url, apiKey, concurrency }, reason: null };
  }

  if (provider === "cloudflare") {
    const accountId = d.cloudflareAccountId?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID || "";
    if (!apiKey) apiKey = process.env.CLOUDFLARE_API_TOKEN || "";
    let url = overrideUrl;
    if (!url) {
      if (!accountId) {
        return {
          config: null,
          reason:
            "Set Cloudflare account ID and API token in PR Review settings or CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN on the daemon host.",
        };
      }
      url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;
    }
    if (!apiKey) {
      return {
        config: null,
        reason: "Set a Cloudflare API token in PR Review settings or CLOUDFLARE_API_TOKEN on the daemon host.",
      };
    }
    return { config: { provider, model, url, apiKey, concurrency }, reason: null };
  }

  if (provider === "jev") {
    if (!apiKey) apiKey = process.env.TYPESAFE_API_KEY || "";
    const url = overrideUrl || "https://api.typesafe.ai/v1/systemone";
    if (!apiKey) {
      return {
        config: null,
        reason: "Set a TypeSafe API key in PR Review settings or TYPESAFE_API_KEY on the daemon host.",
      };
    }
    return { config: { provider, model, url, apiKey, concurrency }, reason: null };
  }

  // custom: any System One compatible endpoint; key is optional (self-hosted).
  if (!apiKey) apiKey = process.env.SYSTEMONE_API_KEY || "";
  if (!overrideUrl) {
    return {
      config: null,
      reason: "Set a custom endpoint URL in PR Review settings (decision.endpointUrl).",
    };
  }
  return { config: { provider, model, url: overrideUrl, apiKey: apiKey || null, concurrency }, reason: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST one request body to the resolved endpoint, with a 25s timeout. */
async function callOnce(config: ResolvedDecisionConfig, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    if (config.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://github.com/harigov/paseo-review";
      headers["X-Title"] = "Paseo PR Review";
    }
    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = {};
      }
    }
    if (!res.ok) {
      const j = json as Record<string, unknown>;
      const message =
        (typeof j?.error === "string" && j.error) ||
        (j?.error && typeof (j.error as { message?: unknown }).message === "string"
          ? (j.error as { message: string }).message
          : null) ||
        (Array.isArray(j?.errors) && typeof (j.errors as Array<{ message?: string }>)[0]?.message === "string"
          ? (j.errors as Array<{ message?: string }>)[0]!.message!
          : null) ||
        text.slice(0, 300) ||
        `HTTP ${res.status}`;
      throw new HttpError(res.status, message);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Retries on 429/529/5xx/network errors: 3 retries, backoff 500ms*2^n + jitter. */
export async function callWithRetry(config: ResolvedDecisionConfig, body: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await callOnce(config, body);
    } catch (error) {
      lastError = error;
      const status = error instanceof HttpError ? error.status : null;
      const retryable = status === 429 || status === 529 || (status !== null && status >= 500) || status === null;
      if (attempt === 3 || !retryable) throw error;
      const delay = 500 * 2 ** attempt + Math.random() * 250;
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Cloudflare wraps `{ result, success, errors }`; custom endpoints may optionally wrap `{ result }`. */
export function unwrapResponse(
  provider: DecisionProvider,
  json: unknown,
): { answers?: Record<string, unknown>; usage?: { input_tokens?: number } } {
  const j = json as Record<string, unknown>;
  if (provider === "cloudflare") {
    if (j?.success === false) {
      const errors = j.errors as Array<{ message?: string }> | undefined;
      throw new Error(errors?.[0]?.message || "Cloudflare AI request failed");
    }
    return (j?.result as never) ?? j;
  }
  if (j && typeof j === "object" && "result" in j && j.result && typeof j.result === "object") {
    return j.result as never;
  }
  return j ?? {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Normalizes one raw provider answer into our typed shape, given the question type we asked. */
export function normalizeAnswer(raw: unknown, questionType: SystemOneQuestion["type"]): SystemOneAnswer {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (questionType === "noul") {
    const value = typeof r.noul === "number" ? r.noul : typeof r.probability === "number" ? r.probability : 0;
    return { type: "noul", noul: clamp(value, 0, 1) };
  }
  if (questionType === "choice") {
    const probabilities =
      r.probabilities && typeof r.probabilities === "object" ? (r.probabilities as Record<string, number>) : {};
    return {
      type: "choice",
      choice: typeof r.choice === "string" ? r.choice : "",
      probabilities,
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
    };
  }
  const probabilities =
    r.probabilities && typeof r.probabilities === "object" ? (r.probabilities as Record<string, number>) : {};
  return {
    type: "score",
    score: typeof r.score === "number" ? r.score : 0,
    probabilities,
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
  };
}

/**
 * Maps a normalized score answer to our 1..5 scale. Score questions are posed with 5 ordered
 * levels; if the provider's probability keys are 0-indexed ("0".."4") the weighted score is
 * 0-indexed too, so we shift it. Falls back to clamping the raw score when keys aren't numeric.
 */
export function scoreTo1to5(answer: { score: number; probabilities: Record<string, number> }): number {
  const keys = Object.keys(answer.probabilities)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const zeroIndexed = keys.length > 0 && Math.min(...keys) === 0;
  const adjusted = zeroIndexed ? answer.score + 1 : answer.score;
  return clamp(adjusted, 1, 5);
}

/** Best-effort ordering of a probability map into an array matching level order. */
export function probsToOrderedArray(probabilities: Record<string, number>): number[] {
  const keys = Object.keys(probabilities);
  const numeric = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  if (numeric) {
    return keys
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => probabilities[String(k)] ?? 0);
  }
  return Object.values(probabilities);
}

/** Cache key for one (model, state, question) triple. */
export function cacheKey(model: string, state: unknown, question: SystemOneQuestion): string {
  return createHash("sha256").update(model).update(JSON.stringify(state)).update(JSON.stringify(question)).digest("hex");
}
