import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handle } from "../core/handle";
import { dataDir } from "../core/paths";
import { uiStateGetRpc, uiStateSetRpc } from "../../shared/rpc";
import { DEFAULT_UI_STATE, UiStateSchema, type UiState } from "../../shared/ui-state";

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
    await saveUiState(input.state);
    return { ok: true, message: null };
  });
}
