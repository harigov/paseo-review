import type { PaseoApi } from "../core/paseo";

// Agent runner (plan §8.1, pattern adapted from review-deck's ReviewService): create a
// one-shot generation agent, wait for its turn, extract the reply, validate it against the
// caller's expectation, retry once on a bad reply, and always archive in `finally`.

export interface AgentHandleLike {
  id: string;
  workspaceId: string | null;
  waitForFinish(timeoutMs?: number): Promise<{ status: string; error: string | null; lastMessage: string | null }>;
  run(text: string): Promise<{ status: string; error: string | null; lastMessage: string | null }>;
  timeline?: { refetch(options?: { limit?: number }): Promise<unknown> };
  archive(): Promise<unknown>;
}

/** Extracts a JSON value from a ```json fenced block, or the first {...} span otherwise. */
export function extractJsonBlock(text: string): unknown | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  let candidate = fence?.[1];
  if (!candidate) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    candidate = start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
  }
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** Extracts a self-contained HTML document from a ```html fenced block, or a raw <html>/<!DOCTYPE span. */
export function extractHtmlBlock(text: string): string | null {
  const fence = text.match(/```html\s*([\s\S]*?)```/i);
  if (fence?.[1]?.trim()) return fence[1].trim();
  const lower = text.toLowerCase();
  const start = lower.indexOf("<!doctype") >= 0 ? lower.indexOf("<!doctype") : lower.indexOf("<html");
  if (start >= 0) return text.slice(start).trim();
  return null;
}

/** Recovers the last assistant text from the timeline when waitForFinish settles without a
 * final lastMessage (the turn ended after a tool call, with the reply earlier in the timeline). */
export async function extractLastAssistantText(agent: AgentHandleLike): Promise<string | null> {
  if (!agent.timeline) return null;
  let payload: unknown;
  try {
    payload = await agent.timeline.refetch({ limit: 50 });
  } catch {
    return null;
  }
  const entries = (payload as { entries?: unknown[] } | null)?.entries;
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const item = (entries[i] as { item?: { type?: string; text?: unknown; content?: unknown[] } } | undefined)?.item;
    if (!item || item.type !== "assistant_message") continue;
    let text = "";
    if (typeof item.text === "string") {
      text = item.text;
    } else if (Array.isArray(item.content)) {
      text = item.content
        .filter((b): b is { type: string; text: string } => {
          const block = b as { type?: unknown; text?: unknown };
          return block?.type === "text" && typeof block.text === "string";
        })
        .map((b) => b.text)
        .join("");
    }
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export type ExtractResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface GenerationAgentOptions {
  workspaceId: string | null;
  cwd: string;
  title: string;
  labels: Record<string, string>;
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  systemPrompt?: string;
  mcpServers?: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  toolPolicy?: { preapproved: Array<{ kind: "mcp"; server: string; tool: string }> };
  prompt: string;
  timeoutMs?: number;
}

/** Runs a one-shot generation agent and extracts its reply with one retry on a bad shape. */
export async function runGenerationAgent<T>(
  paseo: PaseoApi,
  options: GenerationAgentOptions,
  extract: (text: string) => ExtractResult<T>,
): Promise<T> {
  const config = {
    provider: options.provider,
    ...(options.modeId ? { modeId: options.modeId } : {}),
    ...(options.thinkingOptionId ? { thinkingOptionId: options.thinkingOptionId } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
  };

  const agent = (
    options.workspaceId
      ? await paseo.workspaces.ref(options.workspaceId).agents.create({
          config,
          title: options.title,
          labels: options.labels,
          prompt: options.prompt,
          autoArchive: false,
        })
      : await paseo.agents.create({
          config,
          cwd: options.cwd,
          title: options.title,
          labels: options.labels,
          prompt: options.prompt,
          autoArchive: false,
        })
  ) as unknown as AgentHandleLike;

  try {
    let result = await agent.waitForFinish(options.timeoutMs ?? 10 * 60_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (result.status === "permission") {
        throw new Error("The agent is waiting on a permission request — open it in Paseo to continue.");
      }
      if (result.status === "error") {
        throw new Error(result.error ?? "The agent turn ended with an error.");
      }
      const text = result.status === "timeout" ? null : result.lastMessage ?? (await extractLastAssistantText(agent));
      if (text) {
        const parsed = extract(text);
        if (parsed.ok) return parsed.value;
        if (attempt === 0) {
          result = await agent.run(
            `That reply didn't match what was asked (${parsed.reason}). Reply again with exactly the requested format, nothing else.`,
          );
          continue;
        }
        throw new Error(`Agent output didn't match the expected format: ${parsed.reason}`);
      }
      if (result.status === "timeout") throw new Error("Agent timed out before finishing.");
      if (attempt === 0) {
        result = await agent.run("Please provide the requested output now.");
        continue;
      }
      throw new Error("Agent returned no output.");
    }
    throw new Error("Agent did not return usable output after retry.");
  } finally {
    await agent.archive().catch(() => undefined);
  }
}
