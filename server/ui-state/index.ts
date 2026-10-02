import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handle } from "../core/handle";
import { dataDir } from "../core/paths";
import { uiStateGetRpc, uiStateSetRpc } from "../../shared/rpc";
import { DEFAULT_UI_STATE, UiStateSchema, type RecentPr, type UiState } from "../../shared/ui-state";

const RECENTS_CAP = 20;

function recentKey(pr: { repo: string; number: number }): string {
  return `${pr.repo.toLowerCase()}#${pr.number}`;
}

/**
 * Merges the recents from an incoming (client) state with what is already on disk, keeping the
 * newer `openedAt` / `reviewedAt` per PR. Two surfaces (two windows) each hold their own copy of
 * the state, so a plain overwrite would drop whichever PR the other window opened last.
 */
export function mergeRecents(existing: RecentPr[], incoming: RecentPr[]): RecentPr[] {
  const byKey = new Map<string, RecentPr>();
  for (const pr of [...existing, ...incoming]) {
    const key = recentKey(pr);
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, pr);
      continue;
    }
    const newest = pr.openedAt > prior.openedAt ? pr : prior;
    const reviewedAt = [pr.reviewedAt, prior.reviewedAt].filter((v): v is string => !!v).sort().pop() ?? null;
    byKey.set(key, { ...newest, reviewedAt });
  }
  return [...byKey.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, RECENTS_CAP);
}

function file(): string {
  return path.join(dataDir(), "ui-state.json");
}

/** Serializes load/save so two near-simultaneous `prr.ui.set` calls (e.g. two surface instances)
 * can't interleave a read-modify-write and have an older write clobber a newer one on disk. */
let queue: Promise<unknown> = Promise.resolve();
function withQueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/** Loads `ui-state.json` from `dataDir()`. A missing file, unreadable file, invalid JSON, or a
 * JSON value that fails the schema all fall back to `DEFAULT_UI_STATE` rather than throwing. */
export async function loadUiState(): Promise<UiState> {
  try {
    const raw = await readFile(file(), "utf8");
    const parsed = UiStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_UI_STATE;
  } catch {
    return DEFAULT_UI_STATE;
  }
}

/** Writes `ui-state.json` atomically: write to a temp file in the same directory, then rename
 * over the target, so a crash or concurrent read never observes a half-written file. */
export function saveUiState(state: UiState): Promise<void> {
  return withQueue(async () => {
    const target = file();
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, target);
  });
}

export function registerUiStateHandlers(server: PluginServerContext): void {
  handle(server, uiStateGetRpc, async () => ({ state: await loadUiState() }));

  handle(server, uiStateSetRpc, async (input) => {
    const existing = await loadUiState();
    await saveUiState({ ...input.state, recentPrs: mergeRecents(existing.recentPrs, input.state.recentPrs) });
    return { ok: true, message: null };
  });
}
