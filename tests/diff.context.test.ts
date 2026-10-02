import { describe, expect, it } from "vitest";
import { gapsForFile, mergeContextLines } from "../client/diff/context";
import type { Hunk } from "../shared/types";

function hunk(partial: Partial<Hunk> & { oldStart: number; newStart: number }): Hunk {
  return {
    header: "@@ @@",
    oldLines: 1,
    newLines: 1,
    lines: [],
    pureMove: false,
    whitespaceOnly: false,
    ...partial,
  };
}

describe("gapsForFile", () => {
  it("emits an 'above' gap when the first hunk doesn't start at line 1", () => {
    const gaps = gapsForFile([hunk({ oldStart: 10, newStart: 10 })], null);
    expect(gaps).toEqual([{ position: "above", hunkIndex: 0, oldStart: 1, newStart: 1, count: 9 }]);
  });

  it("emits no 'above' gap when the first hunk starts at line 1", () => {
    const gaps = gapsForFile([hunk({ oldStart: 1, newStart: 1 })], null);
    expect(gaps).toEqual([]);
  });

  it("emits a 'between' gap sized from the old-side offset, with matching new-side numbering", () => {
    const h1 = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const h2 = hunk({ oldStart: 20, newStart: 20 });
    const gaps = gapsForFile([h1, h2], null);
    expect(gaps).toEqual([{ position: "between", hunkIndex: 1, oldStart: 2, newStart: 2, count: 18 }]);
  });

  it("emits no 'between' gap when two hunks are adjacent", () => {
    const h1 = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const h2 = hunk({ oldStart: 2, newStart: 2 });
    expect(gapsForFile([h1, h2], null)).toEqual([]);
  });

  it("handles a 'between' gap after a pure-insertion hunk (oldLines 0) without an off-by-one", () => {
    // @@ -5,0 +6,2 @@ (insert 2 new lines after old line 5) followed by @@ -8,1 +10,1 @@ — the
    // gap covers old lines 6-7 (2 lines, mapping to new lines 8-9), not old 5-7: old line 5 is
    // the insertion's anchor, already "covered" by the first hunk, not part of the following gap.
    const h1 = hunk({ oldStart: 5, oldLines: 0, newStart: 6, newLines: 2 });
    const h2 = hunk({ oldStart: 8, oldLines: 1, newStart: 10, newLines: 1 });
    const gaps = gapsForFile([h1, h2], null);
    const between = gaps.find((g) => g.position === "between");
    expect(between).toEqual({ position: "between", hunkIndex: 1, oldStart: 6, newStart: 8, count: 2 });
  });

  it("handles a pure-deletion hunk (newLines 0) symmetrically on the new side", () => {
    // @@ -6,2 +5,0 @@ (delete old lines 6-7 after new line 5) followed by @@ -11,1 +9,1 @@ — the
    // gap covers old lines 8-10 / new lines 6-8 (3 lines), not new 5-8: new line 5 is the
    // deletion's anchor, already "covered" by the first hunk, not part of the following gap.
    const h1 = hunk({ oldStart: 6, oldLines: 2, newStart: 5, newLines: 0 });
    const h2 = hunk({ oldStart: 11, oldLines: 1, newStart: 9, newLines: 1 });
    const gaps = gapsForFile([h1, h2], null);
    const between = gaps.find((g) => g.position === "between");
    expect(between).toEqual({ position: "between", hunkIndex: 1, oldStart: 8, newStart: 6, count: 3 });
  });

  it("emits no 'below' gap when totalLines is null (unknown or not applicable)", () => {
    const gaps = gapsForFile([hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 })], null);
    expect(gaps).toEqual([]);
  });

  it("emits a 'below' gap sized from totalLines, once known", () => {
    const h = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const gaps = gapsForFile([h], 25);
    expect(gaps).toEqual([{ position: "below", hunkIndex: 0, oldStart: 2, newStart: 2, count: 24 }]);
  });

  it("emits no 'below' gap when the last hunk already reaches the end of the file", () => {
    const h = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }); // covers new line 1
    expect(gapsForFile([h], 1)).toEqual([]);
  });

  it("reports a gap count small enough for the ≤ 500 'expand all' rule", () => {
    const gaps = gapsForFile([hunk({ oldStart: 500, newStart: 500 })], null);
    expect(gaps[0].count).toBe(499);
    expect(gaps[0].count <= 500).toBe(true);
  });

  it("reports a gap count over the ≤ 500 'expand all' threshold for a very large gap", () => {
    const gaps = gapsForFile([hunk({ oldStart: 2000, newStart: 2000 })], null);
    expect(gaps[0].count > 500).toBe(true);
  });
});

describe("mergeContextLines", () => {
  it("'above' only keeps the run contiguous with the hunk, even if other lines were fetched out of order", () => {
    const h = hunk({ oldStart: 10, newStart: 10 }); // gap is lines 1-9
    const fetched = new Map([
      [1, "l1"],
      [2, "l2"],
      [9, "l9"],
    ]);
    const [{ prepend, append }] = mergeContextLines([h], fetched);
    // "above" fills from the end of the gap (nearest the hunk) first, so line 9 counts but lines
    // 1-2 don't yet (lines 3-8 are still missing, breaking the contiguous run).
    expect(prepend).toEqual([{ kind: "context", oldNo: 9, newNo: 9, text: "l9", moved: false, whitespaceOnly: false }]);
    expect(append).toEqual([]);
  });

  it("'above' fills from the end of the gap (nearest the hunk) first, leaving an unfetched prefix", () => {
    const h = hunk({ oldStart: 26, newStart: 26 }); // gap is lines 1-25
    const fetched = new Map(Array.from({ length: 20 }, (_, i) => [6 + i, `l${6 + i}`] as const)); // lines 6-25
    const [{ prepend }] = mergeContextLines([h], fetched);
    expect(prepend).toHaveLength(20);
    expect(prepend[0]).toMatchObject({ newNo: 6, oldNo: 6 });
    expect(prepend[19]).toMatchObject({ newNo: 25, oldNo: 25 });
  });

  it("'between' fills from the start of the gap (nearest the previous hunk) first", () => {
    const h1 = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const h2 = hunk({ oldStart: 30, newStart: 30 }); // gap is old/new lines 2-29
    const fetched = new Map(Array.from({ length: 10 }, (_, i) => [2 + i, `l${2 + i}`] as const)); // lines 2-11
    const [, { prepend: prependH2 }] = mergeContextLines([h1, h2], fetched);
    expect(prependH2).toHaveLength(10);
    expect(prependH2[0]).toMatchObject({ newNo: 2, oldNo: 2 });
    expect(prependH2[9]).toMatchObject({ newNo: 11, oldNo: 11 });
  });

  it("derives old-side numbers from the gap's old/new offset, not the new-side numbers directly", () => {
    // A prior hunk that added 3 more lines than it removed shifts old numbering back by 3 for
    // everything after it.
    const h1 = hunk({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 5 });
    const h2 = hunk({ oldStart: 10, newStart: 13 });
    const fetched = new Map([[6, "ctx"]]); // new line 6, right after h1 (newStart 1 + newLines 5)
    const [, { prepend }] = mergeContextLines([h1, h2], fetched);
    expect(prepend).toEqual([{ kind: "context", oldNo: 3, newNo: 6, text: "ctx", moved: false, whitespaceOnly: false }]);
  });

  it("appends a contiguous 'below' run after the last hunk, with no upper bound needed", () => {
    const h = hunk({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }); // covers new line 1
    const fetched = new Map([
      [2, "l2"],
      [3, "l3"],
      [5, "l5"], // not contiguous with 2-3, so excluded
    ]);
    const [{ append }] = mergeContextLines([h], fetched);
    expect(append).toEqual([
      { kind: "context", oldNo: 2, newNo: 2, text: "l2", moved: false, whitespaceOnly: false },
      { kind: "context", oldNo: 3, newNo: 3, text: "l3", moved: false, whitespaceOnly: false },
    ]);
  });

  it("returns empty prepend/append for every hunk when nothing has been fetched yet", () => {
    const h1 = hunk({ oldStart: 10, newStart: 10 });
    const h2 = hunk({ oldStart: 20, newStart: 20 });
    const merged = mergeContextLines([h1, h2], new Map());
    expect(merged).toEqual([
      { prepend: [], append: [] },
      { prepend: [], append: [] },
    ]);
  });
});
