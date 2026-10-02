import { describe, expect, it } from "vitest";
import { moveCursor, nextFileIndex, nextFileWithUnresolved, nextHunkIndex, nextUnresolvedIndex, nextUnviewedPath } from "../client/diff/keyboard";
import type { UnresolvedFindingLike } from "../client/diff/keyboard";
import type { Row } from "../client/diff/rows";
import type { Thread } from "../shared/types";

function thread(partial: Partial<Thread> & { id: string; path: string }): Thread {
  return { line: null, originalLine: null, diffSide: "RIGHT", isResolved: false, isOutdated: false, comments: [], triage: null, triageProbability: null, ...partial };
}

// A hand-built stream: two expanded files (a.ts with two hunks, an open thread and a failing
// finding; c.ts with one hunk) around a collapsed file (b.ts).
const rows: Row[] = [
  { type: "fileHeader", key: "fh:a", path: "a.ts", file: {} as never, expanded: true, viewed: "UNVIEWED", outlineSummary: "" }, // 0
  { type: "fileMeta", key: "fm:a", path: "a.ts", file: {} as never, viewed: "UNVIEWED", sinceViewedHighlighted: false }, // 1
  { type: "hunkHeader", key: "hh:a:0", path: "a.ts", hunkIndex: 0, context: "", newStart: 1, newEnd: 2 }, // 2
  { type: "line", key: "l:a:0:0", path: "a.ts", hunkIndex: 0, lineIndex: 0 }, // 3
  { type: "line", key: "l:a:0:1", path: "a.ts", hunkIndex: 0, lineIndex: 1 }, // 4
  { type: "thread", key: "t:1", path: "a.ts", thread: thread({ id: "t1", path: "a.ts", isResolved: false }) }, // 5
  { type: "line", key: "l:a:0:2", path: "a.ts", hunkIndex: 0, lineIndex: 2 }, // 6
  { type: "hunkHeader", key: "hh:a:1", path: "a.ts", hunkIndex: 1, context: "", newStart: 10, newEnd: 11 }, // 7
  { type: "line", key: "l:a:1:0", path: "a.ts", hunkIndex: 1, lineIndex: 0 }, // 8
  {
    type: "finding",
    key: "f:1",
    path: "a.ts",
    finding: { unitKey: "u1", path: "a.ts", startLine: 10, endLine: 10, probability: 0.9, status: "fail", dismissed: false, excerpt: "", validatorId: "v1", validatorTitle: "V" },
  }, // 9
  { type: "fileHeader", key: "fh:b", path: "b.ts", file: {} as never, expanded: false, viewed: "VIEWED", outlineSummary: "" }, // 10
  { type: "fileHeader", key: "fh:c", path: "c.ts", file: {} as never, expanded: true, viewed: "UNVIEWED", outlineSummary: "" }, // 11
  { type: "hunkHeader", key: "hh:c:0", path: "c.ts", hunkIndex: 0, context: "", newStart: 1, newEnd: 1 }, // 12
  { type: "line", key: "l:c:0:0", path: "c.ts", hunkIndex: 0, lineIndex: 0 }, // 13
];

describe("nextFileIndex", () => {
  it("finds the next fileHeader row after the current path", () => {
    expect(nextFileIndex(rows, "a.ts", 1)).toBe(10);
    expect(nextFileIndex(rows, "b.ts", 1)).toBe(11);
  });

  it("finds the previous fileHeader row before the current path", () => {
    expect(nextFileIndex(rows, "c.ts", -1)).toBe(10);
    expect(nextFileIndex(rows, "b.ts", -1)).toBe(0);
  });

  it("returns null when there is no next/previous file (no wraparound)", () => {
    expect(nextFileIndex(rows, "c.ts", 1)).toBeNull();
    expect(nextFileIndex(rows, "a.ts", -1)).toBeNull();
  });

  it("treats a null or unknown current path as before the first file", () => {
    expect(nextFileIndex(rows, null, 1)).toBe(0);
    expect(nextFileIndex(rows, null, -1)).toBeNull();
    expect(nextFileIndex(rows, "missing.ts", 1)).toBe(0);
  });
});

describe("nextHunkIndex", () => {
  it("finds the next hunk header after the cursor, across file boundaries", () => {
    expect(nextHunkIndex(rows, 2, 1)).toBe(7);
    expect(nextHunkIndex(rows, 7, 1)).toBe(12);
    expect(nextHunkIndex(rows, 12, 1)).toBeNull();
  });

  it("finds the previous hunk header before the cursor", () => {
    expect(nextHunkIndex(rows, 12, -1)).toBe(7);
    expect(nextHunkIndex(rows, 7, -1)).toBe(2);
    expect(nextHunkIndex(rows, 2, -1)).toBeNull();
  });

  it("starts from the beginning when the cursor is null", () => {
    expect(nextHunkIndex(rows, null, 1)).toBe(2);
    expect(nextHunkIndex(rows, null, -1)).toBeNull();
  });
});

describe("nextUnresolvedIndex", () => {
  it("finds the next open thread or failing finding row after the cursor", () => {
    expect(nextUnresolvedIndex(rows, 0)).toBe(5);
    expect(nextUnresolvedIndex(rows, 5)).toBe(9);
  });

  it("wraps around to the start when nothing matches after the cursor", () => {
    expect(nextUnresolvedIndex(rows, 9)).toBe(5);
    expect(nextUnresolvedIndex(rows, 13)).toBe(5);
  });

  it("returns null when there is no unresolved row anywhere", () => {
    const resolvedRows: Row[] = [
      { type: "thread", key: "t:1", path: "a.ts", thread: thread({ id: "t1", path: "a.ts", isResolved: true }) },
      {
        type: "finding",
        key: "f:1",
        path: "a.ts",
        finding: { unitKey: "u1", path: "a.ts", startLine: 1, endLine: 1, probability: 0.9, status: "fail", dismissed: true, excerpt: "", validatorId: "v1", validatorTitle: "V" },
      },
    ];
    expect(nextUnresolvedIndex(resolvedRows, null)).toBeNull();
  });
});

describe("moveCursor", () => {
  it("skips non-code rows, moving forward to the next line row", () => {
    expect(moveCursor(rows, null, 1)).toBe(3);
    expect(moveCursor(rows, 3, 1)).toBe(4);
    expect(moveCursor(rows, 4, 1)).toBe(6); // skips the thread row
    expect(moveCursor(rows, 6, 1)).toBe(8); // skips the hunk header
  });

  it("skips non-code rows, moving backward to the previous line row", () => {
    expect(moveCursor(rows, 13, -1)).toBe(8); // skips the hunk header and fileHeader
    expect(moveCursor(rows, 8, -1)).toBe(6); // skips the finding
    expect(moveCursor(rows, 3, -1)).toBeNull(); // nothing before the first line row
  });

  it("returns null when it reaches the end with no further code row", () => {
    expect(moveCursor(rows, 13, 1)).toBeNull();
  });
});

describe("nextUnviewedPath", () => {
  const files = [
    { path: "a.ts", viewed: "VIEWED" as const, order: { foundations: 0, risk: 2, chrono: 0 } },
    { path: "b.ts", viewed: "UNVIEWED" as const, order: { foundations: 1, risk: 1, chrono: 1 } },
    { path: "c.ts", viewed: "DISMISSED" as const, order: { foundations: 2, risk: 0, chrono: 2 } },
  ];

  it("finds the next not-fully-viewed file after afterPath, in reading order", () => {
    expect(nextUnviewedPath(files, "a.ts", "foundations")).toBe("b.ts");
    expect(nextUnviewedPath(files, "b.ts", "foundations")).toBe("c.ts");
  });

  it("treats DISMISSED as needing another look, same as UNVIEWED", () => {
    expect(nextUnviewedPath(files, "b.ts", "foundations")).toBe("c.ts");
  });

  it("wraps around to the start when nothing qualifies after afterPath", () => {
    expect(nextUnviewedPath(files, "c.ts", "foundations")).toBe("b.ts");
  });

  it("follows the given reading order, not file order", () => {
    // In "risk" order: c.ts (0), b.ts (1), a.ts (2) — starting after a.ts wraps straight to c.ts.
    expect(nextUnviewedPath(files, "a.ts", "risk")).toBe("c.ts");
  });

  it("starts from the beginning when afterPath is null or unknown", () => {
    expect(nextUnviewedPath(files, null, "foundations")).toBe("b.ts");
    expect(nextUnviewedPath(files, "missing.ts", "foundations")).toBe("b.ts");
  });

  it("returns null when every file is VIEWED", () => {
    const allViewed = files.map((f) => ({ ...f, viewed: "VIEWED" as const }));
    expect(nextUnviewedPath(allViewed, "a.ts", "foundations")).toBeNull();
  });
});

describe("nextFileWithUnresolved", () => {
  const files = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];
  const openThread = thread({ id: "t1", path: "b.ts", isResolved: false });
  const resolvedThread = thread({ id: "t2", path: "a.ts", isResolved: true });
  const failingFinding: UnresolvedFindingLike = { status: "fail", dismissed: false };
  const dismissedFinding: UnresolvedFindingLike = { status: "fail", dismissed: true };

  it("finds the next file (by position, not by path) with an open thread", () => {
    const threadsByPath = new Map([["b.ts", [openThread]]]);
    expect(nextFileWithUnresolved(files, threadsByPath, new Map(), "a.ts")).toBe("b.ts");
  });

  it("finds the next file with a failing, non-dismissed finding", () => {
    const findingsByPath = new Map([["c.ts", [failingFinding]]]);
    expect(nextFileWithUnresolved(files, new Map(), findingsByPath, "a.ts")).toBe("c.ts");
  });

  it("ignores resolved threads and dismissed (or merely uncertain) findings", () => {
    const threadsByPath = new Map([["a.ts", [resolvedThread]]]);
    const findingsByPath = new Map([
      ["b.ts", [dismissedFinding]],
      ["c.ts", [{ status: "uncertain", dismissed: false } as UnresolvedFindingLike]],
    ]);
    expect(nextFileWithUnresolved(files, threadsByPath, findingsByPath, null)).toBeNull();
  });

  it("wraps around to the start when nothing qualifies after afterPath", () => {
    const threadsByPath = new Map([["a.ts", [openThread]]]);
    expect(nextFileWithUnresolved(files, threadsByPath, new Map(), "b.ts")).toBe("a.ts");
  });

  it("starts from the beginning when afterPath is null or unknown", () => {
    const findingsByPath = new Map([["a.ts", [failingFinding]]]);
    expect(nextFileWithUnresolved(files, new Map(), findingsByPath, null)).toBe("a.ts");
    expect(nextFileWithUnresolved(files, new Map(), findingsByPath, "missing.ts")).toBe("a.ts");
  });

  it("returns null when nothing anywhere is unresolved", () => {
    expect(nextFileWithUnresolved(files, new Map(), new Map(), null)).toBeNull();
  });
});
