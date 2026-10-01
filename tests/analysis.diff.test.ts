import { describe, expect, it } from "vitest";
import { annotateMovesAndWhitespace, parseNumstat, parseUnifiedDiff } from "../server/analysis/diff";
import { classifyHeuristic, globToRegExp } from "../server/analysis/modules";
import { DEFAULT_MODULES } from "../server/analysis/modules";

const SIMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 context line
-const removed = 1;
+const added = 1;
 trailing context
`;

describe("parseUnifiedDiff", () => {
  it("parses a single-file hunk into add/del/context lines", () => {
    const files = parseUnifiedDiff(SIMPLE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/foo.ts");
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
    expect(files[0].hunks).toHaveLength(1);
    const kinds = files[0].hunks[0].lines.map((l) => l.kind);
    expect(kinds).toEqual(["context", "del", "add", "context"]);
  });

  it("detects a rename with no content change", () => {
    const raw = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;
    const files = parseUnifiedDiff(raw);
    expect(files[0].status).toBe("renamed");
    expect(files[0].oldPath).toBe("old.ts");
    expect(files[0].path).toBe("new.ts");
    expect(files[0].hunks).toHaveLength(0);
  });

  it("detects binary files", () => {
    const raw = `diff --git a/image.png b/image.png
index 111..222 100644
Binary files a/image.png and b/image.png differ
`;
    const files = parseUnifiedDiff(raw);
    expect(files[0].binary).toBe(true);
  });
});

describe("annotateMovesAndWhitespace", () => {
  it("marks a whitespace-only hunk and its lines", () => {
    const raw = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-  const a = 1;
-  const b = 2;
+    const a = 1;
+    const b = 2;
`;
    const files = parseUnifiedDiff(raw);
    annotateMovesAndWhitespace(files);
    expect(files[0].hunks[0].whitespaceOnly).toBe(true);
    expect(files[0].effectiveLines).toBe(0);
  });

  it("marks a run of >=3 consecutive lines moved when the same text reappears on the opposite side", () => {
    const longLineA = "function doSomethingUseful(arg) {";
    const longLineB = "  return computeTheRealAnswer(arg) + 1;";
    const longLineC = "  // closing comment line for the moved block";
    const raw = `diff --git a/src/old.ts b/src/old.ts
index 111..222 100644
--- a/src/old.ts
+++ b/src/old.ts
@@ -1,3 +0,0 @@
-${longLineA}
-${longLineB}
-${longLineC}
diff --git a/src/new.ts b/src/new.ts
index 000..333 100644
--- a/src/new.ts
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+${longLineA}
+${longLineB}
+${longLineC}
`;
    const files = parseUnifiedDiff(raw);
    annotateMovesAndWhitespace(files);
    const oldFile = files.find((f) => f.path === "src/old.ts")!;
    const newFile = files.find((f) => f.path === "src/new.ts")!;
    expect(oldFile.hunks[0].lines.every((l) => l.moved)).toBe(true);
    expect(newFile.hunks[0].lines.every((l) => l.moved)).toBe(true);
    expect(oldFile.hunks[0].pureMove).toBe(true);
    expect(oldFile.movedLines).toBe(3);
    expect(oldFile.effectiveLines).toBe(0);
  });

  it("does not mark short runs (<3 lines) as moved even if text matches", () => {
    const raw = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,2 +1,2 @@
-this line is long enough to qualify one
-this line is long enough to qualify two
+this line is long enough to qualify one
+this line is long enough to qualify two
`;
    // Same two lines on both sides of the SAME hunk (not whitespace-only since content differs by kind only,
    // but here content is identical so whitespace-only also triggers; use distinct check: moved requires >=3 run.
    const files = parseUnifiedDiff(raw);
    annotateMovesAndWhitespace(files);
    // Only 2 consecutive lines per side -> not enough for a moved run.
    expect(files[0].hunks[0].lines.filter((l) => l.kind !== "context").every((l) => !l.moved)).toBe(true);
  });
});

describe("parseNumstat", () => {
  it("parses plain and rename lines", () => {
    const rows = parseNumstat("3\t1\tsrc/a.ts\n0\t0\t{old => new}/b.ts\n-\t-\timg.png\n");
    expect(rows[0]).toMatchObject({ path: "src/a.ts", additions: 3, deletions: 1 });
    expect(rows[1]).toMatchObject({ path: "new/b.ts", oldPath: "old/b.ts" });
    expect(rows[2]).toMatchObject({ path: "img.png", binary: true });
  });
});

describe("globToRegExp", () => {
  it("translates **, * and ? into an anchored regex", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/b.ts")).toBe(true);
    expect(globToRegExp("file?.ts").test("file1.ts")).toBe(true);
    expect(globToRegExp("file?.ts").test("file12.ts")).toBe(false);
  });
});

describe("classifyHeuristic", () => {
  const emptyFile = { path: "", oldPath: null, status: "modified" as const, binary: false, truncated: false, additions: 1, deletions: 0, hunks: [], movedLines: 0, effectiveLines: 1 };

  it("classifies lockfiles as noise", () => {
    const result = classifyHeuristic("package-lock.json", emptyFile, [], [], DEFAULT_MODULES);
    expect(result.moduleId).toBe("noise");
  });

  it("classifies test files", () => {
    const result = classifyHeuristic("src/__tests__/foo.test.ts", emptyFile, [], [], DEFAULT_MODULES);
    expect(result.moduleId).toBe("tests");
  });

  it("falls back to core with no confidence for unmatched files", () => {
    const result = classifyHeuristic("src/weird/thing.xyz", emptyFile, [], [], DEFAULT_MODULES);
    expect(result.moduleId).toBe("core");
    expect(result.source).toBe("fallback");
  });

  it("repo rules take precedence over heuristics", () => {
    const result = classifyHeuristic("package-lock.json", emptyFile, [{ glob: "package-lock.json", module: "infra" }], [], DEFAULT_MODULES);
    expect(result.moduleId).toBe("infra");
  });
});
