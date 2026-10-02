import { useSyncExternalStore } from "react";
import type { DetailLevel } from "../../shared/types";

// Session store for the reviewer's chosen review depths, per PR: one level per module and
// optional per-file overrides. Lives outside React (like drafts.ts / app/ui-state.ts) so it
// survives the surface remounting each time "PR Review" is opened; not persisted to disk.
// Effective levels are resolved with `resolveModuleLevel` / `resolveFileLevel` (shared/levels.ts).

export interface PrDetailLevels {
  /** moduleId → level the user picked (absent = recommended or default). */
  modules: Readonly<Record<string, DetailLevel>>;
  /** path → per-file override (absent = the module's level). */
  files: Readonly<Record<string, DetailLevel>>;
}

const EMPTY: PrDetailLevels = { modules: {}, files: {} };

const store = new Map<string, PrDetailLevels>();
const listeners = new Map<string, Set<() => void>>();

function keyOf(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

function emit(key: string): void {
  listeners.get(key)?.forEach((listener) => listener());
}

function update(repo: string, number: number, fn: (current: PrDetailLevels) => PrDetailLevels): void {
  const key = keyOf(repo, number);
  const current = store.get(key) ?? EMPTY;
  const next = fn(current);
  if (next === current) return;
  store.set(key, next);
  emit(key);
}

function without<V>(record: Readonly<Record<string, V>>, keys: readonly string[]): Record<string, V> {
  const next = { ...record };
  keys.forEach((key) => delete next[key]);
  return next;
}

/** Sets (or, with `null`, clears back to recommended/default) a module's level. Choosing a
 * module level also drops per-file overrides for `pathsInModule`, so the choice applies to
 * every file — the usual intent when switching a whole module's depth. */
export function setModuleLevel(repo: string, number: number, moduleId: string, level: DetailLevel | null, pathsInModule: readonly string[] = []): void {
  update(repo, number, (current) => ({
    modules: level === null ? without(current.modules, [moduleId]) : { ...current.modules, [moduleId]: level },
    files: pathsInModule.length > 0 ? without(current.files, pathsInModule) : current.files,
  }));
}

/** Sets (or, with `null`, clears back to the module's level) one file's level. */
export function setFileLevel(repo: string, number: number, path: string, level: DetailLevel | null): void {
  update(repo, number, (current) => ({
    modules: current.modules,
    files: level === null ? without(current.files, [path]) : { ...current.files, [path]: level },
  }));
}

/** The user's chosen levels for one PR; re-renders the caller when they change. */
export function useDetailLevels(repo: string, number: number): PrDetailLevels {
  const key = keyOf(repo, number);
  return useSyncExternalStore(
    (listener) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
    () => store.get(key) ?? EMPTY,
  );
}

// ---------- file panel visibility (session-wide, all PRs) ----------

let filePanelOpen = true;
const panelListeners = new Set<() => void>();

export function setFilePanelOpen(open: boolean): void {
  if (filePanelOpen === open) return;
  filePanelOpen = open;
  panelListeners.forEach((listener) => listener());
}

/** Whether the module tab's file panel is shown on wide layouts (remembered for the session). */
export function useFilePanelOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      panelListeners.add(listener);
      return () => {
        panelListeners.delete(listener);
      };
    },
    () => filePanelOpen,
  );
}
