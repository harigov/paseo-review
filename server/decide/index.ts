// DecisionService entry points below (`evaluate`, `classifyFiles`, `prSeverity`, `triageThreads`,
// `substantiveChange`, `attention`) are repo-agnostic: they send whatever `state`/questions they
// are given straight to the decision API with no idea which repo it came from. Per the plan,
// sending code off-machine is a per-repo opt-in (`settings.decisionRepos`); it is the CALLER's
// responsibility to check `decisionsEnabled`/`decisionRepos` for the relevant repo before
// invoking any of these. See server/validators/index.ts's `validatorsTestRpc` and
// `localValidateRpc` handlers for the gate this module itself can't enforce.
import type { PrSummary, ThreadTriage } from "../../shared/types";
import type {
  DecisionService,
  FileClassification,
  FileClassificationInput,
  SystemOneAnswer,
  SystemOneQuestion,
  SystemOneRequest,
  SystemOneResponse,
} from "../core/services";
import { getSettings } from "../core/settings";
import { DecisionCache } from "./cache";
import { cacheKey, callWithRetry, normalizeAnswer, probsToOrderedArray, resolveConfig, scoreTo1to5, unwrapResponse } from "./client";
import type { ResolvedDecisionConfig } from "./client";

const RISK_LEVELS = [
  "Trivial, no behavior impact",
  "Low risk, small isolated change",
  "Moderate risk, notable logic change",
  "High risk, broad or sensitive impact",
  "Security, data-loss, or outage potential",
];

const COMPLEXITY_LEVELS = [
  "Obvious, trivial to follow",
  "Simple, easy to follow",
  "Moderate, needs some focus to understand",
  "Complex, needs careful tracing through the code",
  "Needs deep understanding of the system to evaluate safely",
];

const SEVERITY_LEVELS = [
  "Cosmetic, no functional risk",
  "Minor, low risk",
  "Moderate, needs careful review",
  "High risk, significant impact",
  "Critical, high-risk or breaking change",
];

const ATTENTION_LEVELS = [
  "No urgency; can wait indefinitely",
  "Low urgency",
  "Moderate urgency",
  "High urgency",
  "Needs the viewer's attention now",
];

const CHANGE_TYPE_CRITERIA: Record<string, string> = {
  feature: "Adds new user- or system-facing functionality",
  fix: "Fixes a bug or incorrect behavior",
  refactor: "Restructures code without changing behavior",
  perf: "Improves performance without changing behavior",
  deps: "Updates or pins dependencies/versions",
  chore: "Maintenance with no product impact",
  docs: "Documentation-only change",
  test: "Test-only change",
};

const THREAD_TRIAGE_CRITERIA: Record<ThreadTriage, string> = {
  addressed: "The current code fully addresses the comment",
  partially: "The current code partially addresses the comment",
  not_addressed: "The current code has not changed in a way that addresses the comment",
  unclear: "It is unclear whether the comment is addressed",
};

/**
 * Simple bounded-concurrency limiter; no deps. One instance is shared for the whole lifetime of
 * a `DecisionService` (see `createDecisionService`) so `decision.concurrency` bounds the total
 * number of in-flight requests across *all* decide entry points (classifyFiles, prSeverity,
 * triageThreads, validator evaluation, …) — not just within a single `evaluate()` call.
 */
function makeLimiter(initialConcurrency: number) {
  let concurrency = Math.max(1, initialConcurrency);
  let active = 0;
  const queue: Array<() => void> = [];
  function pump() {
    while (active < concurrency && queue.length > 0) {
      const next = queue.shift();
      if (next) next();
    }
  }
  return {
    setConcurrency(next: number) {
      concurrency = Math.max(1, next);
      pump();
    },
    limit<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const run = () => {
          active++;
          fn()
            .then(resolve, reject)
            .finally(() => {
              active--;
              pump();
            });
        };
        queue.push(run);
        pump();
      });
    },
  };
}

export function createDecisionService(): DecisionService {
  const cache = new DecisionCache();
  const limiter = makeLimiter(8);

  async function status() {
    const settings = await getSettings();
    const { config, reason } = await resolveConfig();
    return {
      configured: config !== null,
      reason,
      provider: settings.decision.provider,
      model: settings.decision.model,
    };
  }

  /** Evaluates one request against a resolved config, using the cache and chunking any
   * uncached questions into groups of 64 sharing the request's state. */
  async function evaluateOne(config: ResolvedDecisionConfig, request: SystemOneRequest): Promise<SystemOneResponse | { error: string }> {
    try {
      const entries = Object.entries(request.questions);
      const answers: Record<string, SystemOneAnswer> = {};
      const toFetch: Array<[string, SystemOneQuestion]> = [];
      const keys = new Map<string, string>();
      for (const [name, question] of entries) {
        const key = cacheKey(config.model, request.state, question);
        keys.set(name, key);
        const cached = cache.get(key);
        if (cached) {
          answers[name] = cached;
        } else {
          toFetch.push([name, question]);
        }
      }

      let inputTokens = 0;
      for (let i = 0; i < toFetch.length; i += 64) {
        const chunk = toFetch.slice(i, i + 64);
        const body = {
          model: config.model,
          state: request.state,
          questions: Object.fromEntries(chunk),
        };
        const raw = await callWithRetry(config, body);
        const unwrapped = unwrapResponse(config.provider, raw);
        inputTokens += unwrapped.usage?.input_tokens ?? 0;
        for (const [name, question] of chunk) {
          const criteria = question.type === "score" ? question.criteria : undefined;
          const normalized = normalizeAnswer(unwrapped.answers?.[name], question.type, criteria);
          if (!normalized) {
            // Malformed/unusable response for this one question: leave it unanswered (callers
            // already treat a missing key as "unknown") rather than caching a guessed default
            // that would look just as confident as a real answer forever.
            console.error(
              `[pr-review] decision model returned an unusable answer for question "${name}" (type ${question.type}); not caching it.`,
            );
            continue;
          }
          answers[name] = normalized;
          cache.set(keys.get(name)!, normalized);
        }
      }

      return { answers, inputTokens };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function evaluate(requests: SystemOneRequest[]): Promise<Array<SystemOneResponse | { error: string }>> {
    const { config, reason } = await resolveConfig();
    if (!config) {
      const message = reason ?? "Decision model is not configured.";
      return requests.map(() => ({ error: message }));
    }
    limiter.setConcurrency(config.concurrency);
    return Promise.all(requests.map((request) => limiter.limit(() => evaluateOne(config, request))));
  }

  async function classifyFiles(inputs: FileClassificationInput[]): Promise<FileClassification[]> {
    const { config } = await resolveConfig();
    if (!config || inputs.length === 0) {
      return inputs.map((input) => ({
        path: input.path,
        moduleId: null,
        moduleConfidence: null,
        noiseProbability: null,
        risk: null,
        complexity: null,
      }));
    }
    const requests: SystemOneRequest[] = inputs.map((input) => ({
      state: { path: input.path, language: input.language, pr_title: input.prTitle, diff: input.diff },
      questions: {
        module: {
          type: "choice",
          instructions: "Which module does this file's change belong to? Consider `path`, `language`, `pr_title` and `diff`.",
          criteria: input.modules,
        },
        noise: {
          type: "noul",
          instructions:
            "Is this a mechanical, low-signal change to `path` (`diff`) — generated code, formatting, codemod, bulk rename, lockfile/version bump — that a reviewer can skim?",
        },
        risk: {
          type: "score",
          instructions: "How risky is this change to `path` if it turns out to be wrong, based on `diff`?",
          criteria: RISK_LEVELS,
        },
        complexity: {
          type: "score",
          instructions: "How much effort does it take to fully understand this change to `path`, based on `diff`?",
          criteria: COMPLEXITY_LEVELS,
        },
      },
    }));
    const responses = await evaluate(requests);
    return inputs.map((input, i) => {
      const res = responses[i];
      if ("error" in res) {
        return { path: input.path, moduleId: null, moduleConfidence: null, noiseProbability: null, risk: null, complexity: null };
      }
      const moduleAnswer = res.answers.module;
      const noiseAnswer = res.answers.noise;
      const riskAnswer = res.answers.risk;
      const complexityAnswer = res.answers.complexity;
      const moduleId = moduleAnswer?.type === "choice" && moduleAnswer.choice ? moduleAnswer.choice : null;
      const moduleConfidence =
        moduleAnswer?.type === "choice"
          ? moduleAnswer.probabilities[moduleAnswer.choice] ?? moduleAnswer.confidence ?? null
          : null;
      const noiseProbability = noiseAnswer?.type === "noul" ? noiseAnswer.noul : null;
      const risk = riskAnswer?.type === "score" ? scoreTo1to5(riskAnswer) : null;
      const complexity = complexityAnswer?.type === "score" ? scoreTo1to5(complexityAnswer) : null;
      return { path: input.path, moduleId, moduleConfidence, noiseProbability, risk, complexity };
    });
  }

  async function prSeverity(input: { title: string; body: string; stats: string; topHunks: string[] }) {
    const { config } = await resolveConfig();
    if (!config) return { severity: null, probabilities: null, changeType: null };
    const request: SystemOneRequest = {
      state: { title: input.title, body: input.body, stats: input.stats, top_hunks: input.topHunks },
      questions: {
        severity: {
          type: "score",
          instructions:
            "How severe or risky is this pull request overall, considering `title`, `body`, `stats` and `top_hunks`?",
          criteria: SEVERITY_LEVELS,
        },
        changeType: {
          type: "choice",
          instructions: "What kind of change is this pull request, based on `title`, `body` and `stats`?",
          criteria: CHANGE_TYPE_CRITERIA,
        },
      },
    };
    const [res] = await evaluate([request]);
    if ("error" in res) return { severity: null, probabilities: null, changeType: null };
    const severityAnswer = res.answers.severity;
    const changeTypeAnswer = res.answers.changeType;
    const severity = severityAnswer?.type === "score" ? scoreTo1to5(severityAnswer) : null;
    const probabilities = severityAnswer?.type === "score" ? probsToOrderedArray(severityAnswer.probabilities) : null;
    const changeType = changeTypeAnswer?.type === "choice" && changeTypeAnswer.choice ? changeTypeAnswer.choice : null;
    return { severity, probabilities, changeType };
  }

  async function triageThreads(
    inputs: Array<{ threadId: string; comment: string; originalHunk: string; currentHunk: string }>,
  ) {
    const { config } = await resolveConfig();
    if (!config || inputs.length === 0) {
      return inputs.map((input) => ({ threadId: input.threadId, triage: null, probability: null }));
    }
    const requests: SystemOneRequest[] = inputs.map((input) => ({
      state: { comment: input.comment, original_hunk: input.originalHunk, current_hunk: input.currentHunk },
      questions: {
        triage: {
          type: "choice",
          instructions:
            "Has the code changed since this review comment (`comment`) in a way that addresses it? Compare `original_hunk` (when the comment was made) to `current_hunk` (now).",
          criteria: THREAD_TRIAGE_CRITERIA,
        },
      },
    }));
    const responses = await evaluate(requests);
    return inputs.map((input, i) => {
      const res = responses[i];
      if ("error" in res) return { threadId: input.threadId, triage: null, probability: null };
      const answer = res.answers.triage;
      if (answer?.type !== "choice" || !answer.choice) return { threadId: input.threadId, triage: null, probability: null };
      const triage = answer.choice as ThreadTriage;
      const probability = answer.probabilities[answer.choice] ?? answer.confidence ?? null;
      return { threadId: input.threadId, triage, probability };
    });
  }

  async function substantiveChange(inputs: Array<{ path: string; delta: string }>) {
    const { config } = await resolveConfig();
    if (!config || inputs.length === 0) return inputs.map(() => null);
    const requests: SystemOneRequest[] = inputs.map((input) => ({
      state: { path: input.path, delta: input.delta },
      questions: {
        substantive: {
          type: "noul",
          instructions:
            "Does this delta to `path` change behavior or logic (not just rebase noise, formatting, comments, or renames)? See `delta`.",
        },
      },
    }));
    const responses = await evaluate(requests);
    return responses.map((res) => ("error" in res ? null : res.answers.substantive?.type === "noul" ? res.answers.substantive.noul : null));
  }

  async function attention(prs: PrSummary[]) {
    const { config } = await resolveConfig();
    if (!config || prs.length === 0) return prs.map(() => null);
    const requests: SystemOneRequest[] = prs.map((pr) => ({
      state: {
        title: pr.title,
        author: pr.author,
        sections: pr.sections,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changedFiles,
        checks: pr.checks,
        review_decision: pr.reviewDecision,
        is_draft: pr.isDraft,
        created_at: pr.createdAt,
        updated_at: pr.updatedAt,
        unresolved_threads: pr.unresolvedThreads,
      },
      questions: {
        attention: {
          type: "score",
          instructions:
            "How urgently does this pull request need the viewer's review attention, considering `title`, `author`, `sections`, size (`additions`, `deletions`, `changed_files`), `checks`, `review_decision`, `is_draft` and age (`created_at`, `updated_at`)?",
          criteria: ATTENTION_LEVELS,
        },
      },
    }));
    const responses = await evaluate(requests);
    return responses.map((res) => ("error" in res ? null : res.answers.attention?.type === "score" ? scoreTo1to5(res.answers.attention) : null));
  }

  return {
    status,
    evaluate,
    classifyFiles,
    prSeverity,
    triageThreads,
    substantiveChange,
    attention,
  };
}
