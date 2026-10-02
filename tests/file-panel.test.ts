import { describe, expect, it } from "vitest";
import {
  filterFilePanelItems,
  findFilePanelIndex,
  splitPath,
  statusLetter,
  statusTone,
  truncateHead,
} from "../client/review/file-panel-model";
import type { AnalyzedFile } from "../shared/types";

describe("statusLetter", () => {
  it("maps every AnalyzedFile status to its one-letter badge", () => {
    const cases: Array<[AnalyzedFile["status"], string]> = [
      ["added", "A"],
      ["modified", "M"],
      ["deleted", "D"],
      ["renamed", "R"],
      ["copied", "C"],
    ];
    for (const [status, letter] of cases) expect(statusLetter(status)).toBe(letter);
  });
});

describe("statusTone", () => {
  it("maps added to success, deleted to danger, renamed/copied to accent, modified to muted", () => {
    expect(statusTone("added")).toBe("success");
    expect(statusTone("deleted")).toBe("danger");
    expect(statusTone("renamed")).toBe("accent");
    expect(statusTone("copied")).toBe("accent");
    expect(statusTone("modified")).toBe("muted");
  });
});

describe("splitPath", () => {
  it("splits a nested path into dir and base", () => {
    expect(splitPath("client/review/FilePanel.tsx")).toEqual({ dir: "client/review", base: "FilePanel.tsx" });
  });

  it("returns an empty dir for a root-level file", () => {
    expect(splitPath("package.json")).toEqual({ dir: "", base: "package.json" });
  });

  it("handles a single-level directory", () => {
    expect(splitPath("shared/types.ts")).toEqual({ dir: "shared", base: "types.ts" });
  });

  it("treats a trailing slash as an empty basename rather than throwing", () => {
    expect(splitPath("a/b/")).toEqual({ dir: "a/b", base: "" });
  });
});

describe("truncateHead", () => {
  it("returns the text unchanged when at or under the limit", () => {
    expect(truncateHead("client/review", 20)).toBe("client/review");
    expect(truncateHead("exactly10c", 10)).toBe("exactly10c");
  });

  it("keeps the tail and prefixes an ellipsis when over the limit", () => {
    expect(truncateHead("a/very/long/path/to/some/deeply/nested/directory", 20)).toBe("…ly/nested/directory");
  });

  it("the truncated result (ellipsis + kept tail) is exactly maxChars long", () => {
    const result = truncateHead("a/very/long/path/to/some/deeply/nested/directory", 20);
    expect(result.length).toBe(20);
  });

  it("the kept tail is a suffix of the original text", () => {
    const text = "a/very/long/path/to/some/deeply/nested/directory";
    const result = truncateHead(text, 20);
    expect(text.endsWith(result.slice(1))).toBe(true);
  });

  it("returns a single ellipsis when maxChars is 1", () => {
    expect(truncateHead("anything", 1)).toBe("…");
  });

  it("returns an empty string when maxChars is 0 or negative", () => {
    expect(truncateHead("anything", 0)).toBe("");
    expect(truncateHead("anything", -5)).toBe("");
  });
});

describe("filterFilePanelItems", () => {
  const items = [{ path: "client/review/FilePanel.tsx" }, { path: "server/analysis/depth.ts" }, { path: "shared/levels.ts" }];

  it("returns every item for a blank query", () => {
    expect(filterFilePanelItems(items, "")).toEqual(items);
    expect(filterFilePanelItems(items, "   ")).toEqual(items);
  });

  it("matches a case-insensitive substring anywhere in the path", () => {
    expect(filterFilePanelItems(items, "ANALYSIS").map((i) => i.path)).toEqual(["server/analysis/depth.ts"]);
  });

  it("matches on the basename too, not just the directory", () => {
    expect(filterFilePanelItems(items, "levels").map((i) => i.path)).toEqual(["shared/levels.ts"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterFilePanelItems(items, "nonexistent")).toEqual([]);
  });

  it("returns a fresh array for a blank query, not the same reference", () => {
    const result = filterFilePanelItems(items, "");
    expect(result).not.toBe(items);
  });
});

describe("findFilePanelIndex", () => {
  const items = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];

  it("finds the matching index", () => {
    expect(findFilePanelIndex(items, "b.ts")).toBe(1);
  });

  it("returns -1 for a path that isn't present", () => {
    expect(findFilePanelIndex(items, "missing.ts")).toBe(-1);
  });

  it("returns -1 for a null path", () => {
    expect(findFilePanelIndex(items, null)).toBe(-1);
  });
});
