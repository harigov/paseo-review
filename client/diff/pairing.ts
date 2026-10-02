import type { DiffLine } from "../../shared/types";

/**
 * One row of a side-by-side (split) diff: the index into `hunk.lines` shown on the old side,
 * the one shown on the new side, or `null` when that side has no line for this row.
 */
export interface LinePair {
  oldIndex: number | null;
  newIndex: number | null;
}

/**
 * Pairs up a hunk's lines for side-by-side rendering.
 *
 * - A context line is identical on both sides, so it becomes `{ oldIndex: i, newIndex: i }`.
 * - A maximal run of consecutive `del` lines immediately followed by a maximal run of
 *   consecutive `add` lines is paired positionally: del[k] with add[k]. Whichever run is
 *   longer leaves its extra lines paired with `null` on the other side — including the
 *   degenerate cases of an add-only run (no preceding dels) or a del-only run (no following
 *   adds), which pair entirely with `null` on the old/new side respectively.
 * - A context line always ends the current del/add run: it is never folded into a
 *   neighboring pairing.
 */
export function pairHunkLines(lines: DiffLine[]): LinePair[] {
  const result: LinePair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      result.push({ oldIndex: i, newIndex: i });
      i += 1;
      continue;
    }
    const delStart = i;
    let delEnd = delStart;
    while (delEnd < lines.length && lines[delEnd].kind === "del") delEnd += 1;
    const addStart = delEnd;
    let addEnd = addStart;
    while (addEnd < lines.length && lines[addEnd].kind === "add") addEnd += 1;
    const delCount = delEnd - delStart;
    const addCount = addEnd - addStart;
    const runLength = Math.max(delCount, addCount);
    for (let k = 0; k < runLength; k += 1) {
      result.push({
        oldIndex: k < delCount ? delStart + k : null,
        newIndex: k < addCount ? addStart + k : null,
      });
    }
    i = addEnd;
  }
  return result;
}

/** Number of rows a split-mode render of `lines` would produce. */
export function splitRowCount(lines: DiffLine[]): number {
  return pairHunkLines(lines).length;
}

/**
 * Expands tabs to the next multiple of `tabSize` columns (like a terminal's default tab stops),
 * so code indentation renders with a deterministic width instead of the browser's default tab
 * rendering.
 */
export function expandTabs(text: string, tabSize = 4): string {
  let result = "";
  let column = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const width = tabSize - (column % tabSize);
      result += " ".repeat(width);
      column += width;
    } else {
      result += ch;
      column += 1;
    }
  }
  return result;
}

/**
 * Renders whitespace visibly for whitespace-only diff lines: each space becomes "·", and each
 * tab becomes "→" followed by "·" for the rest of its expanded width — so the exact whitespace
 * shape (spaces vs. tabs, and how many) is visible instead of collapsing to nothing. Non-
 * whitespace characters are left unchanged.
 */
export function markWhitespace(text: string, tabSize = 4): string {
  let result = "";
  let column = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const width = tabSize - (column % tabSize);
      result += "→" + "·".repeat(Math.max(0, width - 1));
      column += width;
    } else if (ch === " ") {
      result += "·";
      column += 1;
    } else {
      result += ch;
      column += 1;
    }
  }
  return result;
}
