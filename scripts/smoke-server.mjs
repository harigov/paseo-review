// Runs the server contribution outside Paseo with a fake host and real gh/git.
// Usage: node scripts/smoke-server.mjs <projectPath> [prNumber]
import { build } from "esbuild";
import { createRequire } from "node:module";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [projectPath = "/home/hari/projects/viyamd", prArg] = process.argv.slice(2);
process.env.PASEO_HOME ??= mkdtempSync(path.join(tmpdir(), "prr-smoke-"));

const out = path.resolve("node_modules/.cache/prr-server-smoke.cjs");
import("node:fs").then((fs) => fs.mkdirSync(path.dirname(out), { recursive: true }));
const result = await build({
  entryPoints: ["index.server.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  // Bundle the SDK too: its package is ESM-only and the daemon normally supplies it.
  external: [],
  write: false,
  logLevel: "silent",
});
writeFileSync(out, result.outputFiles[0].text);
const require = createRequire(path.resolve("package.json"));
const contribute = require(out).default;

const handlers = new Map();
const settingsValues = { decisionRepos: [] };
const server = {
  registerSettings: () => ({
    read: async () => ({ status: "ready", revision: "1", values: settingsValues }),
    subscribe: () => () => {},
  }),
  handle: (contract, fn) => handlers.set(contract.name, { contract, fn }),
  on: () => () => {},
  before: () => () => {},
  registerProvider() {},
  registerUsageSource() {},
};
const paseo = {
  projects: {
    // Shape matches ProjectListResponseMessage.payload from @getpaseo/protocol (the real,
    // currently-installed SDK contract) — projectKind/projectRootPath/projectDisplayName/
    // projectId, not the speculative legacy names `fetchRepos()` also tolerates as a fallback.
    list: async () => ({
      requestId: "req_smoke",
      projects: [
        {
          projectId: "prj_smoke",
          projectDisplayName: path.basename(projectPath),
          projectRootPath: projectPath,
          projectKind: "git",
        },
      ],
    }),
  },
  config: { get: async () => ({ config: { daemon: { agentProfiles: [] } } }) },
  providers: { snapshot: async () => ({ entries: [] }) },
};
const cleanup = contribute(server);

async function call(name, input) {
  const entry = handlers.get(name);
  if (!entry) throw new Error(`no handler ${name}`);
  const parsed = entry.contract.input.parse(input);
  const t = Date.now();
  const output = await entry.fn(parsed, { paseo });
  entry.contract.output.parse(output);
  console.log(`✓ ${name} (${Date.now() - t} ms)`);
  return output;
}

console.log("handlers:", [...handlers.keys()].join(", "));
const repos = await call("prr.repos.list", {});
console.log("  repos:", repos.repos.map((r) => r.slug), repos.errors);
const inbox = await call("prr.inbox.list", { refresh: true });
console.log("  inbox:", inbox.prs.length, "PRs; viewer", inbox.viewer, inbox.errors);
const repo = repos.repos[0]?.slug;
const number = prArg ? Number(prArg) : inbox.prs.find((p) => p.repo === repo)?.number;
if (repo && number) {
  const detail = await call("prr.pr.get", { repo, number });
  console.log("  pr:", detail.summary.title, "files", detail.files.length, "threads", detail.threads.length);
  const { jobId } = await call("prr.pr.analyze", { repo, number, force: true });
  let job;
  do {
    job = await call("prr.job.poll", { jobId, waitMs: 15000 });
    console.log("  job:", job.status, job.stage, Math.round(job.progress * 100) + "%", job.error ?? "");
  } while (job.status === "running" || job.status === "queued");
  const { analysis } = await call("prr.pr.analysis", { repo, number });
  if (analysis) {
    console.log("  totals:", analysis.totals);
    console.log("  modules:", analysis.modules.map((m) => `${m.id}:${m.fileCount}`).join(" "));
    console.log("  decisionError:", analysis.decisionError, "validators:", analysis.validators.length);
    const file = analysis.files.find((f) => f.moduleId !== "noise") ?? analysis.files[0];
    if (file) {
      const diff = await call("prr.file.diff", { repo, number, path: file.path, scope: "full" });
      console.log("  diff:", file.path, diff.hunks.length, "hunks");
    }
  }
  const validators = await call("prr.validators.list", { repo });
  console.log("  validators:", validators.validators.length, validators.errors);
}
await call("prr.agents.choices", {});
await cleanup?.();
process.exit(0);
