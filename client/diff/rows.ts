import type { AnalyzedFile, DiffLine, FileDiff, OutlineChange, OutlineEntry, Thread, ValidatorFinding, ViewedState } from "../../shared/types";
import { gapsForFile, mergeContextLines, type ContextGap, type ContextGapPosition } from "./context";
import { pairHunkLines } from "./pairing";

// Pure row model for the continuous diff stream (client/review/ModuleTab.tsx). No React or
// react-native imports here: this module is unit-tested under tsconfig.server.json alongside
// the server-side tests, so it must type-check with only Node types available.

export type Side = "LEFT" | "RIGHT";

/** A validator finding anchored to a file, carrying which validator raised it. */
export interface FileDiffFinding extends ValidatorFinding {
  validatorId: string;
  validatorTitle: string;
}

/** Minimal shape of a client/review/drafts.ts `DraftComment` — kept local so this module has no
 * dependency on the (React-hook-based) drafts store; `DraftComment` is structurally assignable. */
export interface DraftLike {
  id: number;
  path: string;
  line: number;
  side: Side;
  body: string;
}

export type ComposerMode = "new" | "editDraft" | "editComment";

/** The single module-wide composer target, if any (only one composer is open at a time). */
export type ComposerTarget =
  | { path: string; side: Side; line: number; mode: "new" }
  | { path: string; side: Side; line: number; mode: "editDraft"; draftId: number }
  | { path: string; side: Side; line: number; mode: "editComment"; commentId: string };

export type DiffQueryStatus = "idle" | "loading" | "error" | "success";

/** Discriminated row union covering the whole module stream. Every row carries `path` (""
 * for module-scoped rows with no single owning file) and a stable `key` for FlatList. */
export type Row =
  | { type: "fileHeader"; key: string; path: string; file: AnalyzedFile; expanded: boolean; viewed: ViewedState; outlineSummary: string }
  | { type: "fileMeta"; key: string; path: string; file: AnalyzedFile; viewed: ViewedState; sinceViewedHighlighted: boolean }
  | { type: "outline"; key: string; path: string; entries: OutlineEntry[]; expanded: boolean; summary: string }
  | { type: "structural"; key: string; path: string }
  | { type: "truncated"; key: string; path: string }
  | { type: "hunkHeader"; key: string; path: string; hunkIndex: number; context: string; newStart: number; newEnd: number }
  | { type: "collapsed"; key: string; path: string; hunkIndex: number; kind: "moved" | "whitespace"; count: number }
  | { type: "line"; key: string; path: string; hunkIndex: number; lineIndex: number }
  | { type: "pair"; key: string; path: string; hunkIndex: number; oldIndex: number | null; newIndex: number | null }
  | { type: "thread"; key: string; path: string; thread: Thread }
  | { type: "finding"; key: string; path: string; finding: FileDiffFinding }
  | { type: "draft"; key: string; path: string; draftId: number }
  | { type: "composer"; key: string; path: string; side: Side; line: number; mode: ComposerMode; draftId?: number; commentId?: string }
  | {
      type: "expandContext";
      key: string;
      path: string;
      hunkIndex: number;
      position: ContextGapPosition;
      oldStart: number;
      newStart: number;
      /** Lines still unfetched in this gap (what pressing "Expand" would reveal next). */
      count: number;
      /** Original full size of the gap, for the "Expand all" ≤ 500 rule (unaffected by partial fetches). */
      totalCount: number;
    }
  | { type: "loading"; key: string; path: string }
  | { type: "error"; key: string; path: string; message: string; tone: "danger" | "muted" }
  | { type: "empty"; key: string; path: string; reason: "no_files" | "since_last_review" };

/** Per-file input to `buildStreamRows`. Callers (ModuleTab) resolve all optimistic overrides
 * (viewed state, module moves) and query results before building rows — this module just lays
 * out the result. */
export interface StreamFileInput {
  file: AnalyzedFile;
  expanded: boolean;
  /** Resolved viewed state (after any optimistic override), used for display. */
  viewed: ViewedState;
  mode: "text" | "structure";
  outlineExpanded: boolean;
  /** Precomputed "N added · M signature …" summary (see `outlineSummary` below). */
  outlineSummary: string;
  /** Whether this file's "changed since you viewed" chip has been expanded to show the diff. */
  sinceViewedHighlighted: boolean;
  diffStatus: DiffQueryStatus;
  diff: FileDiff | null;
  diffErrorMessage?: string | null;
  /** Hunks the user expanded out of their collapsed (pure-move / whitespace-only) state. */
  expandedHunks: ReadonlySet<number>;
  /** The file's total line count (new/head side), once fetched via a 1-line `prr.file.lines`
   * probe; `null` when not yet known or not applicable (deleted files have no head content). */
  totalLines: number | null;
  /** Context lines fetched so far via `prr.file.lines`, keyed by new-side line number. */
  contextLines: ReadonlyMap<number, string>;
  threads: Thread[];
  findings: FileDiffFinding[];
  drafts: DraftLike[];
}

export interface BuildStreamRowsInput {
  files: StreamFileInput[];
  /** True for split (old | new) layout; false for inline. Resolved by the caller (split falls
   * back to inline on compact layouts — that's a layout concern, not this module's). */
  split: boolean;
  /** The single open composer, if any; `null` when no composer row should render anywhere. */
  composer: ComposerTarget | null;
  /** Why `files` is empty, when it is — used to pick the empty-state copy. */
  emptyReason?: "no_files" | "since_last_review";
}

/** Order entries are tallied in for `outlineSummary`; also doubles as the canonical change order
 * (`OutlineView.tsx` re-exports `outlineSummary` from here rather than keeping its own copy). */
export const CHANGE_ORDER: OutlineChange[] = ["added", "removed", "signature", "modified", "renamed", "moved"];

/** "2 added · 1 signature · 1 removed"; omits zero counts; "" when there are no entries. */
export function outlineSummary(entries: OutlineEntry[]): string {
  const counts: Record<OutlineChange, number> = { added: 0, removed: 0, modified: 0, signature: 0, renamed: 0, moved: 0 };
  entries.forEach((entry) => {
    counts[entry.change] += 1;
  });
  return CHANGE_ORDER.filter((change) => counts[change] > 0)
    .map((change) => `${counts[change]} ${change}`)
    .join(" · ");
}

/** The function/class context trailing a hunk header's second `@@`, e.g. "function foo() {"
 * out of "@@ -12,5 +34,8 @@ function foo() {"; "" when there's nothing after it. */
export function hunkContext(header: string): string {
  const marker = "@@";
  const first = header.indexOf(marker);
  if (first === -1) return "";
  const second = header.indexOf(marker, first + marker.length);
  if (second === -1) return "";
  return header.slice(second + marker.length).trim();
}

/** "<context> · L<newStart>–<newEnd>", or just the line range when there's no context. */
export function formatHunkHeader(context: string, newStart: number, newEnd: number): string {
  const range = `L${newStart}–${newEnd}`;
  return context ? `${context} · ${range}` : range;
}

function threadTarget(thread: Thread): { side: Side; number: number } | null {
  const number = thread.line ?? thread.originalLine;
  if (number === null) return null;
  return { side: thread.diffSide, number };
}

/** Appends thread / draft / finding / composer rows that target the given old/new line pair
 * (for split mode, these come from two different `DiffLine`s; for inline mode, callers pass the
 * same line for both — context lines carry both an old and a new line number on one object). */
function placeAttachments(
  rows: Row[],
  path: string,
  oldLine: DiffLine | null,
  newLine: DiffLine | null,
  threads: Thread[],
  drafts: DraftLike[],
  findings: FileDiffFinding[],
  composer: ComposerTarget | null,
): void {
  threads.forEach((thread) => {
    const target = threadTarget(thread);
    if (!target) return;
    const matches = target.side === "LEFT" ? oldLine !== null && oldLine.oldNo === target.number : newLine !== null && newLine.newNo === target.number;
    if (matches) rows.push({ type: "thread", key: `${path}:thread:${thread.id}`, path, thread });
  });
  drafts.forEach((draft) => {
    const matches = draft.side === "LEFT" ? oldLine !== null && oldLine.oldNo === draft.line : newLine !== null && newLine.newNo === draft.line;
    if (matches) rows.push({ type: "draft", key: `${path}:draft:${draft.id}`, path, draftId: draft.id });
  });
  findings.forEach((finding) => {
    if (finding.startLine !== null && newLine !== null && newLine.newNo === finding.startLine) {
      rows.push({ type: "finding", key: `${path}:finding:${finding.validatorId}:${finding.unitKey}`, path, finding });
    }
  });
  if (composer && composer.path === path) {
    const number = composer.side === "LEFT" ? oldLine?.oldNo ?? null : newLine?.newNo ?? null;
    if (number !== null && number === composer.line) {
      rows.push({
        type: "composer",
        key: `${path}:composer`,
        path,
        side: composer.side,
        line: composer.line,
        mode: composer.mode,
        draftId: composer.mode === "editDraft" ? composer.draftId : undefined,
        commentId: composer.mode === "editComment" ? composer.commentId : undefined,
      });
    }
  }
}

function buildFileRows(input: StreamFileInput, split: boolean, composer: ComposerTarget | null): Row[] {
  const rows: Row[] = [];
  const { file } = input;
  const path = file.path;
  const outline = file.outline ?? [];

  rows.push({
    type: "fileHeader",
    key: `file:${path}`,
    path,
    file,
    expanded: input.expanded,
    viewed: input.viewed,
    outlineSummary: input.outlineSummary,
  });

  if (!input.expanded) return rows;

  rows.push({ type: "fileMeta", key: `meta:${path}`, path, file, viewed: input.viewed, sinceViewedHighlighted: input.sinceViewedHighlighted });

  if (outline.length > 0) {
    rows.push({
      type: "outline",
      key: `outline:${path}`,
      path,
      entries: outline,
      expanded: input.outlineExpanded,
      summary: input.outlineSummary,
    });
  }

  if (input.mode === "structure" && file.structuralKind) {
    rows.push({ type: "structural", key: `structural:${path}`, path });
    return rows;
  }

  if (input.diffStatus === "loading" || input.diffStatus === "idle") {
    rows.push({ type: "loading", key: `loading:${path}`, path });
    return rows;
  }
  if (input.diffStatus === "error" || !input.diff) {
    rows.push({ type: "error", key: `error:${path}`, path, message: input.diffErrorMessage ?? "Failed to load diff.", tone: "danger" });
    return rows;
  }

  const diff = input.diff;
  if (diff.binary) {
    rows.push({ type: "error", key: `error:${path}`, path, message: "Binary file not shown.", tone: "muted" });
    return rows;
  }

  if (diff.truncated) {
    rows.push({ type: "truncated", key: `truncated:${path}`, path });
  }

  // Real context expansion (S2): `gaps` is the full extent of every above/between/below gap in
  // this file (only "below" needs `input.totalLines`, and is omitted while that's unknown);
  // `merged` is however much of each gap has actually been fetched so far, attached to the hunk
  // it's adjacent to. Rows below interleave: (above only) a placeholder for whatever's still
  // unfetched, nearest the top of the file → fetched context lines, nearest the hunk → the hunk
  // itself → (last hunk only) fetched "below" context lines → a placeholder for whatever's left.
  const gaps = gapsForFile(diff.hunks, input.totalLines);
  const gapByKey = new Map<string, ContextGap>(gaps.map((gap) => [`${gap.position}:${gap.hunkIndex}`, gap]));
  const merged = mergeContextLines(diff.hunks, input.contextLines);

  function pushExpandRow(position: ContextGapPosition, hunkIndex: number, oldStart: number, newStart: number, count: number, totalCount: number): void {
    rows.push({ type: "expandContext", key: `${path}:expand:${position}:${hunkIndex}`, path, hunkIndex, position, oldStart, newStart, count, totalCount });
  }

  function pushContextRun(hunkIndex: number, lines: DiffLine[], baseIndex: number): void {
    lines.forEach((line, i) => {
      const index = baseIndex + i;
      if (split) {
        rows.push({ type: "pair", key: `${path}:pair:${hunkIndex}:${index}:${index}`, path, hunkIndex, oldIndex: index, newIndex: index });
      } else {
        rows.push({ type: "line", key: `${path}:line:${hunkIndex}:${index}`, path, hunkIndex, lineIndex: index });
      }
      placeAttachments(rows, path, line, line, input.threads, input.drafts, input.findings, composer);
    });
  }

  diff.hunks.forEach((hunk, hunkIndex) => {
    const isFirst = hunkIndex === 0;
    const isLast = hunkIndex === diff.hunks.length - 1;
    const { prepend, append } = merged[hunkIndex];

    const gapBefore = gapByKey.get(`${isFirst ? "above" : "between"}:${hunkIndex}`);
    const remainingBefore = gapBefore ? gapBefore.count - prepend.length : 0;

    if (isFirst && gapBefore && remainingBefore > 0) {
      pushExpandRow("above", hunkIndex, gapBefore.oldStart, gapBefore.newStart, remainingBefore, gapBefore.count);
    }
    pushContextRun(hunkIndex, prepend, 0);
    if (!isFirst && gapBefore && remainingBefore > 0) {
      pushExpandRow("between", hunkIndex, gapBefore.oldStart + prepend.length, gapBefore.newStart + prepend.length, remainingBefore, gapBefore.count);
    }

    const collapsible = hunk.pureMove || hunk.whitespaceOnly;
    if (collapsible && !input.expandedHunks.has(hunkIndex)) {
      rows.push({
        type: "collapsed",
        key: `${path}:collapsed:${hunkIndex}`,
        path,
        hunkIndex,
        kind: hunk.pureMove ? "moved" : "whitespace",
        count: hunk.lines.length,
      });
    } else {
      rows.push({
        type: "hunkHeader",
        key: `${path}:hunkHeader:${hunkIndex}`,
        path,
        hunkIndex,
        context: hunkContext(hunk.header),
        newStart: hunk.newStart,
        newEnd: hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : hunk.newStart,
      });

      if (split) {
        pairHunkLines(hunk.lines).forEach(({ oldIndex, newIndex }) => {
          const adjOld = oldIndex !== null ? oldIndex + prepend.length : null;
          const adjNew = newIndex !== null ? newIndex + prepend.length : null;
          rows.push({ type: "pair", key: `${path}:pair:${hunkIndex}:${adjOld ?? "x"}:${adjNew ?? "x"}`, path, hunkIndex, oldIndex: adjOld, newIndex: adjNew });
          const oldLine = oldIndex !== null ? hunk.lines[oldIndex] : null;
          const newLine = newIndex !== null ? hunk.lines[newIndex] : null;
          placeAttachments(rows, path, oldLine, newLine, input.threads, input.drafts, input.findings, composer);
        });
      } else {
        hunk.lines.forEach((line, lineIndex) => {
          const index = prepend.length + lineIndex;
          rows.push({ type: "line", key: `${path}:line:${hunkIndex}:${index}`, path, hunkIndex, lineIndex: index });
          placeAttachments(rows, path, line, line, input.threads, input.drafts, input.findings, composer);
        });
      }
    }

    if (isLast) {
      pushContextRun(hunkIndex, append, prepend.length + hunk.lines.length);
      const gapAfter = gapByKey.get(`below:${hunkIndex}`);
      const remainingAfter = gapAfter ? gapAfter.count - append.length : 0;
      if (gapAfter && remainingAfter > 0) {
        pushExpandRow("below", hunkIndex, gapAfter.oldStart + append.length, gapAfter.newStart + append.length, remainingAfter, gapAfter.count);
      }
    }
  });

  return rows;
}

/** Composes the full row list for a module's diff stream: one `fileHeader` per visible file,
 * followed (when expanded) by its meta chips, outline, and either its structural view or its
 * interleaved diff/thread/draft/finding/composer rows. */
export function buildStreamRows(input: BuildStreamRowsInput): Row[] {
  if (input.files.length === 0) {
    return [{ type: "empty", key: "empty", path: "", reason: input.emptyReason ?? "no_files" }];
  }
  const rows: Row[] = [];
  input.files.forEach((file) => {
    rows.push(...buildFileRows(file, input.split, input.composer));
  });
  return rows;
}

/** Indices of every `fileHeader` row, for `FlatList`'s `stickyHeaderIndices`. */
export function stickyIndices(rows: Row[]): number[] {
  const indices: number[] = [];
  rows.forEach((row, index) => {
    if (row.type === "fileHeader") indices.push(index);
  });
  return indices;
}

export interface FileSegment {
  path: string;
  file: AnalyzedFile;
  /** Index of this file's `fileHeader` row within `rows`. */
  start: number;
  /** Number of rows belonging to this file (its header plus everything until the next header). */
  count: number;
}

/** Per-file row ranges, for the minimap: one segment per file sized by its visible row count. */
export function fileSegments(rows: Row[]): FileSegment[] {
  const segments: FileSegment[] = [];
  rows.forEach((row, index) => {
    if (row.type === "fileHeader") {
      segments.push({ path: row.path, file: row.file, start: index, count: 1 });
      return;
    }
    const last = segments[segments.length - 1];
    if (last) last.count += 1;
  });
  return segments;
}
