import { createHash } from "node:crypto";
import { run } from "../core/exec";
import type { ValidationUnit } from "../core/services";
import { annotateMovesAndWhitespace, parseUnifiedDiff, type ParsedFile } from "./diff";
import { gatherPr } from "./core";
import { classifyHeuristic, DEFAULT_MODULES } from "./modules";
import { showFile } from "./git";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  rs: "rust",
  rb: "ruby",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  sql: "sql",
};

function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "text";
}

function key(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function hunkText(hunk: ParsedFile["hunks"][number]): string {
  const lines = [hunk.header];
  for (const l of hunk.lines) {
    const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    lines.push(marker + l.text);
  }
  return lines.join("\n").slice(0, 6000);
}

async function contextAround(
  mirror: string,
  ref: string,
  path: string,
  hunk: ParsedFile["hunks"][number],
  fileLinesCache: Map<string, string[] | null>,
): Promise<string> {
  let lines = fileLinesCache.get(path);
  if (lines === undefined) {
    const content = await showFile(mirror, ref, path);
    lines = content ? content.split("\n") : null;
    fileLinesCache.set(path, lines);
  }
  if (!lines) return "";
  const start = Math.max(0, hunk.newStart - 20 - 1);
  const end = Math.min(lines.length, hunk.newStart + hunk.newLines + 20);
  return lines.slice(start, end).join("\n").slice(0, 3000);
}

export async function buildPrUnits(repoSlug: string, number: number): Promise<ValidationUnit[]> {
  const { detail, refs, parsedFiles, moduleOf } = await gatherPr(repoSlug, number);
  return buildUnitsFromGathered(detail, refs.mirrorPath, refs.headSha, parsedFiles, moduleOf);
}

export async function buildUnitsFromGathered(
  detail: { summary: { title: string }; body: string },
  mirror: string,
  headSha: string,
  parsedFiles: ParsedFile[],
  moduleOf: Map<string, { moduleId: string }>,
): Promise<ValidationUnit[]> {
  const units: ValidationUnit[] = [];
  const statsLines: string[] = [];
  const fileLinesCache = new Map<string, string[] | null>();

  for (const file of parsedFiles) {
    const assignment = moduleOf.get(file.path);
    if (assignment?.moduleId === "noise") continue;
    statsLines.push(`${file.path}: +${file.additions}/-${file.deletions}`);
    if (file.binary) continue;

    const fileDiffText = file.hunks.map(hunkText).join("\n").slice(0, 12_000);
    units.push({
      key: key([file.path, fileDiffText, "file"]),
      kind: "file",
      path: file.path,
      startLine: null,
      endLine: null,
      state: { pr_title: detail.summary.title, path: file.path, file_diff: fileDiffText },
      excerpt: `${file.path} (+${file.additions}/-${file.deletions})`.slice(0, 400),
    });

    for (const hunk of file.hunks) {
      const text = hunkText(hunk);
      const context = await contextAround(mirror, headSha, file.path, hunk, fileLinesCache);
      units.push({
        key: key([file.path, text, context]),
        kind: "hunk",
        path: file.path,
        startLine: hunk.newStart,
        endLine: hunk.newStart + hunk.newLines - 1,
        state: { pr_title: detail.summary.title, path: file.path, language: languageOf(file.path), hunk: text, context },
        excerpt: text.slice(0, 400),
      });
    }
  }

  units.push({
    key: key([detail.summary.title, "pr"]),
    kind: "pr",
    path: null,
    startLine: null,
    endLine: null,
    state: {
      title: detail.summary.title,
      body: detail.body.slice(0, 4000),
      files_with_stats: statsLines.slice(0, 500),
    },
    excerpt: detail.summary.title.slice(0, 400),
  });

  return units;
}

async function resolveLocalBaseRef(cwd: string, baseRef?: string): Promise<string> {
  if (baseRef) return baseRef;
  const originHead = await run("git", ["-C", cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowFailure: true });
  if (originHead.code === 0 && originHead.stdout.trim()) return originHead.stdout.trim().replace(/^refs\/remotes\//, "");
  return "main";
}

export async function buildLocalUnits(cwd: string, baseRef?: string): Promise<ValidationUnit[]> {
  const resolvedBase = await resolveLocalBaseRef(cwd, baseRef);
  const mergeBaseResult = await run("git", ["-C", cwd, "merge-base", resolvedBase, "HEAD"], { allowFailure: true });
  const base = mergeBaseResult.code === 0 ? mergeBaseResult.stdout.trim() : resolvedBase;

  const diffResult = await run("git", ["-C", cwd, "diff", "-M", "-C", "--find-copies", base], {
    allowFailure: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsedFiles = parseUnifiedDiff(diffResult.stdout);
  annotateMovesAndWhitespace(parsedFiles);

  const units: ValidationUnit[] = [];
  for (const file of parsedFiles) {
    const assignment = classifyHeuristic(file.path, file, [], [], DEFAULT_MODULES);
    if (assignment.moduleId === "noise" || file.binary) continue;
    const fileDiffText = file.hunks.map(hunkText).join("\n").slice(0, 12_000);
    units.push({
      key: key([file.path, fileDiffText, "local-file"]),
      kind: "file",
      path: file.path,
      startLine: null,
      endLine: null,
      state: { pr_title: "local changes", path: file.path, file_diff: fileDiffText },
      excerpt: `${file.path} (+${file.additions}/-${file.deletions})`.slice(0, 400),
    });
    for (const hunk of file.hunks) {
      const text = hunkText(hunk);
      units.push({
        key: key([file.path, text, "local-hunk"]),
        kind: "hunk",
        path: file.path,
        startLine: hunk.newStart,
        endLine: hunk.newStart + hunk.newLines - 1,
        state: { pr_title: "local changes", path: file.path, language: languageOf(file.path), hunk: text, context: "" },
        excerpt: text.slice(0, 400),
      });
    }
  }
  return units;
}
