import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { services } from "../core/services";
import { collectGuidanceFiles } from "./guidance";
import type { Repo } from "../../shared/types";

// Read-only MCP toolset (plan §8.2). One HTTP JSON-RPC 2.0 server for the whole plugin
// process, started lazily on first use and closed only when the plugin shuts down
// (startBackground's cleanup) — not per task/chat. Each caller gets its own bearer token,
// mapped server-side to the {repo, number} it may read. Task-session tokens are revoked when
// the task ends; chat-session tokens persist and are reused per repo#number for as long as the
// process lives, so the MCP server stays reachable for the whole live conversation, not just
// the moment the chat agent is created.

export interface McpSession {
  url: string;
  token: string;
  toolNames: string[];
}

interface ToolContext {
  repo: string;
  number: number;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

const MAX_DIFF_CHARS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — these are small JSON-RPC calls, not uploads.

function buildTools(): ToolDef[] {
  return [
    {
      name: "pr_overview",
      description: "Title, stats, modules and cached analysis for this PR.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => {
        const [pr, analysis] = await Promise.all([
          services.github.getPr(ctx.repo, ctx.number),
          services.analysis.getAnalysis(ctx.repo, ctx.number),
        ]);
        return { summary: pr.summary, body: pr.body.slice(0, 6000), analysis };
      },
    },
    {
      name: "list_files",
      description: "Changed files in this PR, optionally filtered to one module id.",
      inputSchema: { type: "object", properties: { module: { type: "string" } } },
      handler: async (args, ctx) => {
        const analysis = await services.analysis.getAnalysis(ctx.repo, ctx.number);
        const files = analysis?.files ?? [];
        const module = typeof args.module === "string" ? args.module : null;
        return { files: module ? files.filter((f) => f.moduleId === module) : files };
      },
    },
    {
      name: "get_diff",
      description: "Unified diff for the whole PR, or one file when `path` is given. Truncated to 60k chars.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      handler: async (args, ctx) => {
        const path = typeof args.path === "string" ? args.path : undefined;
        const diff = await services.analysis.getRawDiff(ctx.repo, ctx.number, path);
        return { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS };
      },
    },
    {
      name: "read_file",
      description: "Reads one file at the PR's head or base commit.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, ref: { type: "string", enum: ["head", "base"] } },
        required: ["path"],
      },
      handler: async (args, ctx) => {
        const filePath = String(args.path ?? "");
        const refs = await services.analysis.ensurePrRefs(ctx.repo, ctx.number);
        const sha = args.ref === "base" ? refs.baseSha : refs.headSha;
        const content = await services.analysis.readFileAtRef(ctx.repo, sha, filePath);
        return { path: filePath, ref: args.ref === "base" ? "base" : "head", content };
      },
    },
    {
      name: "search",
      description: "git grep for a pattern at the PR's head commit.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      handler: async (args, ctx) => {
        const refs = await services.analysis.ensurePrRefs(ctx.repo, ctx.number);
        const results = await services.analysis.searchAtRef(ctx.repo, refs.headSha, String(args.pattern ?? ""));
        return { results };
      },
    },
    {
      name: "list_threads",
      description: "Review threads (resolved and unresolved) on this PR.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => {
        const pr = await services.github.getPr(ctx.repo, ctx.number);
        return { threads: pr.threads };
      },
    },
    {
      name: "list_findings",
      description: "Validator results and findings for this PR's cached analysis.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => {
        const analysis = await services.analysis.getAnalysis(ctx.repo, ctx.number);
        return { validators: analysis?.validators ?? [] };
      },
    },
    {
      name: "repo_guidance",
      description: "Repo guidance files (REVIEW.md, AGENTS.md, CLAUDE.md) from the repo root and the nearest ancestor of each touched directory, up to 4k chars each.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => {
        const [refs, analysis] = await Promise.all([
          services.analysis.ensurePrRefs(ctx.repo, ctx.number),
          services.analysis.getAnalysis(ctx.repo, ctx.number),
        ]);
        const touchedPaths = analysis?.files.map((f) => f.path) ?? [];
        const guidance = await collectGuidanceFiles(ctx.repo, refs.headSha, touchedPaths);
        const files: Record<string, string> = {};
        for (const file of guidance) files[file.path] = file.content;
        return { files };
      },
    },
  ];
}

const TOOLS = buildTools();
const TOOL_NAMES = TOOLS.map((t) => t.name);

type SessionKind = "task" | "chat";
interface Session {
  kind: SessionKind;
  repo: string;
  number: number;
}

const sessions = new Map<string, Session>(); // token -> session
const chatTokensByKey = new Map<string, string>(); // "repo#number" -> token

let server: Server | null = null;
let serverUrl: string | null = null;
let startPromise: Promise<string | null> | null = null;

function chatKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

async function ensureServerStarted(): Promise<string | null> {
  if (serverUrl) return serverUrl;
  if (startPromise) return startPromise;
  startPromise = new Promise<string | null>((resolve) => {
    let created: Server;
    try {
      created = createServer((req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let rejected = false;
        req.on("data", (chunk: Buffer) => {
          if (rejected) return;
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            rejected = true;
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32011, message: "Request body too large" } }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (rejected) return;
          void handleRequest(Buffer.concat(chunks).toString("utf8"), req.headers.authorization, res);
        });
        req.on("error", () => res.writeHead(400).end());
      });
    } catch (error) {
      console.error("[pr-review] MCP server creation failed:", error);
      resolve(null);
      return;
    }

    created.on("error", (error) => {
      console.error("[pr-review] MCP server failed to start:", error);
      resolve(null);
    });
    created.listen(0, "127.0.0.1", () => {
      const address = created.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server = created;
      serverUrl = `http://127.0.0.1:${port}/mcp`;
      resolve(serverUrl);
    });
  });
  const url = await startPromise;
  startPromise = null;
  return url;
}

/**
 * Opens a session for `{repo, number}` on the one long-lived MCP server, starting it if
 * necessary. Chat sessions are looked up by repo#number and reused for as long as the process
 * runs (so re-opening the same PR's chat keeps using the same token); task sessions always get
 * a fresh token that the caller must revoke with `closeMcpSession` when the task finishes.
 * Returns null when the server itself failed to start — callers treat that as "no toolset this
 * time" and omit `mcpServers`/`toolPolicy` from the agent config.
 */
export async function openMcpSession(kind: SessionKind, repo: Repo, number: number): Promise<McpSession | null> {
  const url = await ensureServerStarted();
  if (!url) return null;

  if (kind === "chat") {
    const key = chatKey(repo.slug, number);
    const existingToken = chatTokensByKey.get(key);
    if (existingToken && sessions.has(existingToken)) {
      return { url, token: existingToken, toolNames: TOOL_NAMES };
    }
    const token = randomBytes(24).toString("hex");
    sessions.set(token, { kind, repo: repo.slug, number });
    chatTokensByKey.set(key, token);
    return { url, token, toolNames: TOOL_NAMES };
  }

  const token = randomBytes(24).toString("hex");
  sessions.set(token, { kind, repo: repo.slug, number });
  return { url, token, toolNames: TOOL_NAMES };
}

/** Revokes a task session's token. Chat tokens are intentionally left alone (they persist for
 * the process lifetime); pass a chat token here is a no-op. */
export function closeMcpSession(token: string): void {
  const session = sessions.get(token);
  if (!session || session.kind === "chat") return;
  sessions.delete(token);
}

/** Closes the MCP server and drops all sessions. Called once, from startBackground's cleanup. */
export async function closeMcpServer(): Promise<void> {
  sessions.clear();
  chatTokensByKey.clear();
  const current = server;
  server = null;
  serverUrl = null;
  if (!current) return;
  await new Promise<void>((done) => current.close(() => done()));
}

async function handleRequest(
  raw: string,
  authorization: string | undefined,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const respond = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  const session = token ? sessions.get(token) : undefined;
  if (!session) {
    respond(401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } });
    return;
  }
  const ctx: ToolContext = { repo: session.repo, number: session.number };

  let body: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    respond(400, { jsonrpc: "2.0", error: { code: -32700, message: "Invalid JSON" } });
    return;
  }

  const id = body?.id ?? null;
  const method = body?.method;

  if (method === "notifications/initialized") {
    res.writeHead(204).end();
    return;
  }

  try {
    if (method === "initialize") {
      respond(200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "pr-review", version: "0.1.0" },
        },
      });
      return;
    }
    if (method === "ping") {
      respond(200, { jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      respond(200, {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
      });
      return;
    }
    if (method === "tools/call") {
      const name = body.params?.name;
      const args = (body.params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        respond(200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${String(name)}` } });
        return;
      }
      const result = await tool.handler(args, ctx);
      respond(200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      return;
    }
    respond(200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${String(method)}` } });
  } catch (error) {
    respond(200, { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}
