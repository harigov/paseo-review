import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  AgentChoiceSchema,
  AnalysisSchema,
  FileDiffSchema,
  JobSchema,
  PrDetailSchema,
  PrSummarySchema,
  RepoSchema,
  StructuralDiffSchema,
  ValidatorResultSchema,
  ValidatorSchema,
  ViewedStateSchema,
} from "./types";
import { UiStateSchema } from "./ui-state";

// Every RPC finishes well under the daemon's 30 s cap. Long work starts a job and is polled.

/** "owner/name" — validated so it can never smuggle path segments into file names or API paths. */
export const RepoSlugSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected owner/name");
const PrRef = z.object({ repo: RepoSlugSchema, number: z.number().int().positive() });
const Ok = z.object({ ok: z.boolean(), message: z.string().nullable() });

// ---------- repos & inbox (server/github) ----------

export const reposListRpc = defineRpc({
  name: "prr.repos.list",
  input: z.object({}),
  output: z.object({ repos: z.array(RepoSchema), errors: z.array(z.string()) }),
});

export const inboxListRpc = defineRpc({
  name: "prr.inbox.list",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({
    viewer: z.string(),
    prs: z.array(PrSummarySchema),
    fetchedAt: z.string(),
    errors: z.array(z.string()),
  }),
});

export const prGetRpc = defineRpc({
  name: "prr.pr.get",
  input: PrRef.extend({ refresh: z.boolean().optional() }),
  output: PrDetailSchema,
});

export const fileViewedRpc = defineRpc({
  name: "prr.file.viewed",
  input: PrRef.extend({ path: z.string(), viewed: z.boolean() }),
  output: z.object({ path: z.string(), viewed: ViewedStateSchema }),
});

export const reviewSubmitRpc = defineRpc({
  name: "prr.review.submit",
  input: PrRef.extend({
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    body: z.string(),
    comments: z.array(
      z.object({ path: z.string(), line: z.number(), side: z.enum(["LEFT", "RIGHT"]), body: z.string() }),
    ),
  }),
  output: z.object({ url: z.string().nullable() }),
});

export const threadReplyRpc = defineRpc({
  name: "prr.thread.reply",
  input: PrRef.extend({ threadId: z.string(), body: z.string(), resolve: z.boolean().optional() }),
  output: Ok,
});

/** Posts a single review comment immediately (not part of a pending review). */
export const commentCreateRpc = defineRpc({
  name: "prr.comment.create",
  input: PrRef.extend({
    path: z.string(),
    line: z.number(),
    side: z.enum(["LEFT", "RIGHT"]),
    body: z.string(),
    commitSha: z.string(),
  }),
  output: z.object({ id: z.string(), url: z.string().nullable() }),
});

export const commentUpdateRpc = defineRpc({
  name: "prr.comment.update",
  input: PrRef.extend({ commentId: z.string(), body: z.string() }),
  output: Ok,
});

export const commentDeleteRpc = defineRpc({
  name: "prr.comment.delete",
  input: PrRef.extend({ commentId: z.string() }),
  output: Ok,
});


// ---------- analysis (server/analysis) ----------

export const prAnalyzeRpc = defineRpc({
  name: "prr.pr.analyze",
  input: PrRef.extend({ force: z.boolean().optional() }),
  output: z.object({ jobId: z.string() }),
});

export const jobPollRpc = defineRpc({
  name: "prr.job.poll",
  input: z.object({ jobId: z.string(), waitMs: z.number().max(20_000).optional() }),
  output: JobSchema,
});

export const prAnalysisRpc = defineRpc({
  name: "prr.pr.analysis",
  input: PrRef,
  output: z.object({ analysis: AnalysisSchema.nullable() }),
});

export const fileDiffRpc = defineRpc({
  name: "prr.file.diff",
  input: PrRef.extend({
    path: z.string(),
    scope: z.enum(["full", "since_viewed", "since_last_review"]),
  }),
  output: FileDiffSchema,
});

/** Maximum lines one `prr.file.lines` call returns; shared by the server cap and the client's "Expand all". */
export const FILE_LINES_MAX = 500;

/** Lines of a file at the PR head or merge base, for expanding context around a hunk. */
export const fileLinesRpc = defineRpc({
  name: "prr.file.lines",
  input: PrRef.extend({
    path: z.string(),
    side: z.enum(["base", "head"]),
    /** 1-based inclusive range; at most FILE_LINES_MAX lines per call. */
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  }),
  output: z.object({ lines: z.array(z.string()), totalLines: z.number() }),
});

export const fileStructuralDiffRpc = defineRpc({
  name: "prr.file.structural",
  input: PrRef.extend({ path: z.string() }),
  /** `diff` is null when the file isn't eligible for a structural view (see AnalyzedFile.structuralKind). */
  output: z.object({ diff: StructuralDiffSchema.nullable() }),
});

export const fileMoveRpc = defineRpc({
  name: "prr.file.move",
  input: PrRef.extend({ path: z.string(), moduleId: z.string() }),
  output: Ok,
});

// ---------- validators (server/validators) ----------

export const validatorsListRpc = defineRpc({
  name: "prr.validators.list",
  input: z.object({ repo: RepoSlugSchema }),
  output: z.object({ validators: z.array(ValidatorSchema), errors: z.array(z.string()) }),
});

export const validatorsToggleRpc = defineRpc({
  name: "prr.validators.toggle",
  input: z.object({ repo: RepoSlugSchema, validatorId: z.string(), enabled: z.boolean() }),
  output: Ok,
});

export const validatorsTestRpc = defineRpc({
  name: "prr.validators.test",
  input: PrRef.extend({ markdown: z.string() }),
  /** Job result: `{ result: ValidatorResult }`. */
  output: z.object({ jobId: z.string() }),
});

export const validatorsDismissRpc = defineRpc({
  name: "prr.validators.dismiss",
  input: PrRef.extend({ validatorId: z.string(), unitKey: z.string() }),
  output: Ok,
});

export const validatorsSaveRpc = defineRpc({
  name: "prr.validators.save",
  input: z.object({
    repo: RepoSlugSchema,
    target: z.enum(["repo", "personal"]),
    /** Bare file name only (no directories); ".md" is appended when missing. */
    fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "Use letters, digits, '.', '_' or '-' only"),
    markdown: z.string(),
  }),
  output: Ok,
});

export const localValidateRpc = defineRpc({
  name: "prr.local.validate",
  input: z.object({ cwd: z.string(), baseRef: z.string().optional() }),
  output: z.object({ jobId: z.string() }),
});

// ---------- agents (server/agents) ----------

export const agentChoicesRpc = defineRpc({
  name: "prr.agents.choices",
  input: z.object({}),
  output: z.object({ choices: z.array(AgentChoiceSchema) }),
});

export const agentTaskRpc = defineRpc({
  name: "prr.agent.task",
  input: PrRef.extend({
    task: z.enum(["summary", "explain", "visual", "describe"]),
    /** For explain: validatorId + unitKey, or a thread id. */
    target: z.string().optional(),
    agentChoiceId: z.string().optional(),
  }),
  output: z.object({ jobId: z.string() }),
});

export const ChatStartResultSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  reused: z.boolean(),
});
export type ChatStartResult = z.infer<typeof ChatStartResultSchema>;

export const chatStartRpc = defineRpc({
  name: "prr.chat.start",
  input: PrRef.extend({ seed: z.string().optional(), agentChoiceId: z.string().optional() }),
  /** Job result: ChatStartResult. Creating the PR worktree can exceed the 30 s RPC cap. */
  output: z.object({ jobId: z.string() }),
});

// ---------- UI state (server/ui-state) ----------

export const uiStateGetRpc = defineRpc({
  name: "prr.ui.get",
  input: z.object({}),
  output: z.object({ state: UiStateSchema }),
});

export const uiStateSetRpc = defineRpc({
  name: "prr.ui.set",
  input: z.object({ state: UiStateSchema }),
  output: Ok,
});

export const precomputeStatusRpc = defineRpc({
  name: "prr.precompute.status",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(),
    lastRunAt: z.string().nullable(),
    queued: z.number(),
    agentJobsToday: z.number(),
    lastError: z.string().nullable(),
  }),
});
