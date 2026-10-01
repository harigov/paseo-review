import YAML from "yaml";
import type { ModuleSourceSchema } from "../../shared/types";
import { z } from "zod";
import { showFile } from "./git";
import type { ParsedFile } from "./diff";

type ModuleSource = z.infer<typeof ModuleSourceSchema>;

export interface ModuleDef {
  id: string;
  title: string;
  rank: number;
  description: string;
}

export const DEFAULT_MODULES: ModuleDef[] = [
  { id: "data", title: "Data model & migrations", rank: 1, description: "Schemas, migrations, models and data access." },
  { id: "api", title: "API & contracts", rank: 2, description: "API routes, handlers, RPC and schema contracts." },
  { id: "core", title: "Core logic", rank: 3, description: "Core application and business logic." },
  { id: "ui", title: "UI", rank: 4, description: "User interface components and views." },
  { id: "tests", title: "Tests", rank: 5, description: "Automated tests." },
  { id: "infra", title: "Infra / config / CI", rank: 6, description: "Build, CI, deployment and configuration." },
  { id: "docs", title: "Docs", rank: 7, description: "Documentation." },
  { id: "noise", title: "Noise", rank: 8, description: "Mechanical, generated or vendored changes." },
];

export interface RepoRule {
  glob: string;
  module: string;
}

export interface RepoOverride {
  modules: ModuleDef[] | null;
  rules: RepoRule[];
}

/** Translates a limited glob syntax (`**`, `*`, `?`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      // Swallow an immediately following slash so `**/foo` matches `foo` too.
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += ".";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export async function loadRepoOverride(mirror: string, headSha: string): Promise<RepoOverride> {
  const raw = await showFile(mirror, headSha, ".paseo/review.yml");
  if (!raw) return { modules: null, rules: [] };
  try {
    const parsed = YAML.parse(raw) as unknown;
    const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const modules = Array.isArray(obj.modules)
      ? (obj.modules as Array<Record<string, unknown>>)
          .filter((m) => typeof m.id === "string")
          .map((m, idx) => ({
            id: String(m.id),
            title: typeof m.title === "string" ? m.title : String(m.id),
            description: typeof m.description === "string" ? m.description : "",
            rank: idx + 1,
          }))
      : null;
    const rules = Array.isArray(obj.rules)
      ? (obj.rules as Array<Record<string, unknown>>)
          .filter((r) => typeof r.glob === "string" && typeof r.module === "string")
          .map((r) => ({ glob: String(r.glob), module: String(r.module) }))
      : [];
    return { modules, rules };
  } catch {
    return { modules: null, rules: [] };
  }
}

/** Merges a repo's custom module list with the defaults, keeping "noise" last. */
export function resolveTaxonomy(override: ModuleDef[] | null): ModuleDef[] {
  if (!override || override.length === 0) return DEFAULT_MODULES;
  const hasNoise = override.some((m) => m.id === "noise");
  const list = hasNoise ? override : [...override, { id: "noise", title: "Noise", rank: override.length + 1, description: "Mechanical, generated or vendored changes." }];
  return list.map((m, idx) => ({ ...m, rank: idx + 1 }));
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
]);

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function isNoisePath(p: string): { noise: true; reason: string } | null {
  const base = basename(p);
  if (LOCKFILE_NAMES.has(base) || base.endsWith(".lock")) return { noise: true, reason: `lockfile: ${base}` };
  if (/\.min\.(js|css)$/.test(p)) return { noise: true, reason: "minified file" };
  if (/(^|\/)__snapshots__\//.test(p) || /\.snap$/.test(p)) return { noise: true, reason: "test snapshot" };
  if (/(^|\/)(vendor|third_party|node_modules)\//.test(p)) return { noise: true, reason: "vendored dependency" };
  if (/(^|\/)(dist|build|generated)\//.test(p)) return { noise: true, reason: "generated/build output" };
  return null;
}

export interface GitAttributesRule {
  regex: RegExp;
  generated: boolean;
  vendored: boolean;
}

export function parseGitAttributes(raw: string): GitAttributesRule[] {
  const rules: GitAttributesRule[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    const pattern = parts[0];
    const attrs = parts.slice(1);
    const generated = attrs.includes("linguist-generated") || attrs.includes("linguist-generated=true");
    const vendored = attrs.includes("linguist-vendored") || attrs.includes("linguist-vendored=true");
    if (!generated && !vendored) continue;
    rules.push({ regex: globToRegExp(pattern.startsWith("/") ? pattern.slice(1) : `**/${pattern}`), generated, vendored });
  }
  return rules;
}

const TEST_RE = [/(^|\/)(__tests__|tests?|spec)\//, /\.(test|spec)\.\w+$/, /_test\.(go|py)$/, /(^|\/)test_[^/]+\.py$/];
const DATA_RE = [/(^|\/)migrations?\//, /schema/i, /\.sql$/, /prisma/i, /(^|\/)models?\//, /(^|\/)entities\//];
const API_RE = [/(^|\/)api\//, /(^|\/)routes?\//, /(^|\/)controllers?\//, /(^|\/)handlers?\//, /\.proto$/, /openapi/i, /graphql/i, /rpc/i];
const UI_RE = [/\.(tsx|jsx|vue|svelte|css|scss|html)$/, /(^|\/)components?\//, /(^|\/)pages?\//, /(^|\/)views?\//, /(^|\/)client\//, /(^|\/)frontend\//, /(^|\/)web\//];
const INFRA_RE = [
  /(^|\/)\.github\//,
  /Dockerfile/,
  /docker-compose/,
  /\.ya?ml$/,
  /terraform/i,
  /\.tf$/,
  /(^|\/)k8s\//,
  /helm/i,
  /(^|\/)Makefile$/,
  /(^|\/)package\.json$/,
  /tsconfig/,
  /config/i,
];
const DOCS_RE = [/(^|\/)docs?\//, /\.mdx?$/i, /README/i];

function matchesAny(p: string, regs: RegExp[]): boolean {
  return regs.some((r) => r.test(p));
}

export interface HeuristicResult {
  moduleId: string;
  source: ModuleSource;
  confidence: number | null;
  noiseReason: string | null;
}

/**
 * Pass 1: repo rules, then noise, then tests, then the remaining categories. Files that don't
 * confidently match fall back to "core" with source "fallback" (candidates for the decision model).
 */
export function classifyHeuristic(
  filePath: string,
  file: ParsedFile,
  rules: RepoRule[],
  gitattributes: GitAttributesRule[],
  taxonomy: ModuleDef[],
): HeuristicResult {
  const knownIds = new Set(taxonomy.map((m) => m.id));
  for (const rule of rules) {
    if (knownIds.has(rule.module) && globToRegExp(rule.glob).test(filePath)) {
      return { moduleId: rule.module, source: "rule", confidence: 1, noiseReason: null };
    }
  }

  const pathNoise = isNoisePath(filePath);
  if (pathNoise) return { moduleId: "noise", source: "rule", confidence: 1, noiseReason: pathNoise.reason };

  for (const ga of gitattributes) {
    if (ga.regex.test(filePath)) {
      return { moduleId: "noise", source: "rule", confidence: 1, noiseReason: ga.generated ? "linguist-generated" : "linguist-vendored" };
    }
  }

  if (file.status === "renamed" && file.effectiveLines === 0) {
    return { moduleId: "noise", source: "rule", confidence: 1, noiseReason: "rename-only" };
  }
  if (file.hunks.length > 0 && file.hunks.every((h) => h.whitespaceOnly)) {
    return { moduleId: "noise", source: "rule", confidence: 1, noiseReason: "whitespace-only" };
  }

  if (matchesAny(filePath, TEST_RE)) return { moduleId: "tests", source: "rule", confidence: 0.9, noiseReason: null };
  if (matchesAny(filePath, DATA_RE)) return { moduleId: "data", source: "rule", confidence: 0.7, noiseReason: null };
  if (matchesAny(filePath, API_RE)) return { moduleId: "api", source: "rule", confidence: 0.7, noiseReason: null };
  if (matchesAny(filePath, UI_RE)) return { moduleId: "ui", source: "rule", confidence: 0.7, noiseReason: null };
  if (matchesAny(filePath, INFRA_RE) && !/openapi/i.test(filePath)) return { moduleId: "infra", source: "rule", confidence: 0.6, noiseReason: null };
  if (matchesAny(filePath, DOCS_RE)) return { moduleId: "docs", source: "rule", confidence: 0.8, noiseReason: null };

  return { moduleId: "core", source: "fallback", confidence: null, noiseReason: null };
}
