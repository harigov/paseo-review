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
import { agentChoicesRpc, agentTaskRpc, chatStartRpc, precomputeStatusRpc } from "../../shared/rpc";
import type { Module, Repo } from "../../shared/types";
import { listAgentChoices, pickDefaultChoice, readOnlyModeFor } from "./choices";
import { createPrWorktreeWorkspace, getOrCreateReviewWorkspace } from "./workspace";
import { startMcpServer, type McpHandle } from "./mcp";
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

/** Best-effort MCP toolset for one task; callers treat a null return as "no toolset this time". */
async function withMcp<T>(repo: Repo, number: number, fn: (mcp: McpHandle | null) => Promise<T>): Promise<T> {
  let mcp: McpHandle | null = null;
  try {
    mcp = await startMcpServer(repo, number);
  } catch (error) {
    console.error(`[pr-review] MCP server failed to start for ${repo.slug}#${number}:`, error);
  }
  try {
    return await fn(mcp);
  } finally {
    if (mcp) await mcp.close().catch(() => undefined);
  }
}

function mcpAgentFields(mcp: McpHandle | null): {
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
  const modeId = choice.modeId ?? readOnlyModeFor(choice.provider) ?? undefined;

  const [pr, analysis] = await Promise.all([
    services.github.getPr(input.repo, input.number),
    services.analysis.getAnalysis(input.repo, input.number),
  ]);
  const contextPack = await buildContextPack(repo, input.number, pr, analysis);

  // "describe" runs in the user's own workspace (their checkout); everything else runs in the
  // shared per-project "PR Review" workspace.
  const workspaceId = input.task === "describe" ? null : await getOrCreateReviewWorkspace(paseo, repo);
  const labels = { "pr-review.kind": input.task, "pr-review.pr": `${input.repo}#${input.number}` };
  const title = `PR Review · ${input.task} · ${repo.slug}#${input.number}`;

  return withMcp(repo, input.number, async (mcp) => {
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

async function startChat(
  paseo: PaseoApi,
  input: { repo: string; number: number; seed?: string; agentChoiceId?: string },
): Promise<{ agentId: string; workspaceId: string | null; reused: boolean }> {
  const key = `${input.repo}#${input.number}`;
  const chats = readChats();
  const existing = chats[key];
  if (existing) {
    try {
      const snapshot = await paseo.agents.ref(existing.agentId).refresh();
      if (snapshot && !snapshot.agent.archivedAt) {
        if (input.seed) await paseo.agents.ref(existing.agentId).send(input.seed).catch(() => undefined);
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
  const modeId = choice ? choice.modeId ?? readOnlyModeFor(choice.provider) ?? undefined : undefined;

  let workspaceId = await createPrWorktreeWorkspace(paseo, repo, input.number, pr.summary.title);
  if (!workspaceId) workspaceId = await getOrCreateReviewWorkspace(paseo, repo);

  return withMcp(repo, input.number, async (mcp) => {
    const config = {
      provider: choice?.provider ?? "claude/claude-sonnet-5",
      ...(modeId ? { modeId } : {}),
      ...(choice?.thinkingOptionId ? { thinkingOptionId: choice.thinkingOptionId } : {}),
      systemPrompt,
      ...mcpAgentFields(mcp),
    };
    const prompt = input.seed?.trim() || "Give me a 5-bullet orientation to this PR and wait for questions.";
    const labels = { "pr-review.kind": "chat", "pr-review.pr": key };
    const title = `PR #${input.number} · ${pr.summary.title}`.slice(0, 120);

    const agent = workspaceId
      ? await paseo.workspaces.ref(workspaceId).agents.create({ config, title, labels, prompt })
      : await paseo.agents.create({ config, cwd: repo.rootPath, title, labels, prompt });

    const resolvedWorkspaceId = workspaceId ?? agent.workspaceId ?? null;
    chats[key] = { agentId: agent.id, workspaceId: resolvedWorkspaceId };
    writeChats(chats);
    return { agentId: agent.id, workspaceId: resolvedWorkspaceId, reused: false };
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

  handle(server, chatStartRpc, async (input, context) => startChat(context.paseo, input));

  handle(server, precomputeStatusRpc, async () => getPrecomputeStatus());
}

/** Starts the precompute scheduler (first run 60s after start). The MCP toolset is started
 * lazily, per task/chat, by `withMcp`, so there is nothing further to start here. */
export function startBackground(): () => Promise<void> {
  const stopPrecompute = startPrecompute();
  return async () => {
    stopPrecompute();
  };
}
