import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { services } from "../core/services";
import type { Repo } from "../../shared/types";

// Minimal read-only MCP server (plan §8.2): a per-task HTTP JSON-RPC 2.0 endpoint on
// 127.0.0.1:<random>, bearer-token gated, scoped to one repo + PR number. Agents reach it
// through `config.mcpServers` + `config.toolPolicy.preapproved`. Best-effort: callers treat a
// null return as "no toolset this time" and omit both fields from the agent config.

export interface McpHandle {
  url: string;
  token: string;
  toolNames: string[];
  close(): Promise<void>;
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

const GUIDANCE_FILES = ["REVIEW.md", "AGENTS.md", "CLAUDE.md"];
const MAX_DIFF_CHARS = 60_000;

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
      description: "Repo guidance files (REVIEW.md, AGENTS.md, CLAUDE.md) at the PR head, up to 4k chars each.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => {
        const refs = await services.analysis.ensurePrRefs(ctx.repo, ctx.number);
        const files: Record<string, string> = {};
        for (const name of GUIDANCE_FILES) {
          const content = await services.analysis.readFileAtRef(ctx.repo, refs.headSha, name).catch(() => null);
          if (content) files[name] = content.slice(0, 4000);
        }
        return { files };
      },
    },
  ];
}

export async function startMcpServer(repo: Repo, number: number): Promise<McpHandle | null> {
  const tools = buildTools();
  const token = randomBytes(24).toString("hex");
  const ctx: ToolContext = { repo: repo.slug, number };

  return new Promise<McpHandle | null>((resolve) => {
    let server: Server;
    try {
      server = createServer((req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          void handleRequest(Buffer.concat(chunks).toString("utf8"), req.headers.authorization, token, tools, ctx, res);
        });
        req.on("error", () => res.writeHead(400).end());
      });
    } catch (error) {
      console.error("[pr-review] MCP server creation failed:", error);
      resolve(null);
      return;
    }

    server.on("error", (error) => {
      console.error("[pr-review] MCP server failed to start:", error);
      resolve(null);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        token,
        toolNames: tools.map((t) => t.name),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function handleRequest(
  raw: string,
  authorization: string | undefined,
  token: string,
  tools: ToolDef[],
  ctx: ToolContext,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const respond = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (authorization !== `Bearer ${token}`) {
    respond(401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } });
    return;
  }

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
        result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
      });
      return;
    }
    if (method === "tools/call") {
      const name = body.params?.name;
      const args = (body.params?.arguments as Record<string, unknown>) ?? {};
      const tool = tools.find((t) => t.name === name);
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
