import { z } from "zod";

// Domain types shared by the app and the plugin subprocess. Plain data only.

export const RepoSchema = z.object({
  /** "owner/name" on github.com */
  slug: z.string(),
  owner: z.string(),
  name: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  rootPath: z.string(),
  /** Whether the user opted in to sending this repo's code to the decision API. */
  decisionsEnabled: z.boolean(),
});
export type Repo = z.infer<typeof RepoSchema>;

export const InboxSectionSchema = z.enum(["mine", "review_requested", "assigned", "all"]);
export type InboxSection = z.infer<typeof InboxSectionSchema>;

export const ChecksStateSchema = z.enum(["success", "failure", "pending", "none"]);
export const ReviewDecisionSchema = z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "NONE"]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const PrSummarySchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  authorAvatarUrl: z.string().nullable(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: ReviewDecisionSchema,
  checks: ChecksStateSchema,
  unresolvedThreads: z.number(),
  labels: z.array(z.string()),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  sections: z.array(InboxSectionSchema),
  /** Decision-model enrichment from cache; null until analyzed. */
  changeType: z.string().nullable(),
  severity: z.number().nullable(),
  attention: z.number().nullable(),
  /** Files changed since the viewer's last submitted review; null when never reviewed. */
  changedSinceMyReview: z.number().nullable(),
});
export type PrSummary = z.infer<typeof PrSummarySchema>;

export const ThreadCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});

export const ThreadTriageSchema = z.enum(["addressed", "partially", "not_addressed", "unclear"]);
export type ThreadTriage = z.infer<typeof ThreadTriageSchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  originalLine: z.number().nullable(),
  diffSide: z.enum(["LEFT", "RIGHT"]),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(ThreadCommentSchema),
  /** Decision-model verdict on whether later commits addressed it. */
  triage: ThreadTriageSchema.nullable(),
  triageProbability: z.number().nullable(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const ViewedStateSchema = z.enum(["VIEWED", "UNVIEWED", "DISMISSED"]);
export type ViewedState = z.infer<typeof ViewedStateSchema>;

export const PrFileSchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changeType: z.string(),
  viewed: ViewedStateSchema,
});
export type PrFile = z.infer<typeof PrFileSchema>;

export const PrDetailSchema = z.object({
  summary: PrSummarySchema,
  body: z.string(),
  nodeId: z.string(),
  baseSha: z.string(),
  commits: z.number(),
  viewer: z.string(),
  /** Head commit of the viewer's latest submitted review, if any. */
  myLastReviewSha: z.string().nullable(),
  files: z.array(PrFileSchema),
  threads: z.array(ThreadSchema),
  checks: z.array(z.object({ name: z.string(), state: ChecksStateSchema, url: z.string().nullable() })),
});
export type PrDetail = z.infer<typeof PrDetailSchema>;

// ---------- Analysis ----------

export const ModuleSourceSchema = z.enum(["git", "rule", "decision", "user", "fallback"]);

export const AnalyzedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  binary: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  /** additions + deletions excluding moved, whitespace-only and pure-rename lines. */
  effectiveLines: z.number(),
  movedLines: z.number(),
  moduleId: z.string(),
  moduleSource: ModuleSourceSchema,
  moduleConfidence: z.number().nullable(),
  noiseReason: z.string().nullable(),
  /** 1–5 from the decision model; null when unavailable. */
  risk: z.number().nullable(),
  complexity: z.number().nullable(),
  viewed: ViewedStateSchema,
  /** For DISMISSED files with a locally recorded viewed blob: P(substantive change). */
  changedSinceViewedProbability: z.number().nullable(),
  changedSinceLastReview: z.boolean(),
  rebaseOnly: z.boolean(),
  /** Positions in each reading order (0-based, global across modules). */
  order: z.object({ foundations: z.number(), risk: z.number(), chrono: z.number() }),
});
export type AnalyzedFile = z.infer<typeof AnalyzedFileSchema>;

export const ModuleSchema = z.object({
  id: z.string(),
  title: z.string(),
  rank: z.number(),
  description: z.string(),
  fileCount: z.number(),
  additions: z.number(),
  deletions: z.number(),
  effectiveLines: z.number(),
  maxRisk: z.number().nullable(),
  viewedFiles: z.number(),
  summary: z.string().nullable(),
});
export type Module = z.infer<typeof ModuleSchema>;

export const ValidatorSeveritySchema = z.enum(["blocking", "warning", "info"]);
export const ValidatorUnitSchema = z.enum(["hunk", "file", "pr"]);

export const ValidatorSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: ValidatorSeveritySchema,
  unit: ValidatorUnitSchema,
  threshold: z.number(),
  violation: z.string(),
  compliant: z.string(),
  notApplicable: z.string(),
  body: z.string(),
  source: z.enum(["repo", "personal", "starter"]),
  path: z.string(),
  enabled: z.boolean(),
});
export type Validator = z.infer<typeof ValidatorSchema>;

export const ValidatorFindingSchema = z.object({
  unitKey: z.string(),
  path: z.string().nullable(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  probability: z.number(),
  status: z.enum(["fail", "uncertain"]),
  dismissed: z.boolean(),
  excerpt: z.string(),
});
export type ValidatorFinding = z.infer<typeof ValidatorFindingSchema>;

export const ValidatorResultSchema = z.object({
  validatorId: z.string(),
  title: z.string(),
  severity: ValidatorSeveritySchema,
  status: z.enum(["fail", "uncertain", "pass", "na", "error"]),
  unitsEvaluated: z.number(),
  unitsApplicable: z.number(),
  findings: z.array(ValidatorFindingSchema),
  error: z.string().nullable(),
});
export type ValidatorResult = z.infer<typeof ValidatorResultSchema>;

export const AnalysisSchema = z.object({
  repo: z.string(),
  number: z.number(),
  headSha: z.string(),
  baseSha: z.string(),
  mergeBaseSha: z.string(),
  analyzedAt: z.string(),
  decisionsEnabled: z.boolean(),
  decisionError: z.string().nullable(),
  changeType: z.string().nullable(),
  severity: z.number().nullable(),
  severityProbabilities: z.array(z.number()).nullable(),
  totals: z.object({
    files: z.number(),
    additions: z.number(),
    deletions: z.number(),
    effectiveLines: z.number(),
    movedLines: z.number(),
    noiseFiles: z.number(),
  }),
  modules: z.array(ModuleSchema),
  files: z.array(AnalyzedFileSchema),
  validators: z.array(ValidatorResultSchema),
  /** Anchor for "since my last review" (null when the viewer never reviewed). */
  sinceAnchorSha: z.string().nullable(),
  summary: z.string().nullable(),
  /** Self-contained HTML (from the PR body's paseo:html block), if present. */
  richDescriptionHtml: z.string().nullable(),
  visualOverviewHtml: z.string().nullable(),
  guidanceFiles: z.array(z.string()),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const DiffLineSchema = z.object({
  kind: z.enum(["context", "add", "del"]),
  oldNo: z.number().nullable(),
  newNo: z.number().nullable(),
  text: z.string(),
  /** Line belongs to a block git detected as moved. */
  moved: z.boolean(),
  whitespaceOnly: z.boolean(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const HunkSchema = z.object({
  header: z.string(),
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(DiffLineSchema),
  /** True when every changed line in the hunk is a moved line. */
  pureMove: z.boolean(),
  /** True when every changed line differs only in whitespace. */
  whitespaceOnly: z.boolean(),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const FileDiffSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  hunks: z.array(HunkSchema),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

export const JobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(["queued", "running", "done", "error"]),
  stage: z.string(),
  progress: z.number(),
  error: z.string().nullable(),
  /** Optional JSON result (e.g. agent output). */
  result: z.unknown().optional(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const AgentChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  kind: z.enum(["profile", "model"]),
});
export type AgentChoice = z.infer<typeof AgentChoiceSchema>;

export const ReadingOrderSchema = z.enum(["foundations", "risk", "chrono"]);
export type ReadingOrder = z.infer<typeof ReadingOrderSchema>;
