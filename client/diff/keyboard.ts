import type { ReadingOrder, Thread, ViewedState } from "../../shared/types";
import type { Row } from "./rows";

/**
 * Pure navigation helpers for the diff stream's keyboard bindings (S2, web only). `ModuleTab`
 * owns all the actual state (`currentPath`, `cursorIndex`) and wiring (scrolling, expanding,
 * opening the composer); these functions only answer "where should the cursor/current-file end
 * up next", given the current row list and position. No React or react-native imports here —
 * unit-tested under tsconfig.server.json alongside the other pure diff modules.
 */

/** `1` moves forward (next/down), `-1` moves backward (previous/up). */
export type NavDirection = 1 | -1;

function isCodeRow(row: Row): boolean {
  return row.type === "line" || row.type === "pair";
}

function isUnresolvedRow(row: Row): boolean {
  if (row.type === "thread") return !row.thread.isResolved;
  if (row.type === "finding") return row.finding.status === "fail" && !row.finding.dismissed;
  return false;
}

/**
 * Index of the next/previous `fileHeader` row relative to the one at `currentPath`, or `null`
 * when there is none in that direction (no wraparound). `currentPath === null`, or a path that
 * isn't in `rows`, is treated as "before the first file" regardless of direction — so `j` from
 * nothing lands on the first file's header, and `k` from nothing finds nothing.
 */
export function nextFileIndex(rows: Row[], currentPath: string | null, direction: NavDirection): number | null {
  const headerIndices: number[] = [];
  let currentHeaderPosition = -1;
  rows.forEach((row, index) => {
    if (row.type !== "fileHeader") return;
    if (currentPath !== null && row.path === currentPath) currentHeaderPosition = headerIndices.length;
    headerIndices.push(index);
  });
  const target = currentHeaderPosition + direction;
  if (target < 0 || target >= headerIndices.length) return null;
  return headerIndices[target];
}

/**
 * Index of the next/previous `hunkHeader` row relative to `cursorIndex` (no wraparound).
 * `cursorIndex === null` is treated the same way as `nextFileIndex`'s `currentPath`: "before the
 * first row", so direction `1` finds the first hunk header and direction `-1` finds nothing.
 */
export function nextHunkIndex(rows: Row[], cursorIndex: number | null, direction: NavDirection): number | null {
  let i = (cursorIndex ?? -1) + direction;
  while (i >= 0 && i < rows.length) {
    if (rows[i].type === "hunkHeader") return i;
    i += direction;
  }
  return null;
}

/**
 * Index of the next unresolved item (an open thread row or a failing, non-dismissed finding
 * row) after `cursorIndex`, wrapping around to the start of `rows` if nothing matches after it.
 * Returns `null` when there is no unresolved row anywhere in `rows`.
 */
export function nextUnresolvedIndex(rows: Row[], cursorIndex: number | null): number | null {
  const start = cursorIndex ?? -1;
  for (let i = start + 1; i < rows.length; i += 1) {
    if (isUnresolvedRow(rows[i])) return i;
  }
  for (let i = 0; i <= start && i < rows.length; i += 1) {
    if (isUnresolvedRow(rows[i])) return i;
  }
  return null;
}

/**
 * Moves the line cursor to the next/previous "code" row (a `line` or `pair` row), skipping
 * everything else (headers, outline, threads, drafts, findings, the composer…). No wraparound;
 * `cursorIndex === null` starts just outside `rows` on the side `direction` moves away from, so
 * the first press from nothing always lands inside the array (when any code row exists).
 */
export function moveCursor(rows: Row[], cursorIndex: number | null, direction: NavDirection): number | null {
  let i = (cursorIndex ?? -1) + direction;
  while (i >= 0 && i < rows.length) {
    if (isCodeRow(rows[i])) return i;
    i += direction;
  }
  return null;
}

/** Minimal shape `nextUnviewedPath` needs from a file — deliberately narrower than
 * `AnalyzedFile` so tests can build plain objects without the rest of its fields. */
export interface UnviewedCandidate {
  path: string;
  viewed: ViewedState;
  order: Record<ReadingOrder, number>;
}

/**
 * Path of the next not-fully-viewed file (viewed !== "VIEWED" — DISMISSED counts too, since it
 * needs another look) after `afterPath` in `readingOrder`, wrapping around the whole list when
 * nothing qualifies after it. `afterPath === null`, or a path not present in `files`, starts the
 * search from the beginning. Returns `null` when every file is VIEWED.
 */
export function nextUnviewedPath(files: UnviewedCandidate[], afterPath: string | null, readingOrder: ReadingOrder): string | null {
  const sorted = files.slice().sort((a, b) => a.order[readingOrder] - b.order[readingOrder]);
  const startIndex = afterPath !== null ? sorted.findIndex((file) => file.path === afterPath) : -1;
  for (let i = startIndex + 1; i < sorted.length; i += 1) {
    if (sorted[i].viewed !== "VIEWED") return sorted[i].path;
  }
  for (let i = 0; i <= startIndex && i < sorted.length; i += 1) {
    if (sorted[i].viewed !== "VIEWED") return sorted[i].path;
  }
  return null;
}

/** Minimal shape `nextFileWithUnresolved` needs for a finding — narrower than `ValidatorFinding`
 * so callers can pass the plain finding data without the validator-id/title decoration. */
export interface UnresolvedFindingLike {
  status: "fail" | "uncertain";
  dismissed: boolean;
}

/**
 * Path of the next file (in `files`' given order) that has an unresolved review item — an open
 * thread, or a failing, non-dismissed finding — after `afterPath`, wrapping around the whole list
 * when nothing qualifies after it. Used by `n` to reach unresolved items in a *collapsed* file,
 * which `nextUnresolvedIndex` can't see (it only looks at rendered rows, and a collapsed file
 * renders only its header). `afterPath === null`, or a path not present in `files`, starts the
 * search from the beginning. Returns `null` when no file has an unresolved item.
 */
export function nextFileWithUnresolved(
  files: ReadonlyArray<{ path: string }>,
  threadsByPath: ReadonlyMap<string, Thread[]>,
  findingsByPath: ReadonlyMap<string, UnresolvedFindingLike[]>,
  afterPath: string | null,
): string | null {
  function hasUnresolved(path: string): boolean {
    const threads = threadsByPath.get(path);
    if (threads?.some((thread) => !thread.isResolved)) return true;
    const findings = findingsByPath.get(path);
    return findings?.some((finding) => finding.status === "fail" && !finding.dismissed) ?? false;
  }
  const startIndex = afterPath !== null ? files.findIndex((file) => file.path === afterPath) : -1;
  for (let i = startIndex + 1; i < files.length; i += 1) {
    if (hasUnresolved(files[i].path)) return files[i].path;
  }
  for (let i = 0; i <= startIndex && i < files.length; i += 1) {
    if (hasUnresolved(files[i].path)) return files[i].path;
  }
  return null;
}
