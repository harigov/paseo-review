import type {
  Analysis,
  FileDiff,
  PrDetail,
  PrSummary,
  Repo,
  Thread,
  ThreadTriage,
  Validator,
  ValidatorResult,
  ViewedState,
} from "../../shared/types";

// Contracts between server areas. Each area implements its interface and registers it in
// index.server.ts; areas call each other only through `services`, never by importing
// another area's internals. This keeps parallel work independent.

// ---------- server/github ----------
export interface GitHubService {
  /** Paseo projects whose remote (origin, then upstream) is on github.com. */
  listRepos(): Promise<{ repos: Repo[]; errors: string[] }>;
  findRepo(slug: string): Promise<Repo | null>;
  getViewer(): Promise<string>;
  listInbox(refresh?: boolean): Promise<{ viewer: string; prs: PrSummary[]; fetchedAt: string; errors: string[] }>;
  getPr(repo: string, number: number, refresh?: boolean): Promise<PrDetail>;
  setViewed(repo: string, number: number, path: string, viewed: boolean): Promise<ViewedState>;
}

// ---------- server/analysis (git + pipeline) ----------
export interface PrRefs {
  mirrorPath: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
}

/** A unit of code the decision model evaluates (validators, risk, …). */
export interface ValidationUnit {
  /** Stable content-derived key (sha of path + hunk text + context). */
  key: string;
  kind: "hunk" | "file" | "pr";
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  /** System One `state` payload (keep it small and focused). */
  state: Record<string, unknown>;
  /** Short human-readable excerpt for the UI (≤ 400 chars). */
  excerpt: string;
}

export interface AnalysisService {
  /** Starts (or joins) the analysis pipeline job; returns the job id. */
  startAnalysis(repo: string, number: number, options?: { force?: boolean; reason?: "user" | "precompute" }): string;
  /** Latest cached analysis for the PR (any head), or null. */
  getAnalysis(repo: string, number: number): Promise<Analysis | null>;
  /** Fetch PR head/base into the plugin mirror and return exact SHAs. */
  ensurePrRefs(repo: string, number: number): Promise<PrRefs>;
  getFileDiff(
    repo: string,
    number: number,
    path: string,
    scope: "full" | "since_viewed" | "since_last_review",
  ): Promise<FileDiff>;
  /** Raw unified diff (merge-base..head), optionally for one path. Used by agent tools. */
  getRawDiff(repo: string, number: number, path?: string): Promise<string>;
  readFileAtRef(repo: string, ref: string, path: string): Promise<string | null>;
  /** `git grep` at a ref in the mirror; returns "path:line:text" lines (capped). */
  searchAtRef(repo: string, ref: string, pattern: string, maxResults?: number): Promise<string[]>;
  /** Units for validators for a PR at its current head. */
  buildPrUnits(repo: string, number: number): Promise<ValidationUnit[]>;
  /** Units for validators from a local working directory diff (`base...HEAD` + uncommitted). */
  buildLocalUnits(cwd: string, baseRef?: string): Promise<ValidationUnit[]>;
  /** Record a user module override. */
  moveFile(repo: string, number: number, path: string, moduleId: string): Promise<void>;
  /** Called by other areas to attach artifacts to the cached analysis (summary, visual HTML). */
  patchAnalysis(repo: string, number: number, patch: Partial<Pick<Analysis, "summary" | "visualOverviewHtml" | "modules">>): Promise<void>;
}

// ---------- server/decide (System One client + decision uses) ----------
export type SystemOneQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface SystemOneRequest {
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
}

export type SystemOneAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface SystemOneResponse {
  answers: Record<string, SystemOneAnswer>;
  inputTokens: number;
}

export interface FileClassificationInput {
  path: string;
  language: string;
  /** Diff excerpt (already trimmed by the caller). */
  diff: string;
  prTitle: string;
  /** Module ids → descriptions to choose from. */
  modules: Record<string, string>;
}

export interface FileClassification {
  path: string;
  moduleId: string | null;
  moduleConfidence: number | null;
  noiseProbability: number | null;
  risk: number | null;
  complexity: number | null;
}

export interface DecisionService {
  /** Whether a provider + credentials are configured. */
  status(): Promise<{ configured: boolean; reason: string | null; provider: string; model: string }>;
  /** Low-level batched evaluation (chunks of 64 questions, bounded concurrency, retries, cache). */
  evaluate(requests: SystemOneRequest[]): Promise<Array<SystemOneResponse | { error: string }>>;
  classifyFiles(inputs: FileClassificationInput[]): Promise<FileClassification[]>;
  prSeverity(input: { title: string; body: string; stats: string; topHunks: string[] }): Promise<{
    severity: number | null;
    probabilities: number[] | null;
    changeType: string | null;
  }>;
  triageThreads(
    inputs: Array<{ threadId: string; comment: string; originalHunk: string; currentHunk: string }>,
  ): Promise<Array<{ threadId: string; triage: ThreadTriage | null; probability: number | null }>>;
  /** P(substantive) for "changed since you viewed" deltas. */
  substantiveChange(inputs: Array<{ path: string; delta: string }>): Promise<Array<number | null>>;
  attention(prs: PrSummary[]): Promise<Array<number | null>>;
}

// ---------- server/validators ----------
export interface ValidatorService {
  /** Starter + personal + repo (`.paseo/validators/*.md` at `ref` in the mirror) validators. */
  loadValidators(repo: string, options?: { mirrorPath?: string; ref?: string; cwd?: string }): Promise<{
    validators: Validator[];
    errors: string[];
  }>;
  parseValidator(markdown: string, source: Validator["source"], path: string): Validator;
  evaluate(input: { validators: Validator[]; units: ValidationUnit[]; repo: string; number?: number }): Promise<ValidatorResult[]>;
  setEnabled(repo: string, validatorId: string, enabled: boolean): Promise<void>;
  dismiss(repo: string, number: number, validatorId: string, unitKey: string): Promise<void>;
  save(repo: string, target: "repo" | "personal", fileName: string, markdown: string): Promise<void>;
}

// ---------- server/agents ----------
export interface AgentService {
  /** Run a one-shot generation task through a Paseo agent; resolves with the parsed result. */
  runTask(input: {
    repo: string;
    number: number;
    task: "summary" | "explain" | "visual" | "describe";
    target?: string;
    agentChoiceId?: string;
  }): Promise<unknown>;
}

export interface Services {
  github: GitHubService;
  analysis: AnalysisService;
  decide: DecisionService;
  validators: ValidatorService;
  agents: AgentService;
}

/** Filled in by index.server.ts before any handler runs. */
export const services = {} as Services;

export type { Thread };
