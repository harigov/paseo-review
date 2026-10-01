import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { run } from "../core/exec";
import { dataDir } from "../core/paths";
import type { Repo } from "../../shared/types";

/** Flags that keep `git diff`/`git show` output parseable regardless of user config. */
export const PINNED_DIFF_FLAGS = [
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
  "-c",
  "color.ui=never",
];

export function mirrorPath(repo: Repo): string {
  return path.join(dataDir("repos"), `${repo.owner}__${repo.name}.git`);
}

/** Runs `git -C <cwd> <pinned flags> <args>`. Rejects on non-zero exit unless `allowFailure`. */
export function gitAt(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number; maxBuffer?: number } = {},
) {
  return run("git", ["-C", cwd, ...PINNED_DIFF_FLAGS, ...args], {
    timeoutMs: options.timeoutMs ?? 60_000,
    allowFailure: options.allowFailure,
    maxBuffer: options.maxBuffer,
  });
}

async function gitOptional(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await gitAt(cwd, args, { allowFailure: true });
    if (result.code !== 0) return null;
    const trimmed = result.stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/** Simple per-mirror promise queue so concurrent RPCs don't race git operations. */
const queues = new Map<string, Promise<unknown>>();
export function withMirrorQueue<T>(mirror: string, work: () => Promise<T>): Promise<T> {
  const prior = queues.get(mirror) ?? Promise.resolve();
  const next = prior.then(work, work);
  queues.set(
    mirror,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Resolves the project's own remote URL (origin, then upstream) — may be an SSH host alias. */
export async function projectRemoteUrl(rootPath: string): Promise<string | null> {
  return (await gitOptional(rootPath, ["remote", "get-url", "origin"])) ?? (await gitOptional(rootPath, ["remote", "get-url", "upstream"]));
}

/**
 * Ensures a bare mirror exists for `repo`, cloned locally from the project's checkout
 * (never over https — the project's own remote may be a private SSH host alias), with its
 * `origin` pointed at that remote so PR refs can be fetched directly.
 */
export async function ensureMirror(repo: Repo): Promise<string> {
  const dir = mirrorPath(repo);
  return withMirrorQueue(dir, async () => {
    if (!existsSync(path.join(dir, "HEAD"))) {
      rmSync(dir, { recursive: true, force: true });
      await run("git", ["clone", "--bare", "--shared", repo.rootPath, dir], { timeoutMs: 180_000 });
    }
    const url = await projectRemoteUrl(repo.rootPath);
    if (url) {
      const current = await gitOptional(dir, ["remote", "get-url", "origin"]);
      if (current !== url) {
        const setResult = await gitAt(dir, ["remote", "set-url", "origin", url], { allowFailure: true });
        if (setResult.code !== 0) await gitAt(dir, ["remote", "add", "origin", url], { allowFailure: true });
      }
    }
    return dir;
  });
}

/** Fetches the PR head and base branch into the mirror. Best-effort per refspec. */
export async function fetchPrRefs(mirror: string, number: number, baseRef: string): Promise<void> {
  await withMirrorQueue(mirror, async () => {
    const combined = await gitAt(
      mirror,
      ["fetch", "origin", `+refs/pull/${number}/head:refs/pr/${number}/head`, `+refs/heads/${baseRef}:refs/heads/${baseRef}`],
      { allowFailure: true, timeoutMs: 180_000 },
    );
    if (combined.code === 0) return;
    // Retry individually so a missing base ref (renamed/deleted) doesn't block the PR head fetch.
    await gitAt(mirror, ["fetch", "origin", `+refs/pull/${number}/head:refs/pr/${number}/head`], {
      allowFailure: true,
      timeoutMs: 180_000,
    });
    await gitAt(mirror, ["fetch", "origin", `+refs/heads/${baseRef}:refs/heads/${baseRef}`], {
      allowFailure: true,
      timeoutMs: 180_000,
    });
  });
}

/** Best-effort fetch of a single, exact sha (e.g. an old review anchor). Ignored on failure. */
export async function fetchSha(mirror: string, sha: string): Promise<boolean> {
  return withMirrorQueue(mirror, async () => {
    const result = await gitAt(mirror, ["fetch", "origin", sha], { allowFailure: true, timeoutMs: 60_000 });
    return result.code === 0;
  });
}

export async function objectExists(mirror: string, sha: string): Promise<boolean> {
  const result = await gitAt(mirror, ["cat-file", "-e", sha], { allowFailure: true });
  return result.code === 0;
}

/** merge-base with a fallback fetch of the base branch / exact base sha when the object is missing. */
export async function mergeBase(mirror: string, baseSha: string, headSha: string, baseRef: string): Promise<string> {
  let result = await gitAt(mirror, ["merge-base", baseSha, headSha], { allowFailure: true });
  if (result.code !== 0) {
    await fetchSha(mirror, baseSha);
    result = await gitAt(mirror, ["merge-base", baseSha, headSha], { allowFailure: true });
  }
  if (result.code !== 0) {
    result = await gitAt(mirror, ["merge-base", `refs/heads/${baseRef}`, headSha], { allowFailure: true });
  }
  if (result.code !== 0) return baseSha;
  return result.stdout.trim();
}

export async function showFile(mirror: string, ref: string, filePath: string): Promise<string | null> {
  const result = await gitAt(mirror, ["show", `${ref}:${filePath}`], { allowFailure: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.code !== 0) return null;
  return result.stdout;
}

export async function fileSize(mirror: string, ref: string, filePath: string): Promise<number | null> {
  const result = await gitAt(mirror, ["cat-file", "-s", `${ref}:${filePath}`], { allowFailure: true });
  if (result.code !== 0) return null;
  const n = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export async function rawDiff(mirror: string, fromRef: string, toRef: string, filePath?: string): Promise<string> {
  const args = ["diff", "-M", "-C", "--find-copies", `${fromRef}..${toRef}`];
  if (filePath) args.push("--", filePath);
  const result = await gitAt(mirror, args, { allowFailure: true, maxBuffer: 128 * 1024 * 1024, timeoutMs: 120_000 });
  return result.stdout;
}

export async function numstat(mirror: string, fromRef: string, toRef: string): Promise<string> {
  const result = await gitAt(mirror, ["diff", "-M", "-C", "--find-copies", "--numstat", `${fromRef}..${toRef}`], {
    allowFailure: true,
    timeoutMs: 60_000,
  });
  return result.stdout;
}

export async function nameOnlyDiff(mirror: string, fromRef: string, toRef: string): Promise<string[]> {
  const result = await gitAt(mirror, ["diff", "--name-only", `${fromRef}..${toRef}`], { allowFailure: true, timeoutMs: 60_000 });
  if (result.code !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

export async function patchId(mirror: string, args: string[]): Promise<string | null> {
  const diffResult = await gitAt(mirror, ["diff", ...args], { allowFailure: true, timeoutMs: 60_000 });
  if (diffResult.code !== 0 || !diffResult.stdout.trim()) return diffResult.stdout.trim() ? null : "";
  const idResult = await run("git", ["patch-id", "--stable"], { input: diffResult.stdout, allowFailure: true });
  if (idResult.code !== 0) return null;
  return idResult.stdout.trim().split(/\s+/)[0] ?? null;
}

export async function grepAtRef(mirror: string, ref: string, pattern: string, maxResults = 50): Promise<string[]> {
  const result = await gitAt(mirror, ["grep", "-n", "-I", "--max-count=5", "-e", pattern, ref], { allowFailure: true });
  if (result.code !== 0) return [];
  return result.stdout.split("\n").filter(Boolean).slice(0, maxResults);
}

/** `git log --reverse --format=%H --name-only base..head`, parsed into per-commit file lists. */
export async function logNameStatusReverse(mirror: string, fromRef: string, toRef: string): Promise<string[][]> {
  const result = await gitAt(mirror, ["log", "--reverse", "--format=%x00%H", "--name-only", `${fromRef}..${toRef}`], {
    allowFailure: true,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) return [];
  const commits = result.stdout.split("\0").slice(1);
  return commits.map((block) =>
    block
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0),
  );
}

export async function showAtRef(mirror: string, ref: string, filePath: string): Promise<string | null> {
  return showFile(mirror, ref, filePath);
}
