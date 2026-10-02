import type { DiffLine, Hunk } from "../../shared/types";

/**
 * Pure helpers for real context expansion (S2). `rows.ts` uses both of these to turn the
 * `expandContext` placeholder rows into real, fetched context lines plus a (possibly smaller)
 * "expand N more" placeholder for whatever's left of the gap. No React or react-native imports
 * here — unit-tested under tsconfig.server.json alongside the other pure diff modules.
 */

export type ContextGapPosition = "above" | "below" | "between";

/** `prr.file.lines` lines fetched per "Expand" press; shared with `ModuleTab` and `DiffRows`. */
export const CONTEXT_PAGE_SIZE = 20;

/** One gap in a file's visible lines, independent of how much of it has already been fetched. */
export interface ContextGap {
  position: ContextGapPosition;
  /** The hunk this gap precedes ("above"/"between"), or the last hunk it follows ("below"). */
  hunkIndex: number;
  /** First old-side line number in the gap (1-based). */
  oldStart: number;
  /** First new-side line number in the gap (1-based). */
  newStart: number;
  /** Total size of the gap, old and new (a gap has no changes, so both sides are equal length). */
  count: number;
  /** True when the old- and new-side sizes computed for this gap disagree because a hunk was
   * dropped from a truncated diff: the hunks on either side no longer account for every line
   * between them, so fetching "context" here could actually surface the dropped hunk's changed
   * lines mislabeled as unchanged. Rendered as a muted, non-expandable notice instead of an
   * "Expand" control. */
  unsafe: boolean;
}

/** Last old/new line number a hunk actually covers (inclusive). Unified-diff convention points
 * `oldStart`/`newStart` at the line *before* the change for a pure insertion (`oldLines === 0`)
 * or pure deletion (`newLines === 0`) hunk, so that side's "covered" end is `start` itself —
 * not `start - 1`, which would double-count that anchor line as part of the following gap. */
function coveredEnd(start: number, lines: number): number {
  return lines === 0 ? start : start + lines - 1;
}

/**
 * The full set of gaps for a file's hunks: "above" the first hunk, "between" consecutive hunks,
 * and (when `totalLines` is known) "below" the last hunk through the end of the file. Pass
 * `totalLines` as `null` when it isn't known yet (not fetched) or doesn't apply (deleted file) —
 * the "below" gap is omitted in that case, since its size can't be computed without it. Pass
 * `truncated` (the file diff's own `truncated` flag) so a "between" gap whose old/new sizes
 * disagree — the signature of a hunk having been dropped for being over the size budget — can be
 * flagged `unsafe` instead of silently mis-sizing the gap (see `ContextGap.unsafe`).
 */
export function gapsForFile(hunks: Hunk[], totalLines: number | null, truncated = false): ContextGap[] {
  const gaps: ContextGap[] = [];

  hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex === 0) {
      // Sized from the new side, matching `mergeContextLines`'s first-hunk boundary (`hunk.newStart`)
      // rather than the old side: for a pure-insertion/deletion first hunk, `oldStart`/`newStart`
      // diverge (one side's anchor convention points at a line the other side doesn't have), and
      // only the new-side count matches what can actually be fetched (`prr.file.lines` reads the
      // head/new-side file) — using the old side either strands an unreachable last line or leaves
      // a remaining count merge can never satisfy.
      if (hunk.newStart > 1) {
        gaps.push({ position: "above", hunkIndex, oldStart: 1, newStart: 1, count: hunk.newStart - 1, unsafe: false });
      }
      return;
    }
    const prev = hunks[hunkIndex - 1];
    const oldStart = coveredEnd(prev.oldStart, prev.oldLines) + 1;
    const newStart = coveredEnd(prev.newStart, prev.newLines) + 1;
    const count = hunk.oldStart - oldStart;
    if (count > 0) {
      // In an untruncated diff the old- and new-side counts always agree (a gap has no changes,
      // so it's the same length on both sides); a disagreement only happens when a hunk was
      // dropped from a truncated diff, leaving the visible hunks' line numbers unable to account
      // for every line between them.
      const newCount = hunk.newStart - newStart;
      const unsafe = truncated && count !== newCount;
      gaps.push({ position: "between", hunkIndex, oldStart, newStart, count, unsafe });
    }
  });

  if (totalLines !== null && hunks.length > 0) {
    const last = hunks[hunks.length - 1];
    const oldStart = coveredEnd(last.oldStart, last.oldLines) + 1;
    const newStart = coveredEnd(last.newStart, last.newLines) + 1;
    const count = totalLines - newStart + 1;
    if (count > 0) {
      gaps.push({ position: "below", hunkIndex: hunks.length - 1, oldStart, newStart, count, unsafe: false });
    }
  }

  return gaps;
}

function makeContextLine(newNo: number, oldNo: number, text: string): DiffLine {
  return { kind: "context", oldNo, newNo, text, moved: false, whitespaceOnly: false };
}

/** A contiguous run starting at `start` (inclusive) and stopping at the first line not present in
 * `fetched`, up to (but not including) `endExclusive` when given. Used for gaps that fill from
 * their start toward their end ("between" and "below" expand from the neighboring hunk outward). */
function collectPrefix(fetched: ReadonlyMap<number, string>, start: number, endExclusive: number | null, oldForStart: number): DiffLine[] {
  const lines: DiffLine[] = [];
  let newNo = start;
  while (endExclusive === null || newNo < endExclusive) {
    const text = fetched.get(newNo);
    if (text === undefined) break;
    lines.push(makeContextLine(newNo, oldForStart + (newNo - start), text));
    newNo += 1;
  }
  return lines;
}

/** A contiguous run ending at `endExclusive - 1` and stopping (from the end, scanning backward)
 * at the first line not present in `fetched`, returned in ascending order. Used for gaps that
 * fill from their end toward their start ("above" expands upward from the hunk's first line). */
function collectSuffix(fetched: ReadonlyMap<number, string>, start: number, endExclusive: number, oldForStart: number): DiffLine[] {
  const lines: DiffLine[] = [];
  let newNo = endExclusive - 1;
  while (newNo >= start) {
    const text = fetched.get(newNo);
    if (text === undefined) break;
    lines.unshift(makeContextLine(newNo, oldForStart + (newNo - start), text));
    newNo -= 1;
  }
  return lines;
}

/** Fetched context lines attached to one hunk: lines to show immediately before it (from the
 * "above" gap for the first hunk, or the "between" gap for any other hunk) and, only for the
 * last hunk, lines to show immediately after it (from the "below" gap). */
export interface HunkContextLines {
  prepend: DiffLine[];
  append: DiffLine[];
}

/**
 * Places already-fetched context lines (keyed by new-side line number, as returned by
 * `prr.file.lines` with `side: "head"`) next to the hunks they belong to, so `rows.ts` can emit
 * them as ordinary context `line`/`pair` rows around each hunk. Old-side numbers are derived from
 * each gap's old/new offset. Doesn't need `totalLines`: the "below" run has no fixed upper bound
 * to respect here (that's `gapsForFile`'s job, for sizing the remaining "expand" placeholder) —
 * it simply collects however much of a contiguous run starting right after the last hunk is
 * already in `fetched`.
 */
export function mergeContextLines(hunks: Hunk[], fetched: ReadonlyMap<number, string>): HunkContextLines[] {
  return hunks.map((hunk, hunkIndex) => {
    let prepend: DiffLine[];
    if (hunkIndex === 0) {
      // Gated on the new side, matching `gapsForFile`'s first-hunk convention above.
      prepend = hunk.newStart > 1 ? collectSuffix(fetched, 1, hunk.newStart, 1) : [];
    } else {
      const prev = hunks[hunkIndex - 1];
      const oldStart = coveredEnd(prev.oldStart, prev.oldLines) + 1;
      const newStart = coveredEnd(prev.newStart, prev.newLines) + 1;
      prepend = hunk.oldStart > oldStart ? collectPrefix(fetched, newStart, hunk.newStart, oldStart) : [];
    }

    let append: DiffLine[] = [];
    if (hunkIndex === hunks.length - 1) {
      const oldStart = coveredEnd(hunk.oldStart, hunk.oldLines) + 1;
      const newStart = coveredEnd(hunk.newStart, hunk.newLines) + 1;
      append = collectPrefix(fetched, newStart, null, oldStart);
    }

    return { prepend, append };
  });
}
