import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PaseoApi } from "../core/paseo";
import { dataDir } from "../core/paths";
import type { Repo } from "../../shared/types";

// Sidebar hygiene (plan §9.1): one "PR Review" workspace per project hosts analysis/generation
// agents (archived after every job); PR worktree workspaces are created only for chat, titled
// "PR #<n> · <title>" and reused per PR.

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (error) {
    console.error(`[pr-review] failed to write ${file}:`, error);
  }
}

function workspacesFile(): string {
  return path.join(dataDir(), "workspaces.json");
}

/** Finds or creates the per-project "PR Review" workspace used for analysis/generation agents. */
export async function getOrCreateReviewWorkspace(paseo: PaseoApi, repo: Repo): Promise<string | null> {
  const map = readJson<Record<string, string>>(workspacesFile(), {});
  const cached = map[repo.projectId];
  if (cached) {
    try {
      const snapshot = await paseo.workspaces.ref(cached).refresh();
      if (snapshot && !snapshot.archivingAt) return cached;
    } catch {
      // fall through to search/create
    }
  }

  try {
    const found = await paseo.workspaces.list({ filter: { projectId: repo.projectId, query: "PR Review" } });
    const match = found.entries.find((entry) => {
      const label = entry.title ?? entry.name ?? "";
      return entry.projectRootPath === repo.rootPath && label.includes("PR Review");
    });
    if (match) {
      map[repo.projectId] = match.id;
      writeJson(workspacesFile(), map);
      return match.id;
    }
  } catch (error) {
    console.error("[pr-review] workspaces.list() failed:", error);
  }

  try {
    const created = await paseo.workspaces.create({
      source: { kind: "directory", path: repo.rootPath },
      title: `PR Review · ${repo.slug}`,
    });
    map[repo.projectId] = created.id;
    writeJson(workspacesFile(), map);
    return created.id;
  } catch (error) {
    console.error("[pr-review] workspaces.create() failed for the PR Review workspace:", error);
    return null;
  }
}

/** Creates (or signals the caller to fall back for) the PR's worktree workspace, used only for chat. */
export async function createPrWorktreeWorkspace(
  paseo: PaseoApi,
  repo: Repo,
  number: number,
  title: string,
): Promise<string | null> {
  try {
    const created = await paseo.workspaces.create({
      title: `PR #${number} · ${title}`.slice(0, 120),
      source: {
        kind: "worktree",
        cwd: repo.rootPath,
        action: "checkout",
        checkoutSource: { kind: "change_request", forge: "github", number },
      },
    });
    return created.id;
  } catch (error) {
    console.error(`[pr-review] worktree workspace creation failed for ${repo.slug}#${number}:`, error);
    return null;
  }
}
