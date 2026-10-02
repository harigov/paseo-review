import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handle } from "../core/handle";
import { startJob } from "../core/jobs";
import { dataDir } from "../core/paths";
import type { PaseoApi } from "../core/paseo";
import { waitForPaseo } from "../core/paseo";
import { services } from "../core/services";
import type { AgentService } from "../core/services";
import { agentChoicesRpc, agentTaskRpc, ChatStartResultSchema, chatStartRpc, precomputeStatusRpc } from "../../shared/rpc";
import type { Module, Repo } from "../../shared/types";
import { listAgentChoices, pickDefaultChoice, readOnlyModeFor } from "./choices";
import { createPrWorktreeWorkspace, getOrCreateReviewWorkspace } from "./workspace";
import { closeMcpServer, closeMcpSession, openMcpSession, type McpSession } from "./mcp";
import { buildContextPack, chatInstructions } from "./prompts";
import { extractHtmlBlock, extractJsonBlock, runGenerationAgent, type ExtractResult } from "./runner";
import { getPrecomputeStatus, startPrecompute } from "./precompute";

// Agent features (plan §8): JSON generation tasks (summary/explain/visual/describe), a chat
// entrypoint that opens a native Paseo agent, and the read-only MCP toolset + precompute
// scheduler wired up by startBackground().

const SummarySchema = z.object({
  overview: z.string(),
  modules: z.array(z.object({ id: z.string(), summary: z.string() })),
  risks: z.array(z.string()),
  questions: z.array(z.string()),
});

const ExplainSchema = z.object({
  explanation: z.string(),
  suggestedFix: z.string(),
  confidence: z.number(),
});

function extractJson<T>(schema: z.ZodType<T>): (text: string) => ExtractResult<T> {
  return (text) => {
    const parsed = extractJsonBlock(text);
    if (parsed === null) return { ok: false, reason: "no JSON object found" };
    const result = schema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: result.error.issues[0]?.message ?? "schema mismatch" };
    return { ok: true, value: result.data };
  };
}

function extractHtml(text: string): ExtractResult<string> {
  const html = extractHtmlBlock(text);
  if (!html) return { ok: false, reason: "no ```html code block found" };
  return { ok: true, value: html };
}

function extractNonEmpty(text: string): ExtractResult<string> {
  const trimmed = text.trim();
  return trimmed ? { ok: true, value: trimmed } : { ok: false, reason: "empty reply" };
}

async function findRepoOrThrow(slug: string): Promise<Repo> {
  const repo = await services.github.findRepo(slug);
  if (!repo) throw new Error(`Unknown repo ${slug}`);
  return repo;
}

/**
 * Best-effort MCP toolset for one generation task. The server is the one long-lived process
 * instance (started lazily, see mcp.ts); only this task's *session token* is scoped here, and
 * it's revoked once the task's turn is fully done — safe, because `runGenerationAgent` blocks
 * on `waitForFinish` (plus retries) before this `finally` runs. Callers treat a null return as
 * "no toolset this time" and omit `mcpServers`/`toolPolicy` from the agent config.
 */
async function withTaskMcp<T>(repo: Repo, number: number, fn: (mcp: McpSession | null) => Promise<T>): Promise<T> {
  let mcp: McpSession | null = null;
  try {
    mcp = await openMcpSession("task", repo, number);
  } catch (error) {
    console.error(`[pr-review] MCP session failed to open for ${repo.slug}#${number}:`, error);
  }
  try {
    return await fn(mcp);
  } finally {
    if (mcp) closeMcpSession(mcp.token);
  }
}

function mcpAgentFields(mcp: McpSession | null): {
  mcpServers?: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  toolPolicy?: { preapproved: Array<{ kind: "mcp"; server: string; tool: string }> };
} {
  if (!mcp) return {};
  return {
    mcpServers: { "pr-review": { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
    toolPolicy: { preapproved: mcp.toolNames.map((tool) => ({ kind: "mcp" as const, server: "pr-review", tool })) },
  };
}

async function runTask(input: {
  repo: string;
  number: number;
  task: "summary" | "explain" | "visual" | "describe";
  target?: string;
  agentChoiceId?: string;
}): Promise<unknown> {
  const paseo = await waitForPaseo();
  const repo = await findRepoOrThrow(input.repo);
  const choice = await pickDefaultChoice(paseo, input.task, input.agentChoiceId);
  if (!choice) throw new Error("No agent provider is available. Configure one in Paseo settings.");
  const modeId = choice.modeId ?? (await readOnlyModeFor(paseo, choice.provider)) ?? undefined;

  const [pr, analysis] = await Promise.all([
    services.github.getPr(input.repo, input.number),
    services.analysis.getAnalysis(input.repo, input.number),
  ]);
  const contextPack = await buildContextPack(repo, input.number, pr, analysis);

  // Every generation task, including "describe", runs in the shared per-project "PR Review"
  // workspace — never a bare `cwd` agent create, which silently makes the daemon provision a
  // brand-new, never-archived workspace on every single run (sidebar-hygiene leak, plan §9.1).
  const workspaceId = await getOrCreateReviewWorkspace(paseo, repo);
  if (!workspaceId) {
    throw new Error(`Could not open the shared "PR Review" workspace for ${repo.slug}. Check daemon logs and try again.`);
  }
  const labels = { "pr-review.kind": input.task, "pr-review.pr": `${input.repo}#${input.number}` };
  const title = `PR Review · ${input.task} · ${repo.slug}#${input.number}`;

  return withTaskMcp(repo, input.number, async (mcp) => {
    const common = {
      workspaceId,
      cwd: repo.rootPath,
      title,
      labels,
      provider: choice.provider,
      modeId,
      thinkingOptionId: choice.thinkingOptionId ?? undefined,
      systemPrompt: contextPack,
      ...mcpAgentFields(mcp),
    };

    if (input.task === "summary") {
      const prompt = [
        "Produce a reviewer-facing summary of this PR as a single ```json code block, matching exactly:",
        '{"overview": string (<=120 words), "modules": [{"id": string, "summary": string (<=40 words)}], "risks": string[], "questions": string[]}',
        "Use the module ids from the context above. Reply with ONLY the json code block.",
      ].join("\n");
      const result = await runGenerationAgent(paseo, { ...common, prompt }, extractJson(SummarySchema));
      const bySummary = new Map(result.modules.map((m) => [m.id, m.summary]));
      const modules: Module[] = (analysis?.modules ?? []).map((m) => ({ ...m, summary: bySummary.get(m.id) ?? m.summary }));
      const markdownParts = [result.overview];
      if (result.risks.length) markdownParts.push(`\n**Risks:**\n${result.risks.map((r) => `- ${r}`).join("\n")}`);
      if (result.questions.length) markdownParts.push(`\n**Questions:**\n${result.questions.map((q) => `- ${q}`).join("\n")}`);
      await services.analysis.patchAnalysis(input.repo, input.number, { summary: markdownParts.join("\n"), modules });
      return result;
    }

    if (input.task === "explain") {
      if (!input.target) throw new Error("explain requires a target");
      const prompt = [
        `Explain this finding: ${input.target}`,
        'Reply with ONLY a ```json code block: {"explanation": string, "suggestedFix": string, "confidence": number (0-1)}',
      ].join("\n");
      return runGenerationAgent(paseo, { ...common, prompt }, extractJson(ExplainSchema));
    }

    if (input.task === "visual") {
      const prompt =
        "Produce ONE self-contained HTML document (inline CSS/SVG/JS only, no external network requests) " +
        "diagramming this PR's architecture, data flow, and module map. Make it dark-friendly. " +
        "Reply with ONLY a ```html code block containing the full document.";
      const html = await runGenerationAgent(paseo, { ...common, prompt }, extractHtml);
      await services.analysis.patchAnalysis(input.repo, input.number, { visualOverviewHtml: html });
      return { visualOverviewHtml: html };
    }

    // describe
    const prompt =
      "Write a PR description in markdown for this change (for the author to copy into GitHub), followed by a " +
      "rich self-contained HTML block (inline CSS/SVG/JS only, <=50000 chars) wrapped exactly as:\n" +
      "<!-- paseo:html -->\n<html>...</html>\n<!-- /paseo:html -->\n" +
      "Reply with the markdown, then the paseo:html block, and nothing else.";
    const markdown = await runGenerationAgent(paseo, { ...common, prompt }, extractNonEmpty);
    return { markdown };
  });
}

// ---------- chat ----------

interface ChatEntry {
  agentId: string;
  workspaceId: string | null;
}

function chatsFile(): string {
  return path.join(dataDir(), "chats.json");
}

function readChats(): Record<string, ChatEntry> {
  try {
    return JSON.parse(readFileSync(chatsFile(), "utf8")) as Record<string, ChatEntry>;
  } catch {
    return {};
  }
}

function writeChats(map: Record<string, ChatEntry>): void {
  try {
    writeFileSync(chatsFile(), JSON.stringify(map, null, 2));
  } catch (error) {
    console.error("[pr-review] failed to write chats.json:", error);
  }
}

// Serializes `startChat` per repo#number so two concurrent `prr.chat.start` calls for the same
// PR can't both pass the "nothing active yet" check before either writes `chats.json` — which
// used to create two worktree workspaces + agents, orphaning one untracked.
const chatLocks = new Map<string, Promise<unknown>>();
function withChatLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chatLocks.get(key) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  chatLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

async function startChat(
  paseo: PaseoApi,
  input: { repo: string; number: number; seed?: string; agentChoiceId?: string },
): Promise<{ agentId: string; workspaceId: string | null; reused: boolean }> {
  const key = `${input.repo}#${input.number}`;
  return withChatLock(key, async () => {
    const chats = readChats();
    const existing = chats[key];
    if (existing) {
      try {
        const snapshot = await paseo.agents.ref(existing.agentId).refresh();
        if (snapshot && !snapshot.agent.archivedAt) {
          if (input.seed) {
            if (snapshot.agent.activeTurn) {
              console.error(
                `[pr-review] chat ${key} has a turn in progress; skipping the seed message rather than interrupting it`,
              );
            } else {
              // No `.catch()` here: a failed send must fail this RPC's job, not silently report
              // `reused: true` for a message that was never delivered.
              await paseo.agents.ref(existing.agentId).send(input.seed);
            }
          }
          return { agentId: existing.agentId, workspaceId: existing.workspaceId, reused: true };
        }
      } catch {
        // Agent no longer resolves; fall through and create a fresh one.
      }
    }

    const repo = await findRepoOrThrow(input.repo);
    const [pr, analysis] = await Promise.all([
      services.github.getPr(input.repo, input.number),
      services.analysis.getAnalysis(input.repo, input.number),
    ]);
    const refs = await services.analysis.ensurePrRefs(input.repo, input.number).catch(() => null);
    const contextPack = await buildContextPack(repo, input.number, pr, analysis);
    const instructions = chatInstructions(repo, input.number, refs?.mergeBaseSha ?? pr.baseSha);
    const systemPrompt = `${contextPack}\n\n## Instructions\n${instructions}`;

    const choice = await pickDefaultChoice(paseo, "chat", input.agentChoiceId);
    const modeId = choice ? choice.modeId ?? (await readOnlyModeFor(paseo, choice.provider)) ?? undefined : undefined;

    // No fallback to the shared "PR Review" workspace: that workspace is the user's own
    // checkout on whatever branch is currently active, not this PR's branch. Reviewing there
    // would silently discuss the wrong code. Fail loudly instead.
    const workspaceId = await createPrWorktreeWorkspace(paseo, repo, input.number, pr.summary.title);
    if (!workspaceId) {
      throw new Error(
        `Could not create the PR worktree workspace for ${repo.slug}#${input.number}. Check daemon logs and try again.`,
      );
    }

    // Chat sessions are opened on the one long-lived MCP server and intentionally never closed
    // here — they persist per repo#number for the life of the plugin process so the live,
    // multi-turn conversation keeps tool access instead of losing it moments after creation.
    const mcp = await openMcpSession("chat", repo, input.number);
    const config = {
      provider: choice?.provider ?? "claude/claude-sonnet-5",
      ...(modeId ? { modeId } : {}),
      ...(choice?.thinkingOptionId ? { thinkingOptionId: choice.thinkingOptionId } : {}),
      systemPrompt,
      ...mcpAgentFields(mcp),
    };
    // No default prompt: the agent sits idle with its system prompt + context pack until the
    // user actually asks something (plan §4). `prompt` stays optional on `agents.create`, so a
    // caller-supplied `seed` is still honored as the agent's first turn, same as reuse below.
    const seed = input.seed?.trim();
    const labels = { "pr-review.kind": "chat", "pr-review.pr": key };
    const title = `PR #${input.number} · ${pr.summary.title}`.slice(0, 120);

    const agent = await paseo.workspaces
      .ref(workspaceId)
      .agents.create({ config, title, labels, ...(seed ? { prompt: seed } : {}) });

    chats[key] = { agentId: agent.id, workspaceId };
    writeChats(chats);
    return { agentId: agent.id, workspaceId, reused: false };
  });
}

// ---------- registration ----------

export function createAgentService(): AgentService {
  return { runTask };
}

export function registerAgentHandlers(server: PluginServerContext): void {
  handle(server, agentChoicesRpc, async (_input, context) => {
    const choices = await listAgentChoices(context.paseo);
    return { choices };
  });

  handle(server, agentTaskRpc, async (input) => {
    const jobId = startJob(`agent:${input.task}`, async (update) => {
      update.stage("running", 0.2);
      const result = await services.agents.runTask(input);
      update.stage("done", 1);
      return result;
    });
    return { jobId };
  });

  handle(server, chatStartRpc, async (input, context) => {
    // Creating the PR worktree (and the first turn) can exceed the daemon's 30 s plugin-RPC
    // cap, so this goes through the job system like every other long operation. The dedupe key
    // also means a client that calls `prr.chat.start` twice in a row for the same PR before the
    // first job finishes joins that job instead of racing a second worktree/agent creation.
    const jobId = startJob(
      "chat",
      async () => {
        const result = await startChat(context.paseo, input);
        return ChatStartResultSchema.parse(result);
      },
      `chat:${input.repo}#${input.number}`,
    );
    return { jobId };
  });

  handle(server, precomputeStatusRpc, async () => getPrecomputeStatus());
}

/** Starts the precompute scheduler (first run 60s after start) and lets the MCP server start
 * lazily on first use. The returned stop function awaits any precompute tick already in flight
 * and then closes the MCP server, so no in-flight precompute run or live chat/task session is
 * left pointing at a server that just disappeared mid-shutdown. */
export function startBackground(): () => Promise<void> {
  const stopPrecompute = startPrecompute();
  return async () => {
    await stopPrecompute();
    await closeMcpServer();
  };
}
