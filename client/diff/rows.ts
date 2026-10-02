import type { AnalyzedFile, DetailLevel, DiffLine, FileDiff, Hunk, OutlineChange, OutlineEntry, Thread, ValidatorFinding, ViewedState } from "../../shared/types";
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
 * for module-scoped rows with no single owning file) and a stable `key` for FlatList. Every
 * row belonging to a file also carries `rail`: the parity of that file's position among the
 * visible files, alternating so `DiffRows` can draw a 3px left border marking file boundaries
 * (see `buildStreamRows`). `empty` is the only row with no owning file, so it has no `rail`. */
export type Row =
  | { type: "fileHeader"; key: string; path: string; file: AnalyzedFile; level: DetailLevel; viewed: ViewedState; outlineSummary: string; rail: 0 | 1 }
  | { type: "fileMeta"; key: string; path: string; file: AnalyzedFile; viewed: ViewedState; sinceViewedHighlighted: boolean; level: DetailLevel; rail: 0 | 1 }
  | { type: "outline"; key: string; path: string; entries: OutlineEntry[]; expanded: boolean; summary: string; rail: 0 | 1 }
  // Declarations level: one row per changed declaration; pressing it toggles an inline
  // drill-down (the hunks overlapping its range) rendered directly below it.
  | { type: "decl"; key: string; path: string; entry: OutlineEntry; index: number; expanded: boolean; rail: 0 | 1 }
  // Declarations level, no outline available for this file.
  | { type: "noOutline"; key: string; path: string; changedLines: number; rail: 0 | 1 }
  // After every file whose level isn't "files": "End of <path> · +a −d" plus "Viewed & next".
  | { type: "fileEnd"; key: string; path: string; file: AnalyzedFile; rail: 0 | 1 }
  | { type: "structural"; key: string; path: string; rail: 0 | 1 }
  | { type: "truncated"; key: string; path: string; rail: 0 | 1 }
  | { type: "hunkHeader"; key: string; path: string; hunkIndex: number; context: string; newStart: number; newEnd: number; rail: 0 | 1 }
  | { type: "collapsed"; key: string; path: string; hunkIndex: number; kind: "moved" | "whitespace"; count: number; rail: 0 | 1 }
  | { type: "line"; key: string; path: string; hunkIndex: number; lineIndex: number; rail: 0 | 1 }
  | { type: "pair"; key: string; path: string; hunkIndex: number; oldIndex: number | null; newIndex: number | null; rail: 0 | 1 }
  | { type: "thread"; key: string; path: string; thread: Thread; rail: 0 | 1 }
  | { type: "finding"; key: string; path: string; finding: FileDiffFinding; rail: 0 | 1 }
  | { type: "draft"; key: string; path: string; draftId: number; rail: 0 | 1 }
  | { type: "composer"; key: string; path: string; side: Side; line: number; mode: ComposerMode; draftId?: number; commentId?: string; rail: 0 | 1 }
  | {
      type: "expandContext";
      key: string;
      path: string;
      hunkIndex: number;
      position: ContextGapPosition;
      oldStart: number;
      newStart: number;
      /** Lines still unfetched in this gap (what pressing "Expand" would reveal next); the gap's
       * full (untouched) size when `unsafe` is true, since an unsafe gap offers no expand action. */
      count: number;
      /** Original full size of the gap, for the "Expand all" ≤ 500 rule (unaffected by partial fetches). */
      totalCount: number;
      /** True when the gap's old/new sizes disagree (a hunk was dropped from a truncated diff):
       * rendered as a muted, non-expandable notice instead of an "Expand" control. */
      unsafe: boolean;
      rail: 0 | 1;
    }
  | { type: "loading"; key: string; path: string; rail: 0 | 1 }
  | { type: "error"; key: string; path: string; message: string; tone: "danger" | "muted"; rail: 0 | 1 }
  | { type: "empty"; key: string; path: string; reason: "no_files" | "since_last_review" };

/** Per-file input to `buildStreamRows`. Callers (ModuleTab) resolve all optimistic overrides
 * (viewed state, module moves, review-depth levels) and query results before building rows —
 * this module just lays out the result. */
export interface StreamFileInput {
  file: AnalyzedFile;
  /** This file's effective review depth: `levels.files[path]` ?? `defaultFileLevel(...)`. */
  level: DetailLevel;
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
  /** Indices into `file.outline` whose inline drill-down is open (declarations level only). */
  expandedDecls: ReadonlySet<number>;
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

/** Whether a file has something other than raw code to show at Declarations level: an outline,
 * or a structural (key-table) view. Shared by `defaultFileLevel` and `openFileLevel`. */
function hasDeclarationsView(file: Pick<AnalyzedFile, "outline" | "structuralKind">): boolean {
  return (file.outline?.length ?? 0) > 0 || file.structuralKind !== null;
}

/**
 * The file level to use when no per-file override is set, given the module's effective level
 * and the file's resolved viewed state: VIEWED files collapse to Files; at Code level, a file
 * over 400 effective lines drops to Declarations (if it has one) or Files, rather than opening
 * the full diff; otherwise the file just follows the module's level. Preserves today's
 * "viewed / huge files start collapsed" behaviour, with huge files landing on Declarations
 * instead of fully collapsed when that's useful.
 */
export function defaultFileLevel(file: Pick<AnalyzedFile, "effectiveLines" | "outline" | "structuralKind">, moduleLevel: DetailLevel, viewed: ViewedState): DetailLevel {
  if (viewed === "VIEWED") return "files";
  if (moduleLevel === "code" && file.effectiveLines > 400) {
    return hasDeclarationsView(file) ? "declarations" : "files";
  }
  return moduleLevel;
}

/**
 * The level a collapsed file should open to — pressing its header, or `e` on the current file:
 * the module's level when it isn't Files; otherwise Declarations (if the file has one) or Code.
 */
export function openFileLevel(file: Pick<AnalyzedFile, "outline" | "structuralKind">, moduleLevel: DetailLevel): DetailLevel {
  if (moduleLevel !== "files") return moduleLevel;
  return hasDeclarationsView(file) ? "declarations" : "code";
}

/** Last old/new line number a hunk covers (inclusive); mirrors `context.ts`'s own `coveredEnd`,
 * duplicated locally since that module isn't exported for this. */
function hunkCoveredEnd(start: number, lines: number): number {
  return lines === 0 ? start : start + lines - 1;
}

function hunksOverlapping(hunks: Hunk[], start: number, end: number, side: "new" | "old"): number[] {
  const indices: number[] = [];
  hunks.forEach((hunk, index) => {
    const hStart = side === "new" ? hunk.newStart : hunk.oldStart;
    const hLines = side === "new" ? hunk.newLines : hunk.oldLines;
    const hEnd = hunkCoveredEnd(hStart, hLines);
    if (hStart <= end && hEnd >= start) indices.push(index);
  });
  return indices;
}

/** Indices (in hunk order) of every hunk overlapping a declaration's range: the new-side
 * `newStart..newEnd` when present (added/modified/signature-changed declarations), else the
 * old-side `oldStart..oldEnd` (removed declarations). `[]` when the entry has neither range or
 * nothing overlaps. Used by the Declarations-level drill-down to pick which whole hunks to show
 * under a pressed `decl` row. */
export function overlappingHunkIndices(hunks: Hunk[], entry: Pick<OutlineEntry, "newStart" | "newEnd" | "oldStart" | "oldEnd">): number[] {
  if (entry.newStart !== null && entry.newEnd !== null) return hunksOverlapping(hunks, entry.newStart, entry.newEnd, "new");
  if (entry.oldStart !== null && entry.oldEnd !== null) return hunksOverlapping(hunks, entry.oldStart, entry.oldEnd, "old");
  return [];
}

function threadTarget(thread: Thread): { side: Side; number: number } | null {
  const number = thread.line ?? thread.originalLine;
  if (number === null) return null;
  return { side: thread.diffSide, number };
}

/** Appends thread / draft / finding / composer rows that target the given old/new line pair
 * (for split mode, these come from two different `DiffLine`s; for inline mode, callers pass the
 * same line for both — context lines carry both an old and a new line number on one object).
 * `keyPrefix` disambiguates rows for the same line rendered under more than one Declarations-
 * level drill-down (two declarations sharing a hunk) — see `buildFileRows`. */
function placeAttachments(
  rows: Row[],
  path: string,
  oldLine: DiffLine | null,
  newLine: DiffLine | null,
  threads: Thread[],
  drafts: DraftLike[],
  findings: FileDiffFinding[],
  composer: ComposerTarget | null,
  rail: 0 | 1,
  keyPrefix = "",
): void {
  threads.forEach((thread) => {
    const target = threadTarget(thread);
    if (!target) return;
    const matches = target.side === "LEFT" ? oldLine !== null && oldLine.oldNo === target.number : newLine !== null && newLine.newNo === target.number;
    if (matches) rows.push({ type: "thread", key: `${keyPrefix}${path}:thread:${thread.id}`, path, thread, rail });
  });
  drafts.forEach((draft) => {
    const matches = draft.side === "LEFT" ? oldLine !== null && oldLine.oldNo === draft.line : newLine !== null && newLine.newNo === draft.line;
    if (matches) rows.push({ type: "draft", key: `${keyPrefix}${path}:draft:${draft.id}`, path, draftId: draft.id, rail });
  });
  findings.forEach((finding) => {
    if (finding.startLine !== null && newLine !== null && newLine.newNo === finding.startLine) {
      rows.push({ type: "finding", key: `${keyPrefix}${path}:finding:${finding.validatorId}:${finding.unitKey}`, path, finding, rail });
    }
  });
  if (composer && composer.path === path) {
    const number = composer.side === "LEFT" ? oldLine?.oldNo ?? null : newLine?.newNo ?? null;
    if (number !== null && number === composer.line) {
      rows.push({
        type: "composer",
        key: `${keyPrefix}${path}:composer`,
        path,
        side: composer.side,
        line: composer.line,
        mode: composer.mode,
        draftId: composer.mode === "editDraft" ? composer.draftId : undefined,
        commentId: composer.mode === "editComment" ? composer.commentId : undefined,
        rail,
      });
    }
  }
}

function buildFileRows(input: StreamFileInput, split: boolean, composer: ComposerTarget | null, rail: 0 | 1): Row[] {
  const rows: Row[] = [];
  const { file, level } = input;
  const path = file.path;
  const outline = file.outline ?? [];

  rows.push({
    type: "fileHeader",
    key: `file:${path}`,
    path,
    file,
    level,
    viewed: input.viewed,
    outlineSummary: input.outlineSummary,
    rail,
  });

  if (level === "files") return rows;

  rows.push({ type: "fileMeta", key: `meta:${path}`, path, file, viewed: input.viewed, sinceViewedHighlighted: input.sinceViewedHighlighted, level, rail });

  /** Declarations level: structural files show their key table (their "declarations"); binary
   * files get a muted notice; files with an outline get one `decl` row per entry, each able to
   * drill down into the hunks it overlaps; files with neither get the `noOutline` row. */
  function pushDeclarationsBody(): void {
    if (file.structuralKind) {
      rows.push({ type: "structural", key: `structural:${path}`, path, rail });
      return;
    }
    if (file.binary) {
      rows.push({ type: "error", key: `error:${path}`, path, message: "Binary file not shown.", tone: "muted", rail });
      return;
    }
    if (outline.length === 0) {
      rows.push({ type: "noOutline", key: `noOutline:${path}`, path, changedLines: file.effectiveLines, rail });
      return;
    }
    outline.forEach((entry, index) => {
      const declExpanded = input.expandedDecls.has(index);
      rows.push({ type: "decl", key: `decl:${path}:${index}`, path, entry, index, expanded: declExpanded, rail });
      if (!declExpanded) return;

      if (input.diffStatus === "loading" || input.diffStatus === "idle") {
        rows.push({ type: "loading", key: `decl:${path}:${index}:loading`, path, rail });
        return;
      }
      if (input.diffStatus === "error" || !input.diff) {
        rows.push({ type: "error", key: `decl:${path}:${index}:error`, path, message: input.diffErrorMessage ?? "Failed to load diff.", tone: "danger", rail });
        return;
      }
      const diff = input.diff;
      const hunkIndices = overlappingHunkIndices(diff.hunks, entry);
      if (hunkIndices.length === 0) {
        rows.push({ type: "error", key: `decl:${path}:${index}:none`, path, message: "No changed lines in this range.", tone: "muted", rail });
        return;
      }
      // Addresses lines the same way the Code-level hunk loop below does (offset by however much
      // fetched context is already spliced onto this hunk), so `ModuleTab`'s `getHunk`/`getTokens`
      // (keyed on the effective, context-merged hunk) resolve correctly for drill-down rows too.
      const merged = mergeContextLines(diff.hunks, input.contextLines);
      const keyPrefix = `decl:${path}:${index}:`;
      hunkIndices.forEach((hunkIndex) => {
        const hunk = diff.hunks[hunkIndex];
        const baseOffset = merged[hunkIndex].prepend.length;
        rows.push({
          type: "hunkHeader",
          key: `${keyPrefix}hunkHeader:${hunkIndex}`,
          path,
          hunkIndex,
          context: hunkContext(hunk.header),
          newStart: hunk.newStart,
          newEnd: hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : hunk.newStart,
          rail,
        });
        if (split) {
          pairHunkLines(hunk.lines).forEach(({ oldIndex, newIndex }) => {
            const adjOld = oldIndex !== null ? oldIndex + baseOffset : null;
            const adjNew = newIndex !== null ? newIndex + baseOffset : null;
            rows.push({ type: "pair", key: `${keyPrefix}pair:${hunkIndex}:${adjOld ?? "x"}:${adjNew ?? "x"}`, path, hunkIndex, oldIndex: adjOld, newIndex: adjNew, rail });
            const oldLine = oldIndex !== null ? hunk.lines[oldIndex] : null;
            const newLine = newIndex !== null ? hunk.lines[newIndex] : null;
            placeAttachments(rows, path, oldLine, newLine, input.threads, input.drafts, input.findings, composer, rail, keyPrefix);
          });
        } else {
          hunk.lines.forEach((line, lineIndex) => {
            const index2 = baseOffset + lineIndex;
            rows.push({ type: "line", key: `${keyPrefix}line:${hunkIndex}:${index2}`, path, hunkIndex, lineIndex: index2, rail });
            placeAttachments(rows, path, line, line, input.threads, input.drafts, input.findings, composer, rail, keyPrefix);
          });
        }
      });
    });
  }

  /** Code level: today's full diff, unchanged except that the outline list (when present)
   * starts collapsed — the header already carries its summary — and every row carries `rail`. */
  function pushCodeBody(): void {
    if (outline.length > 0) {
      rows.push({ type: "outline", key: `outline:${path}`, path, entries: outline, expanded: input.outlineExpanded, summary: input.outlineSummary, rail });
    }

    if (input.mode === "structure" && file.structuralKind) {
      rows.push({ type: "structural", key: `structural:${path}`, path, rail });
      return;
    }

    if (input.diffStatus === "loading" || input.diffStatus === "idle") {
      rows.push({ type: "loading", key: `loading:${path}`, path, rail });
      return;
    }
    if (input.diffStatus === "error" || !input.diff) {
      rows.push({ type: "error", key: `error:${path}`, path, message: input.diffErrorMessage ?? "Failed to load diff.", tone: "danger", rail });
      return;
    }

    const diff = input.diff;
    if (diff.binary) {
      rows.push({ type: "error", key: `error:${path}`, path, message: "Binary file not shown.", tone: "muted", rail });
      return;
    }

    if (diff.truncated) {
      rows.push({ type: "truncated", key: `truncated:${path}`, path, rail });
    }

    // Real context expansion (S2): `gaps` is the full extent of every above/between/below gap in
    // this file (only "below" needs `input.totalLines`, and is omitted while that's unknown);
    // `merged` is however much of each gap has actually been fetched so far, attached to the hunk
    // it's adjacent to. Rows below interleave: (above only) a placeholder for whatever's still
    // unfetched, nearest the top of the file → fetched context lines, nearest the hunk → the hunk
    // itself → (last hunk only) fetched "below" context lines → a placeholder for whatever's left.
    const gaps = gapsForFile(diff.hunks, input.totalLines, diff.truncated);
    const gapByKey = new Map<string, ContextGap>(gaps.map((gap) => [`${gap.position}:${gap.hunkIndex}`, gap]));
    const merged = mergeContextLines(diff.hunks, input.contextLines);

    function pushExpandRow(position: ContextGapPosition, hunkIndex: number, oldStart: number, newStart: number, count: number, totalCount: number): void {
      rows.push({ type: "expandContext", key: `${path}:expand:${position}:${hunkIndex}`, path, hunkIndex, position, oldStart, newStart, count, totalCount, unsafe: false, rail });
    }

    /** An "unsafe" gap (see `ContextGap.unsafe`) offers no expand action — just a muted notice —
     * so it's rendered with the gap's full, untouched size regardless of anything fetched so far
     * (nothing can have been fetched for it: the UI never offers a way to request it). */
    function pushUnsafeGapRow(position: ContextGapPosition, hunkIndex: number, gap: ContextGap): void {
      rows.push({
        type: "expandContext",
        key: `${path}:expand:${position}:${hunkIndex}`,
        path,
        hunkIndex,
        position,
        oldStart: gap.oldStart,
        newStart: gap.newStart,
        count: gap.count,
        totalCount: gap.count,
        unsafe: true,
        rail,
      });
    }

    function pushContextRun(hunkIndex: number, lines: DiffLine[], baseIndex: number): void {
      lines.forEach((line, i) => {
        const index = baseIndex + i;
        if (split) {
          rows.push({ type: "pair", key: `${path}:pair:${hunkIndex}:${index}:${index}`, path, hunkIndex, oldIndex: index, newIndex: index, rail });
        } else {
          rows.push({ type: "line", key: `${path}:line:${hunkIndex}:${index}`, path, hunkIndex, lineIndex: index, rail });
        }
        placeAttachments(rows, path, line, line, input.threads, input.drafts, input.findings, composer, rail);
      });
    }

    diff.hunks.forEach((hunk, hunkIndex) => {
      const isFirst = hunkIndex === 0;
      const isLast = hunkIndex === diff.hunks.length - 1;
      const { prepend, append } = merged[hunkIndex];
      const collapsible = hunk.pureMove || hunk.whitespaceOnly;
      const hunkExpanded = input.expandedHunks.has(hunkIndex);
      // Context lines (and their expand/unsafe placeholders) adjacent to a still-collapsed hunk
      // aren't rendered at all: `ModuleTab`'s per-hunk highlighting/intraline caches skip tokenizing
      // a collapsed hunk entirely (there's nothing worth paying for until the user expands it), so
      // showing fetched context lines here would render as plain, unhighlighted text. They reappear
      // once the hunk itself is expanded, exactly like the hunk's own lines do.
      const showContext = !collapsible || hunkExpanded;

      const gapBefore = gapByKey.get(`${isFirst ? "above" : "between"}:${hunkIndex}`);
      const remainingBefore = gapBefore ? gapBefore.count - prepend.length : 0;

      if (isFirst && gapBefore && showContext) {
        if (gapBefore.unsafe) pushUnsafeGapRow("above", hunkIndex, gapBefore);
        else if (remainingBefore > 0) pushExpandRow("above", hunkIndex, gapBefore.oldStart, gapBefore.newStart, remainingBefore, gapBefore.count);
      }
      if (showContext) pushContextRun(hunkIndex, prepend, 0);
      if (!isFirst && gapBefore && showContext) {
        if (gapBefore.unsafe) pushUnsafeGapRow("between", hunkIndex, gapBefore);
        else if (remainingBefore > 0)
          pushExpandRow("between", hunkIndex, gapBefore.oldStart + prepend.length, gapBefore.newStart + prepend.length, remainingBefore, gapBefore.count);
      }

      if (collapsible && !hunkExpanded) {
        rows.push({
          type: "collapsed",
          key: `${path}:collapsed:${hunkIndex}`,
          path,
          hunkIndex,
          kind: hunk.pureMove ? "moved" : "whitespace",
          count: hunk.lines.length,
          rail,
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
          rail,
        });

        if (split) {
          pairHunkLines(hunk.lines).forEach(({ oldIndex, newIndex }) => {
            const adjOld = oldIndex !== null ? oldIndex + prepend.length : null;
            const adjNew = newIndex !== null ? newIndex + prepend.length : null;
            rows.push({ type: "pair", key: `${path}:pair:${hunkIndex}:${adjOld ?? "x"}:${adjNew ?? "x"}`, path, hunkIndex, oldIndex: adjOld, newIndex: adjNew, rail });
            const oldLine = oldIndex !== null ? hunk.lines[oldIndex] : null;
            const newLine = newIndex !== null ? hunk.lines[newIndex] : null;
            placeAttachments(rows, path, oldLine, newLine, input.threads, input.drafts, input.findings, composer, rail);
          });
        } else {
          hunk.lines.forEach((line, lineIndex) => {
            const index = prepend.length + lineIndex;
            rows.push({ type: "line", key: `${path}:line:${hunkIndex}:${index}`, path, hunkIndex, lineIndex: index, rail });
            placeAttachments(rows, path, line, line, input.threads, input.drafts, input.findings, composer, rail);
          });
        }
      }

      if (isLast && showContext) {
        pushContextRun(hunkIndex, append, prepend.length + hunk.lines.length);
        const gapAfter = gapByKey.get(`below:${hunkIndex}`);
        const remainingAfter = gapAfter ? gapAfter.count - append.length : 0;
        if (gapAfter) {
          if (gapAfter.unsafe) pushUnsafeGapRow("below", hunkIndex, gapAfter);
          else if (remainingAfter > 0) pushExpandRow("below", hunkIndex, gapAfter.oldStart + append.length, gapAfter.newStart + append.length, remainingAfter, gapAfter.count);
        }
      }
    });
  }

  if (level === "declarations") pushDeclarationsBody();
  else pushCodeBody();

  rows.push({ type: "fileEnd", key: `fileEnd:${path}`, path, file, rail });
  return rows;
}

/** Composes the full row list for a module's diff stream: one `fileHeader` per visible file,
 * followed (when its level isn't "files") by its meta chips, declarations/structural/code body,
 * and a `fileEnd` row. `rail` alternates by the file's position among the visible files, so
 * `DiffRows` can draw a boundary between adjacent files regardless of either one's level. */
export function buildStreamRows(input: BuildStreamRowsInput): Row[] {
  if (input.files.length === 0) {
    return [{ type: "empty", key: "empty", path: "", reason: input.emptyReason ?? "no_files" }];
  }
  const rows: Row[] = [];
  input.files.forEach((file, fileIndex) => {
    const rail: 0 | 1 = fileIndex % 2 === 0 ? 0 : 1;
    rows.push(...buildFileRows(file, input.split, input.composer, rail));
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
