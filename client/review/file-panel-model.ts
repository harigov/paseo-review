import type { AnalyzedFile } from "../../shared/types";

// Pure helpers for the file panel (client/review/FilePanel.tsx). No React or react-native
// imports here: this module is unit-tested under tsconfig.server.json alongside the server-side
// tests, so it must type-check with only Node types available (see client/diff/rows.ts).

export type StatusLetter = "A" | "M" | "D" | "R" | "C";

const STATUS_LETTERS: Record<AnalyzedFile["status"], StatusLetter> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

/** One letter per `AnalyzedFile.status`, for the row's status badge. */
export function statusLetter(status: AnalyzedFile["status"]): StatusLetter {
  return STATUS_LETTERS[status];
}

/** Semantic tone for the status badge. Kept as a tone name (not a colour) so this module stays
 * React/RN-free — `FilePanel.tsx` maps it to a theme colour (statusSuccess / statusDanger /
 * accent / foregroundMuted). */
export type StatusTone = "success" | "danger" | "accent" | "muted";

const STATUS_TONES: Record<AnalyzedFile["status"], StatusTone> = {
  added: "success",
  deleted: "danger",
  renamed: "accent",
  copied: "accent",
  modified: "muted",
};

export function statusTone(status: AnalyzedFile["status"]): StatusTone {
  return STATUS_TONES[status];
}

/** Splits a repo-relative path into its parent directory ("" at the repo root) and basename. */
export function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { dir: "", base: path } : { dir: path.slice(0, slash), base: path.slice(slash + 1) };
}

/** Keeps the tail of `text`, dropping characters from the head and prefixing "…" once it's
 * longer than `maxChars` — the parent directory should stay recognisable by where it ends (the
 * file's immediate folder), not where it starts. No-op at or under the limit. */
export function truncateHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `…${text.slice(text.length - (maxChars - 1))}`;
}

/** Case-insensitive substring match on `path`, same as the stream's own filter. An empty/blank
 * query returns every item (a fresh copy, so callers can rely on a stable array identity rule). */
export function filterFilePanelItems<T extends { path: string }>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter((item) => item.path.toLowerCase().includes(q));
}

/** Index of the item whose `path` matches, or -1 (also for a `null` path, so callers can pass
 * `currentPath` straight through without a separate null check). */
export function findFilePanelIndex<T extends { path: string }>(items: readonly T[], path: string | null): number {
  if (path === null) return -1;
  return items.findIndex((item) => item.path === path);
}
