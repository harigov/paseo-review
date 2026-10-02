import { describe, expect, it } from "vitest";
import {
  buildStreamRows,
  defaultFileLevel,
  fileSegments,
  formatHunkHeader,
  hunkContext,
  openFileLevel,
  outlineSummary,
  overlappingHunkIndices,
  stickyIndices,
  type BuildStreamRowsInput,
  type ComposerTarget,
  type DraftLike,
  type Row,
  type StreamFileInput,
} from "../client/diff/rows";
import type { AnalyzedFile, DiffLine, FileDiff, Hunk, OutlineEntry, Thread } from "../shared/types";
import type { FileDiffFinding } from "../client/diff/rows";

function ctx(oldNo: number, newNo: number, text = `ctx ${oldNo}`): DiffLine {
  return { kind: "context", oldNo, newNo, text, moved: false, whitespaceOnly: false };
}
function del(oldNo: number, text = `del ${oldNo}`): DiffLine {
  return { kind: "del", oldNo, newNo: null, text, moved: false, whitespaceOnly: false };
}
function add(newNo: number, text = `add ${newNo}`): DiffLine {
  return { kind: "add", oldNo: null, newNo, text, moved: false, whitespaceOnly: false };
}

function hunk(partial: Partial<Hunk> & { lines: DiffLine[] }): Hunk {
  return {
    header: "@@ -1,3 +1,3 @@",
    oldStart: 1,
    oldLines: partial.lines.filter((l) => l.oldNo !== null).length,
    newStart: 1,
    newLines: partial.lines.filter((l) => l.newNo !== null).length,
    pureMove: false,
    whitespaceOnly: false,
    ...partial,
  };
}

function fileDiff(partial: Partial<FileDiff> & { hunks: Hunk[] }): FileDiff {
  return { path: "a.ts", oldPath: null, binary: false, truncated: false, totalLines: null, ...partial };
}

function analyzedFile(partial: Partial<AnalyzedFile> & { path: string }): AnalyzedFile {
  return {
    oldPath: null,
    status: "modified",
    binary: false,
    additions: 1,
    deletions: 1,
    effectiveLines: 2,
    movedLines: 0,
    moduleId: "m1",
    moduleSource: "git",
    moduleConfidence: null,
    noiseReason: null,
    risk: null,
    complexity: null,
    viewed: "UNVIEWED",
    changedSinceViewedProbability: null,
    changedSinceLastReview: false,
    rebaseOnly: false,
    order: { foundations: 0, risk: 0, chrono: 0 },
    outline: null,
    structuralKind: null,
    ...partial,
  };
}

function baseFileInput(partial: Partial<StreamFileInput> & { file: AnalyzedFile }): StreamFileInput {
  return {
    level: "files",
    viewed: partial.file.viewed,
    mode: "text",
    outlineExpanded: false,
    outlineSummary: outlineSummary(partial.file.outline ?? []),
    sinceViewedHighlighted: false,
    diffStatus: "success",
    diff: null,
    diffErrorMessage: null,
    expandedHunks: new Set(),
    expandedDecls: new Set(),
    totalLines: null,
    contextLines: new Map(),
    threads: [],
    findings: [],
    drafts: [],
    ...partial,
  };
}

function thread(partial: Partial<Thread> & { id: string; path: string }): Thread {
  return {
    line: null,
    originalLine: null,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    comments: [],
    triage: null,
    triageProbability: null,
    ...partial,
  };
}

function finding(partial: Partial<FileDiffFinding> & { validatorId: string; path: string }): FileDiffFinding {
  return {
    unitKey: "u1",
    startLine: null,
    endLine: null,
    probability: 0.9,
    status: "fail",
    dismissed: false,
    excerpt: "",
    validatorTitle: "Validator",
    ...partial,
  };
}

function outlineEntry(partial: Partial<OutlineEntry> & { name: string }): OutlineEntry {
  return {
    kind: "function",
    change: "modified",
    exported: false,
    signature: `function ${partial.name}()`,
    oldSignature: null,
    newStart: 1,
    newEnd: 3,
    oldStart: null,
    oldEnd: null,
    changedLines: 3,
    counterpart: null,
    ...partial,
  };
}

function draft(partial: Partial<DraftLike> & { id: number; path: string; line: number; side: "LEFT" | "RIGHT" }): DraftLike {
  return { body: "draft body", ...partial };
}

/** Every row but `empty` carries `rail`; this throws on `empty` rather than silently returning
 * `undefined`, since no test here should ever be asserting on an empty row's rail. */
function rail(row: Row): 0 | 1 {
  if (row.type === "empty") throw new Error("empty row has no rail");
  return row.rail;
}

describe("buildStreamRows — basic two-file module", () => {
  const diffA = fileDiff({
    path: "a.ts",
    hunks: [hunk({ lines: [ctx(1, 1), del(2), add(2), ctx(3, 3)] })],
  });
  const fileA = analyzedFile({ path: "a.ts" });
  const fileB = analyzedFile({ path: "b.ts" });

  function build(split: boolean): BuildStreamRowsInput {
    return {
      split,
      composer: null,
      files: [
        baseFileInput({ file: fileA, level: "code", diff: diffA }),
        baseFileInput({ file: fileB, level: "files" }),
      ],
    };
  }

  it("emits a fileHeader for every visible file, and only expands the expanded one (inline)", () => {
    const rows = buildStreamRows(build(false));
    expect(rows[0]).toMatchObject({ type: "fileHeader", path: "a.ts", level: "code" });
    // b.ts is collapsed: just its header, nothing else.
    const bIndex = rows.findIndex((r) => r.type === "fileHeader" && r.path === "b.ts");
    expect(rows[bIndex]).toMatchObject({ type: "fileHeader", path: "b.ts", level: "files" });
    expect(rows[bIndex + 1]).toBeUndefined();
  });

  it("builds fileMeta then line rows (one per diff line) for the expanded file in inline layout", () => {
    const rows = buildStreamRows(build(false));
    expect(rows[1]).toMatchObject({ type: "fileMeta", path: "a.ts" });
    const lineRows = rows.filter((r) => r.type === "line");
    expect(lineRows).toHaveLength(4);
    expect(rows.some((r) => r.type === "hunkHeader" && r.path === "a.ts")).toBe(true);
  });

  it("builds pair rows for the expanded file in split layout", () => {
    const rows = buildStreamRows(build(true));
    const pairRows = rows.filter((r) => r.type === "pair");
    // ctx(1,1), del(2)/add(2) paired together, ctx(3,3) => 3 pair rows
    expect(pairRows).toHaveLength(3);
  });
});

describe("buildStreamRows — thread/finding/draft/composer placement", () => {
  const diff = fileDiff({
    path: "a.ts",
    hunks: [hunk({ lines: [ctx(1, 1), del(2), add(2), ctx(3, 3)] })],
  });
  const file = analyzedFile({ path: "a.ts" });

  it("places a thread row right after the line it targets (inline)", () => {
    const t = thread({ id: "t1", path: "a.ts", diffSide: "RIGHT", line: 2 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", diff, threads: [t] })],
    });
    const addIndex = rows.findIndex((r) => r.type === "line" && r.lineIndex === 2); // add(2)
    expect(rows[addIndex + 1]).toMatchObject({ type: "thread", thread: t });
  });

  it("places a draft row right after the line it targets (inline)", () => {
    const d = draft({ id: 7, path: "a.ts", line: 2, side: "RIGHT" });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", diff, drafts: [d] })],
    });
    const addIndex = rows.findIndex((r) => r.type === "line" && r.lineIndex === 2);
    expect(rows[addIndex + 1]).toMatchObject({ type: "draft", draftId: 7 });
  });

  it("places a finding row right after the new-side line it targets (inline)", () => {
    const f = finding({ validatorId: "v1", path: "a.ts", startLine: 2 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", diff, findings: [f] })],
    });
    const addIndex = rows.findIndex((r) => r.type === "line" && r.lineIndex === 2);
    expect(rows[addIndex + 1]).toMatchObject({ type: "finding", finding: f });
  });

  it("places a single composer row after its target line, in 'new' mode", () => {
    const composer: ComposerTarget = { path: "a.ts", side: "RIGHT", line: 2, mode: "new" };
    const rows = buildStreamRows({
      split: false,
      composer,
      files: [baseFileInput({ file, level: "code", diff })],
    });
    const addIndex = rows.findIndex((r) => r.type === "line" && r.lineIndex === 2);
    expect(rows[addIndex + 1]).toMatchObject({ type: "composer", side: "RIGHT", line: 2, mode: "new" });
    expect(rows.filter((r) => r.type === "composer")).toHaveLength(1);
  });

  it("places the composer on the old side in split layout", () => {
    const composer: ComposerTarget = { path: "a.ts", side: "LEFT", line: 2, mode: "editDraft", draftId: 3 };
    const rows = buildStreamRows({
      split: true,
      composer,
      files: [baseFileInput({ file, level: "code", diff })],
    });
    const pairIndex = rows.findIndex((r) => r.type === "pair" && r.oldIndex === 1); // del(2) at hunk index 1
    expect(rows[pairIndex + 1]).toMatchObject({ type: "composer", side: "LEFT", line: 2, mode: "editDraft", draftId: 3 });
  });

  it("does not place a composer targeting a different file", () => {
    const composer: ComposerTarget = { path: "other.ts", side: "RIGHT", line: 2, mode: "new" };
    const rows = buildStreamRows({
      split: false,
      composer,
      files: [baseFileInput({ file, level: "code", diff })],
    });
    expect(rows.some((r) => r.type === "composer")).toBe(false);
  });
});

describe("buildStreamRows — collapsed hunks", () => {
  const movedHunk = hunk({ lines: [del(1), add(1)], pureMove: true });
  const diff = fileDiff({ path: "a.ts", hunks: [movedHunk] });
  const file = analyzedFile({ path: "a.ts" });

  it("collapses a pure-move hunk until its index is in expandedHunks", () => {
    const collapsedRows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", diff })],
    });
    expect(collapsedRows.some((r) => r.type === "collapsed" && r.kind === "moved" && r.count === 2)).toBe(true);
    expect(collapsedRows.some((r) => r.type === "line")).toBe(false);

    const expandedRows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", diff, expandedHunks: new Set([0]) })],
    });
    expect(expandedRows.some((r) => r.type === "collapsed")).toBe(false);
    expect(expandedRows.filter((r) => r.type === "line")).toHaveLength(2);
  });

  it("collapses a whitespace-only hunk the same way", () => {
    const wsHunk = hunk({ lines: [del(1), add(1)], whitespaceOnly: true });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", diff: fileDiff({ path: "a.ts", hunks: [wsHunk] }) })],
    });
    expect(rows.some((r) => r.type === "collapsed" && r.kind === "whitespace")).toBe(true);
  });

  it("suppresses adjacent context lines and expand placeholders while the neighboring hunk is collapsed", () => {
    // Fetched context would otherwise render unhighlighted next to a still-collapsed hunk (its
    // tokens/intraline caches skip collapsed hunks entirely) — so nothing for the gap is shown
    // until the hunk itself is expanded.
    const movedAt10 = hunk({ lines: [del(10), add(10)], oldStart: 10, newStart: 10, pureMove: true });
    const diffWithGap = fileDiff({ path: "a.ts", hunks: [movedAt10] });
    const fetched = new Map([[9, "fetched 9"]]); // contiguous with the hunk, for the "above" gap

    const collapsedRows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", diff: diffWithGap, contextLines: fetched })],
    });
    expect(collapsedRows.some((r) => r.type === "expandContext")).toBe(false);
    expect(collapsedRows.some((r) => r.type === "line")).toBe(false);

    const expandedRows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", diff: diffWithGap, contextLines: fetched, expandedHunks: new Set([0]) })],
    });
    expect(expandedRows.find((r) => r.type === "expandContext" && r.position === "above")).toMatchObject({ count: 8 });
    expect(expandedRows.some((r) => r.type === "line" && r.hunkIndex === 0 && r.lineIndex === 0)).toBe(true);
    expect(expandedRows.filter((r) => r.type === "line")).toHaveLength(3); // fetched context + del + add
  });
});

describe("expand-context placeholders", () => {
  it("emits an 'above' placeholder when the first hunk doesn't start at line 1", () => {
    const h = hunk({ lines: [ctx(10, 10)], oldStart: 10, newStart: 10 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diff: fileDiff({ path: "a.ts", hunks: [h] }) })],
    });
    const above = rows.find((r) => r.type === "expandContext");
    expect(above).toMatchObject({ type: "expandContext", position: "above", count: 9 });
  });

  it("emits a 'between' placeholder when two hunks aren't adjacent", () => {
    const h1 = hunk({ lines: [ctx(1, 1)], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const h2 = hunk({ lines: [ctx(20, 20)], oldStart: 20, oldLines: 1, newStart: 20, newLines: 1 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diff: fileDiff({ path: "a.ts", hunks: [h1, h2] }) })],
    });
    const between = rows.find((r) => r.type === "expandContext" && r.position === "between");
    expect(between).toMatchObject({ position: "between", oldStart: 2, newStart: 2, count: 18 });
  });

  it("emits no placeholder when the first hunk starts at line 1 and hunks are adjacent", () => {
    const h1 = hunk({ lines: [ctx(1, 1)], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const h2 = hunk({ lines: [ctx(2, 2)], oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diff: fileDiff({ path: "a.ts", hunks: [h1, h2] }) })],
    });
    expect(rows.some((r) => r.type === "expandContext")).toBe(false);
  });

  it("emits no 'below' placeholder when totalLines is unknown", () => {
    const h = hunk({ lines: [ctx(1, 1)], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diff: fileDiff({ path: "a.ts", hunks: [h] }), totalLines: null })],
    });
    expect(rows.some((r) => r.type === "expandContext" && r.position === "below")).toBe(false);
  });

  it("emits a 'below' placeholder once totalLines is known, after the last hunk's lines", () => {
    const h = hunk({ lines: [ctx(1, 1)], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diff: fileDiff({ path: "a.ts", hunks: [h] }), totalLines: 25 })],
    });
    const lastLineIndex = rows.findIndex((r) => r.type === "line");
    const below = rows.find((r) => r.type === "expandContext" && r.position === "below");
    expect(below).toMatchObject({ position: "below", oldStart: 2, newStart: 2, count: 24, totalCount: 24 });
    expect(rows.indexOf(below!)).toBeGreaterThan(lastLineIndex);
  });

  it("interleaves already-fetched context lines around a hunk, shrinking the remaining placeholder", () => {
    const h = hunk({ lines: [ctx(20, 20)], oldStart: 20, oldLines: 1, newStart: 20, newLines: 1 });
    // "above" gap is lines 1-19; only the 5 nearest the hunk (15-19) have been fetched.
    const fetched = new Map(Array.from({ length: 5 }, (_, i) => [15 + i, `fetched ${15 + i}`] as const));
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [
        baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diff: fileDiff({ path: "a.ts", hunks: [h] }), contextLines: fetched }),
      ],
    });
    const placeholder = rows.find((r) => r.type === "expandContext");
    expect(placeholder).toMatchObject({ position: "above", count: 14, totalCount: 19 });
    const placeholderIndex = rows.indexOf(placeholder!);
    const fetchedLineRows = rows.filter((r) => r.type === "line" && r.lineIndex < 5);
    expect(fetchedLineRows).toHaveLength(5);
    // The still-unfetched remainder (nearest the top of the file) comes before the fetched lines
    // (nearest the hunk), which come before the hunk's own header.
    const hunkHeaderIndex = rows.findIndex((r) => r.type === "hunkHeader");
    expect(placeholderIndex).toBeLessThan(rows.indexOf(fetchedLineRows[0]));
    expect(rows.indexOf(fetchedLineRows[4])).toBeLessThan(hunkHeaderIndex);
  });

  it("handles a pure-insertion hunk's 'between' gap without an off-by-one", () => {
    // @@ -5,0 +6,2 @@ followed by @@ -8,1 +10,1 @@ — the gap covers old lines 6-7 (count 2),
    // not old 5-7: old line 5 is the insertion's anchor, not part of the following gap.
    const h1 = hunk({ lines: [ctx(100, 100)], oldStart: 5, oldLines: 0, newStart: 6, newLines: 2 });
    const h2 = hunk({ lines: [ctx(200, 200)], oldStart: 8, oldLines: 1, newStart: 10, newLines: 1 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diff: fileDiff({ path: "a.ts", hunks: [h1, h2] }) })],
    });
    const between = rows.find((r) => r.type === "expandContext" && r.position === "between");
    expect(between).toMatchObject({ position: "between", oldStart: 6, newStart: 8, count: 2, totalCount: 2 });
  });

  it("renders an unsafe, non-expandable placeholder for a 'between' gap spanning a dropped hunk", () => {
    // h2's old/new numbering implies a net -2 shift that nothing visible between h1 and h2
    // explains — the signature of a hunk having been dropped from this truncated diff.
    const h1 = hunk({ lines: [ctx(1, 1)], oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const h2 = hunk({ lines: [ctx(200, 200)], oldStart: 6, oldLines: 1, newStart: 4, newLines: 1 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [
        baseFileInput({
          file: analyzedFile({ path: "a.ts" }),
          level: "code",
          diff: fileDiff({ path: "a.ts", hunks: [h1, h2], truncated: true }),
        }),
      ],
    });
    const between = rows.find((r) => r.type === "expandContext" && r.position === "between");
    expect(between).toMatchObject({ position: "between", unsafe: true, count: 4, totalCount: 4 });
  });
});

describe("fileMeta uses the resolved viewed state, not the raw file flag", () => {
  it("reflects an optimistic viewed override rather than the stale analysis value", () => {
    const file = analyzedFile({ path: "a.ts", viewed: "DISMISSED" });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", viewed: "VIEWED" })],
    });
    const meta = rows.find((r) => r.type === "fileMeta");
    expect(meta).toMatchObject({ viewed: "VIEWED" });
  });
});

describe("loading / error / empty / structural / outline rows", () => {
  it("emits a loading row while the file's diff query is in flight, followed by fileEnd", () => {
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diffStatus: "loading", diff: null })],
    });
    expect(rows[rows.length - 2]).toMatchObject({ type: "loading", path: "a.ts" });
    expect(rows[rows.length - 1]).toMatchObject({ type: "fileEnd", path: "a.ts" });
  });

  it("emits an error row (danger tone) when the diff query failed, followed by fileEnd", () => {
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: analyzedFile({ path: "a.ts" }), level: "code", diffStatus: "error", diffErrorMessage: "boom" })],
    });
    expect(rows[rows.length - 2]).toMatchObject({ type: "error", message: "boom", tone: "danger" });
    expect(rows[rows.length - 1]).toMatchObject({ type: "fileEnd" });
  });

  it("emits a muted error row for a binary file, followed by fileEnd", () => {
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [
        baseFileInput({
          file: analyzedFile({ path: "a.png" }),
          level: "code",
          diff: fileDiff({ path: "a.png", binary: true, hunks: [] }),
        }),
      ],
    });
    expect(rows[rows.length - 2]).toMatchObject({ type: "error", tone: "muted" });
    expect(rows[rows.length - 1]).toMatchObject({ type: "fileEnd" });
  });

  it("emits a single empty row (with the since-last-review reason) when there are no visible files", () => {
    const rows = buildStreamRows({ split: false, composer: null, files: [], emptyReason: "since_last_review" });
    expect(rows).toEqual([{ type: "empty", key: "empty", path: "", reason: "since_last_review" }]);
  });

  it("emits a structural row instead of diff rows in structure mode, followed by fileEnd", () => {
    const file = analyzedFile({ path: "pkg-lock.json", structuralKind: "lockfile" });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "code", mode: "structure" })],
    });
    expect(rows[rows.length - 2]).toMatchObject({ type: "structural", path: "pkg-lock.json" });
    expect(rows[rows.length - 1]).toMatchObject({ type: "fileEnd" });
  });

  it("emits an outline row with the precomputed summary when the file has outline entries", () => {
    const entries: OutlineEntry[] = [
      {
        name: "foo",
        kind: "function",
        change: "added",
        exported: true,
        signature: "function foo()",
        oldSignature: null,
        newStart: 1,
        newEnd: 3,
        oldStart: null,
        oldEnd: null,
        changedLines: 3,
        counterpart: null,
      },
    ];
    const file = analyzedFile({ path: "a.ts", outline: entries });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [
        baseFileInput({
          file,
          level: "code",
          diff: fileDiff({ path: "a.ts", hunks: [] }),
          outlineSummary: outlineSummary(entries),
        }),
      ],
    });
    const outlineRow = rows.find((r) => r.type === "outline");
    expect(outlineRow).toMatchObject({ type: "outline", summary: "1 added", entries });
    const headerRow = rows.find((r) => r.type === "fileHeader");
    expect(headerRow).toMatchObject({ outlineSummary: "1 added" });
  });
});

describe("stickyIndices", () => {
  it("returns the index of every fileHeader row", () => {
    const fileA = analyzedFile({ path: "a.ts" });
    const fileB = analyzedFile({ path: "b.ts" });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [
        baseFileInput({ file: fileA, level: "code", diff: fileDiff({ path: "a.ts", hunks: [hunk({ lines: [ctx(1, 1)] })] }) }),
        baseFileInput({ file: fileB, level: "files" }),
      ],
    });
    const indices = stickyIndices(rows);
    expect(indices).toEqual(rows.reduce<number[]>((acc, r, i) => (r.type === "fileHeader" ? [...acc, i] : acc), []));
    expect(indices[0]).toBe(0);
    expect(rows[indices[1]]).toMatchObject({ type: "fileHeader", path: "b.ts" });
  });
});

describe("fileSegments", () => {
  it("groups rows per file, sized by row count, in file order", () => {
    const fileA = analyzedFile({ path: "a.ts" });
    const fileB = analyzedFile({ path: "b.ts" });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [
        baseFileInput({ file: fileA, level: "code", diff: fileDiff({ path: "a.ts", hunks: [hunk({ lines: [ctx(1, 1), ctx(2, 2)] })] }) }),
        baseFileInput({ file: fileB, level: "files" }),
      ],
    });
    const segments = fileSegments(rows);
    expect(segments).toHaveLength(2);
    expect(segments[0].path).toBe("a.ts");
    expect(segments[0].start).toBe(0);
    expect(segments[0].count).toBe(rows.findIndex((r) => r.type === "fileHeader" && r.path === "b.ts"));
    expect(segments[1]).toMatchObject({ path: "b.ts", count: 1 });
    expect(segments.reduce((sum, s) => sum + s.count, 0)).toBe(rows.length);
  });
});

describe("hunkContext / formatHunkHeader", () => {
  it("extracts the context after the second @@", () => {
    expect(hunkContext("@@ -12,5 +34,8 @@ function foo() {")).toBe("function foo() {");
  });

  it("returns '' when there's no context after the second @@", () => {
    expect(hunkContext("@@ -12,5 +34,8 @@")).toBe("");
  });

  it("returns '' when the header doesn't have two @@ markers", () => {
    expect(hunkContext("not a hunk header")).toBe("");
  });

  it("formats with context when present", () => {
    expect(formatHunkHeader("function foo() {", 34, 41)).toBe("function foo() { · L34–41");
  });

  it("formats as just the line range when there's no context", () => {
    expect(formatHunkHeader("", 34, 41)).toBe("L34–41");
  });
});

describe("defaultFileLevel", () => {
  it("collapses a VIEWED file to files regardless of module level or size", () => {
    const file = analyzedFile({ path: "a.ts", effectiveLines: 1000, outline: [outlineEntry({ name: "foo" })] });
    expect(defaultFileLevel(file, "code", "VIEWED")).toBe("files");
    expect(defaultFileLevel(file, "declarations", "VIEWED")).toBe("files");
  });

  it("drops a huge Code-level file with an outline to declarations instead of opening it fully", () => {
    const file = analyzedFile({ path: "a.ts", effectiveLines: 401, outline: [outlineEntry({ name: "foo" })] });
    expect(defaultFileLevel(file, "code", "UNVIEWED")).toBe("declarations");
  });

  it("drops a huge Code-level file with only a structural view to declarations too", () => {
    const file = analyzedFile({ path: "a.json", effectiveLines: 401, outline: null, structuralKind: "json" });
    expect(defaultFileLevel(file, "code", "UNVIEWED")).toBe("declarations");
  });

  it("collapses a huge Code-level file with neither an outline nor a structural view to files", () => {
    const file = analyzedFile({ path: "a.ts", effectiveLines: 401, outline: null, structuralKind: null });
    expect(defaultFileLevel(file, "code", "UNVIEWED")).toBe("files");
  });

  it("opens a small unviewed Code-level file fully, same as today", () => {
    const file = analyzedFile({ path: "a.ts", effectiveLines: 400, outline: null });
    expect(defaultFileLevel(file, "code", "UNVIEWED")).toBe("code");
  });

  it("just follows the module level when the module isn't at Code, regardless of size", () => {
    const file = analyzedFile({ path: "a.ts", effectiveLines: 1000, outline: null });
    expect(defaultFileLevel(file, "declarations", "UNVIEWED")).toBe("declarations");
    expect(defaultFileLevel(file, "files", "UNVIEWED")).toBe("files");
  });
});

describe("openFileLevel", () => {
  it("opens to the module's level when it isn't files", () => {
    const file = analyzedFile({ path: "a.ts", outline: null, structuralKind: null });
    expect(openFileLevel(file, "code")).toBe("code");
    expect(openFileLevel(file, "declarations")).toBe("declarations");
  });

  it("opens to declarations when the module is at files but the file has an outline", () => {
    const file = analyzedFile({ path: "a.ts", outline: [outlineEntry({ name: "foo" })] });
    expect(openFileLevel(file, "files")).toBe("declarations");
  });

  it("opens to declarations when the module is at files but the file has a structural view", () => {
    const file = analyzedFile({ path: "a.json", outline: null, structuralKind: "json" });
    expect(openFileLevel(file, "files")).toBe("declarations");
  });

  it("opens straight to code when the module is at files and the file has neither", () => {
    const file = analyzedFile({ path: "a.ts", outline: null, structuralKind: null });
    expect(openFileLevel(file, "files")).toBe("code");
  });
});

describe("overlappingHunkIndices", () => {
  const h0 = hunk({ lines: [ctx(1, 1), del(2), add(2), ctx(3, 3)] }); // new range 1-3
  const h1 = hunk({ lines: [ctx(10, 10)], oldStart: 10, newStart: 10 }); // new range 10-10
  const hunks = [h0, h1];

  it("picks the hunk overlapping a declaration's new-side range", () => {
    expect(overlappingHunkIndices(hunks, { newStart: 1, newEnd: 2, oldStart: null, oldEnd: null })).toEqual([0]);
    expect(overlappingHunkIndices(hunks, { newStart: 10, newEnd: 10, oldStart: null, oldEnd: null })).toEqual([1]);
  });

  it("falls back to the old-side range for a removed declaration (no new-side range)", () => {
    const delOnly = hunk({ lines: [del(5), del(6)], oldStart: 5, newStart: 5 });
    expect(overlappingHunkIndices([delOnly], { newStart: null, newEnd: null, oldStart: 5, oldEnd: 6 })).toEqual([0]);
  });

  it("returns every overlapping hunk, in hunk order", () => {
    expect(overlappingHunkIndices(hunks, { newStart: 2, newEnd: 10, oldStart: null, oldEnd: null })).toEqual([0, 1]);
  });

  it("returns [] when the entry has neither a new- nor an old-side range", () => {
    expect(overlappingHunkIndices(hunks, { newStart: null, newEnd: null, oldStart: null, oldEnd: null })).toEqual([]);
  });

  it("returns [] when nothing overlaps", () => {
    expect(overlappingHunkIndices(hunks, { newStart: 100, newEnd: 101, oldStart: null, oldEnd: null })).toEqual([]);
  });
});

describe("buildStreamRows — declarations level", () => {
  it("shows the structural row (its equivalent of declarations) for a structural-kind file", () => {
    const file = analyzedFile({ path: "pkg-lock.json", structuralKind: "lockfile" });
    const rows = buildStreamRows({ split: false, composer: null, files: [baseFileInput({ file, level: "declarations" })] });
    expect(rows.map((r) => r.type)).toEqual(["fileHeader", "fileMeta", "structural", "fileEnd"]);
  });

  it("shows a muted notice for a binary file, without needing its diff", () => {
    const file = analyzedFile({ path: "a.png", binary: true });
    const rows = buildStreamRows({ split: false, composer: null, files: [baseFileInput({ file, level: "declarations" })] });
    expect(rows.map((r) => r.type)).toEqual(["fileHeader", "fileMeta", "error", "fileEnd"]);
    expect(rows.find((r) => r.type === "error")).toMatchObject({ tone: "muted", message: "Binary file not shown." });
  });

  it("shows the noOutline row, with the changed-line count, when the file has no outline", () => {
    const file = analyzedFile({ path: "a.txt", effectiveLines: 14, outline: null });
    const rows = buildStreamRows({ split: false, composer: null, files: [baseFileInput({ file, level: "declarations" })] });
    expect(rows.map((r) => r.type)).toEqual(["fileHeader", "fileMeta", "noOutline", "fileEnd"]);
    expect(rows.find((r) => r.type === "noOutline")).toMatchObject({ path: "a.txt", changedLines: 14 });
  });

  it("emits one decl row per outline entry, collapsed by default (no hunk rows)", () => {
    const entries = [outlineEntry({ name: "foo", change: "added" }), outlineEntry({ name: "bar", change: "signature" })];
    const file = analyzedFile({ path: "a.ts", outline: entries });
    const rows = buildStreamRows({ split: false, composer: null, files: [baseFileInput({ file, level: "declarations" })] });
    const declRows = rows.filter((r) => r.type === "decl");
    expect(declRows).toHaveLength(2);
    expect(declRows[0]).toMatchObject({ entry: entries[0], index: 0, expanded: false });
    expect(declRows[1]).toMatchObject({ entry: entries[1], index: 1, expanded: false });
    expect(rows.some((r) => r.type === "hunkHeader" || r.type === "line")).toBe(false);
  });

  it("drills down into only the hunks overlapping a pressed declaration's range", () => {
    const entries = [outlineEntry({ name: "foo", newStart: 1, newEnd: 2 }), outlineEntry({ name: "bar", newStart: 10, newEnd: 10 })];
    const file = analyzedFile({ path: "a.ts", outline: entries });
    const diff = fileDiff({
      path: "a.ts",
      hunks: [hunk({ lines: [ctx(1, 1), del(2), add(2), ctx(3, 3)] }), hunk({ lines: [ctx(10, 10)], oldStart: 10, newStart: 10 })],
    });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "declarations", diff, expandedDecls: new Set([0]) })],
    });
    expect(rows.some((r) => r.type === "hunkHeader" && r.hunkIndex === 0)).toBe(true);
    expect(rows.some((r) => r.type === "hunkHeader" && r.hunkIndex === 1)).toBe(false);
    const lineRows = rows.filter((r) => r.type === "line");
    expect(lineRows).toHaveLength(4); // ctx(1,1), del(2), add(2), ctx(3,3) — hunk 0's lines only
    expect(lineRows.every((r) => r.key.startsWith("decl:a.ts:0:"))).toBe(true);
  });

  it("keeps row keys unique when two declarations drill into the same shared hunk", () => {
    const entries = [outlineEntry({ name: "foo", newStart: 1, newEnd: 3 }), outlineEntry({ name: "bar", newStart: 2, newEnd: 3 })];
    const file = analyzedFile({ path: "a.ts", outline: entries });
    const diff = fileDiff({ path: "a.ts", hunks: [hunk({ lines: [ctx(1, 1), del(2), add(2), ctx(3, 3)] })] });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "declarations", diff, expandedDecls: new Set([0, 1]) })],
    });
    const hunkHeaders = rows.filter((r) => r.type === "hunkHeader");
    expect(hunkHeaders).toHaveLength(2); // the shared hunk, once per decl
    expect(new Set(hunkHeaders.map((r) => r.key)).size).toBe(2);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate keys anywhere in the file's rows
  });

  it("places thread/draft/finding/composer attachments under every decl whose drill-down covers that line, with decl-prefixed keys", () => {
    const entries = [outlineEntry({ name: "foo", newStart: 1, newEnd: 3 }), outlineEntry({ name: "bar", newStart: 2, newEnd: 3 })];
    const file = analyzedFile({ path: "a.ts", outline: entries });
    const diff = fileDiff({ path: "a.ts", hunks: [hunk({ lines: [ctx(1, 1), del(2), add(2), ctx(3, 3)] })] });
    const t = thread({ id: "t1", path: "a.ts", diffSide: "RIGHT", line: 2 });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "declarations", diff, expandedDecls: new Set([0, 1]), threads: [t] })],
    });
    const threadRows = rows.filter((r) => r.type === "thread");
    expect(threadRows).toHaveLength(2);
    expect(threadRows.map((r) => r.key)).toEqual(["decl:a.ts:0:a.ts:thread:t1", "decl:a.ts:1:a.ts:thread:t1"]);
  });

  it("shows a loading row under a drilled-down decl while the file's diff is still fetching", () => {
    const entries = [outlineEntry({ name: "foo" })];
    const file = analyzedFile({ path: "a.ts", outline: entries });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "declarations", diffStatus: "loading", diff: null, expandedDecls: new Set([0]) })],
    });
    expect(rows.filter((r) => r.type === "loading")).toHaveLength(1);
  });

  it("shows a danger error row under a drilled-down decl when the diff query failed", () => {
    const entries = [outlineEntry({ name: "foo" })];
    const file = analyzedFile({ path: "a.ts", outline: entries });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "declarations", diffStatus: "error", diffErrorMessage: "boom", expandedDecls: new Set([0]) })],
    });
    expect(rows.find((r) => r.type === "error")).toMatchObject({ tone: "danger", message: "boom" });
  });

  it("shows a muted notice under a drilled-down decl when nothing overlaps its range", () => {
    const entries = [outlineEntry({ name: "foo", newStart: 100, newEnd: 101 })];
    const file = analyzedFile({ path: "a.ts", outline: entries });
    const diff = fileDiff({ path: "a.ts", hunks: [hunk({ lines: [ctx(1, 1)] })] });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file, level: "declarations", diff, expandedDecls: new Set([0]) })],
    });
    expect(rows.find((r) => r.type === "error")).toMatchObject({ tone: "muted", message: "No changed lines in this range." });
  });
});

describe("fileEnd row", () => {
  it("appears after a Code-level file's content, carrying the file for its +/- display", () => {
    const file = analyzedFile({ path: "a.ts", additions: 3, deletions: 1 });
    const diff = fileDiff({ path: "a.ts", hunks: [hunk({ lines: [ctx(1, 1)] })] });
    const rows = buildStreamRows({ split: false, composer: null, files: [baseFileInput({ file, level: "code", diff })] });
    expect(rows[rows.length - 1]).toMatchObject({ type: "fileEnd", path: "a.ts", file });
  });

  it("appears after a Declarations-level file's content too", () => {
    const file = analyzedFile({ path: "a.ts", outline: null });
    const rows = buildStreamRows({ split: false, composer: null, files: [baseFileInput({ file, level: "declarations" })] });
    expect(rows[rows.length - 1]).toMatchObject({ type: "fileEnd", path: "a.ts" });
  });

  it("is omitted entirely for a Files-level (collapsed) file", () => {
    const file = analyzedFile({ path: "a.ts" });
    const rows = buildStreamRows({ split: false, composer: null, files: [baseFileInput({ file, level: "files" })] });
    expect(rows).toHaveLength(1); // just the fileHeader
    expect(rows.some((r) => r.type === "fileEnd")).toBe(false);
  });
});

describe("file boundary rail", () => {
  it("alternates by the file's position among the visible files, independent of level", () => {
    const fileA = analyzedFile({ path: "a.ts" });
    const fileB = analyzedFile({ path: "b.ts" });
    const fileC = analyzedFile({ path: "c.ts" });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [
        baseFileInput({ file: fileA, level: "files" }),
        baseFileInput({ file: fileB, level: "declarations" }),
        baseFileInput({ file: fileC, level: "files" }),
      ],
    });
    expect(rows.filter((r) => r.path === "a.ts").every((r) => rail(r) === 0)).toBe(true);
    expect(rows.filter((r) => r.path === "b.ts").every((r) => rail(r) === 1)).toBe(true);
    expect(rows.filter((r) => r.path === "c.ts").every((r) => rail(r) === 0)).toBe(true);
  });

  it("gives every row belonging to a file the same rail, including its fileEnd row", () => {
    const other = analyzedFile({ path: "a-earlier.ts" });
    const file = analyzedFile({ path: "b.ts" });
    const diff = fileDiff({ path: "b.ts", hunks: [hunk({ lines: [ctx(1, 1)] })] });
    const rows = buildStreamRows({
      split: false,
      composer: null,
      files: [baseFileInput({ file: other, level: "files" }), baseFileInput({ file, level: "code", diff })],
    });
    const bRows = rows.filter((r) => r.path === "b.ts");
    expect(bRows.length).toBeGreaterThan(1);
    expect(bRows.every((r) => rail(r) === 1)).toBe(true);
  });
});
