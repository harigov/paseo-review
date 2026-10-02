import { createHash } from "node:crypto";
import type { SystemOneAnswer, SystemOneQuestion } from "../core/services";
import { getSettings } from "../core/settings";
import { DEFAULT_DECISION_MODELS, type DecisionProvider } from "../../shared/settings";

export type { DecisionProvider };

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
  const model = d.model?.trim() || DEFAULT_DECISION_MODELS[provider] || "jev-latest";
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
      reason: "Set an endpoint URL in PR Review settings (Decision model → Connection).",
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

/**
 * Resolves a score answer's `probabilities` keys onto our 1..N `criteria` positions, without
 * ever trusting plain object key insertion order (not a guarantee through JSON/HTTP transport).
 * Priority:
 *   1. The provider's own `legend`, if present — documented as a map from the same keys used
 *      in `probabilities` to the literal level text we sent in `criteria`. We match each
 *      legend value against `criteria` by exact text.
 *   2. Purely numeric probability keys, sorted ascending, assumed aligned to `criteria` order;
 *      0- vs 1-indexing is detected from the minimum key. This is a documented *assumption*,
 *      not verified against a live System One endpoint (no API key is available here).
 * Returns null when neither strategy yields a full mapping, so the caller treats the answer as
 * unusable rather than guessing from insertion order.
 */
function mapScoreKeysToLevels(
  probabilities: Record<string, number>,
  legend: unknown,
  criteria: string[],
): Map<string, number> | null {
  const keys = Object.keys(probabilities);
  if (keys.length === 0) return null;

  if (legend && typeof legend === "object" && !Array.isArray(legend) && criteria.length > 0) {
    const map = new Map<string, number>();
    let ok = true;
    for (const key of keys) {
      const text = (legend as Record<string, unknown>)[key];
      const idx = typeof text === "string" ? criteria.indexOf(text) : -1;
      if (idx < 0) {
        ok = false;
        break;
      }
      map.set(key, idx + 1);
    }
    if (ok) return map;
  }

  if (keys.every((k) => /^\d+$/.test(k))) {
    const nums = keys.map(Number).sort((a, b) => a - b);
    const zeroIndexed = nums[0] === 0;
    const map = new Map<string, number>();
    for (const n of nums) map.set(String(n), zeroIndexed ? n + 1 : n);
    return map;
  }

  // No legend and non-numeric keys: refuse to guess from object insertion order.
  return null;
}

/**
 * Normalizes one raw provider answer into our typed shape, given the question type we asked.
 * Returns null when the raw answer is missing the fields required for that question type (or,
 * for "score", when its probability keys can't be reliably mapped onto `criteria` — see
 * `mapScoreKeysToLevels`). Callers must NOT cache or otherwise treat a null result as a real
 * answer: it signals "the provider's response was unusable", not "the answer was no/0/empty".
 */
export function normalizeAnswer(
  raw: unknown,
  questionType: SystemOneQuestion["type"],
  criteria?: SystemOneQuestion["criteria"],
): SystemOneAnswer | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (questionType === "noul") {
    const value = typeof r.noul === "number" ? r.noul : typeof r.probability === "number" ? r.probability : null;
    if (value === null) return null;
    return { type: "noul", noul: clamp(value, 0, 1) };
  }
  if (questionType === "choice") {
    if (typeof r.choice !== "string" || !r.choice) return null;
    if (!r.probabilities || typeof r.probabilities !== "object") return null;
    return {
      type: "choice",
      choice: r.choice,
      probabilities: r.probabilities as Record<string, number>,
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
    };
  }

  // score
  if (typeof r.score !== "number") return null;
  const rawProbs = r.probabilities && typeof r.probabilities === "object" ? (r.probabilities as Record<string, number>) : null;
  if (!rawProbs || Object.keys(rawProbs).length === 0) return null;
  const levels = Array.isArray(criteria) ? (criteria as string[]) : [];
  const levelMap = mapScoreKeysToLevels(rawProbs, r.legend, levels);
  if (!levelMap) return null;

  // Re-key probabilities to canonical "1".."N" strings aligned with `criteria` order, and
  // derive `score` as the weighted average over those canonical indices. This sidesteps ever
  // needing to guess whether the provider's own raw `score` field used the same indexing as
  // its probability keys.
  const probabilities: Record<string, number> = {};
  let weighted = 0;
  for (const [rawKey, idx1] of levelMap) {
    const p = rawProbs[rawKey] ?? 0;
    probabilities[String(idx1)] = p;
    weighted += idx1 * p;
  }
  return { type: "score", score: weighted, probabilities, confidence: typeof r.confidence === "number" ? r.confidence : 0 };
}

/**
 * Clamps an already-normalized score answer to our 1..5 scale. By the time an answer reaches
 * here, `normalizeAnswer` has already resolved provider-specific indexing via `criteria`/
 * `legend`, so this is just a safety clamp (fractional weighted-average scores are expected).
 */
export function scoreTo1to5(answer: { score: number; probabilities: Record<string, number> }): number {
  return clamp(answer.score, 1, 5);
}

/**
 * Best-effort ordering of a probability map into an array matching level order. Safe to trust
 * for our own score answers post-`normalizeAnswer`, since those are always re-keyed to
 * canonical "1".."N" strings. The non-numeric fallback below only exists for robustness against
 * arbitrary/legacy maps and is NOT given any special trust — it is plain insertion order.
 */
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

/**
 * Cache key for one (model, state, question) triple. Hashes a single JSON-serialized tuple
 * (rather than concatenating separately-stringified parts with no delimiter) so there's no
 * boundary ambiguity between the three fields.
 */
export function cacheKey(model: string, state: unknown, question: SystemOneQuestion): string {
  return createHash("sha256").update(JSON.stringify([model, state, question])).digest("hex");
}
