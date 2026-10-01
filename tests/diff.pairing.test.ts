import { describe, expect, it } from "vitest";
import { pairHunkLines, splitRowCount } from "../client/diff/pairing";
import type { DiffLine } from "../shared/types";

function ctx(oldNo: number, newNo: number): DiffLine {
  return { kind: "context", oldNo, newNo, text: `ctx ${oldNo}`, moved: false, whitespaceOnly: false };
}
function del(oldNo: number): DiffLine {
  return { kind: "del", oldNo, newNo: null, text: `del ${oldNo}`, moved: false, whitespaceOnly: false };
}
function add(newNo: number): DiffLine {
  return { kind: "add", oldNo: null, newNo, text: `add ${newNo}`, moved: false, whitespaceOnly: false };
}

describe("pairHunkLines", () => {
  it("pairs pure context with matching old/new indexes", () => {
    const lines = [ctx(1, 1), ctx(2, 2), ctx(3, 3)];
    expect(pairHunkLines(lines)).toEqual([
      { oldIndex: 0, newIndex: 0 },
      { oldIndex: 1, newIndex: 1 },
      { oldIndex: 2, newIndex: 2 },
    ]);
  });

  it("pairs an equal-length del/add run positionally", () => {
    const lines = [del(1), del(2), add(1), add(2)];
    expect(pairHunkLines(lines)).toEqual([
      { oldIndex: 0, newIndex: 2 },
      { oldIndex: 1, newIndex: 3 },
    ]);
  });

  it("pairs more dels than adds, leaving trailing dels with a null new side", () => {
    const lines = [del(1), del(2), del(3), add(1)];
    expect(pairHunkLines(lines)).toEqual([
      { oldIndex: 0, newIndex: 3 },
      { oldIndex: 1, newIndex: null },
      { oldIndex: 2, newIndex: null },
    ]);
  });

  it("pairs more adds than dels, leaving trailing adds with a null old side", () => {
    const lines = [del(1), add(1), add(2), add(3)];
    expect(pairHunkLines(lines)).toEqual([
      { oldIndex: 0, newIndex: 1 },
      { oldIndex: null, newIndex: 2 },
      { oldIndex: null, newIndex: 3 },
    ]);
  });

  it("pairs an add-only run (no preceding dels) entirely with a null old side", () => {
    const lines = [add(1), add(2)];
    expect(pairHunkLines(lines)).toEqual([
      { oldIndex: null, newIndex: 0 },
      { oldIndex: null, newIndex: 1 },
    ]);
  });

  it("pairs a del-only run (no following adds) entirely with a null new side", () => {
    const lines = [del(1), del(2)];
    expect(pairHunkLines(lines)).toEqual([
      { oldIndex: 0, newIndex: null },
      { oldIndex: 1, newIndex: null },
    ]);
  });

  it("pairs alternating del/add blocks independently", () => {
    const lines = [del(1), add(1), add(2), del(2), del(3), add(3)];
    // Block 1: del[0] (index 0) + add[0],add[1] (indexes 1,2) -> runLength 2
    // Block 2: del[1],del[2] (indexes 3,4) + add[2] (index 5) -> runLength 2
    expect(pairHunkLines(lines)).toEqual([
      { oldIndex: 0, newIndex: 1 },
      { oldIndex: null, newIndex: 2 },
      { oldIndex: 3, newIndex: 5 },
      { oldIndex: 4, newIndex: null },
    ]);
  });

  it("ends a del/add pairing at a context line instead of folding across it", () => {
    const lines = [del(1), add(1), ctx(2, 2), del(3), add(3)];
    expect(pairHunkLines(lines)).toEqual([
      { oldIndex: 0, newIndex: 1 },
      { oldIndex: 2, newIndex: 2 },
      { oldIndex: 3, newIndex: 4 },
    ]);
  });

  it("returns an empty pairing for an empty hunk", () => {
    expect(pairHunkLines([])).toEqual([]);
  });
});

describe("splitRowCount", () => {
  it("matches the length of pairHunkLines", () => {
    const lines = [ctx(1, 1), del(2), del(3), add(2)];
    expect(splitRowCount(lines)).toBe(pairHunkLines(lines).length);
    expect(splitRowCount(lines)).toBe(3);
  });
});
