import { describe, expect, it } from "vitest";
import { annotateMovesAndWhitespace, parseNumstat, parseUnifiedDiff } from "../server/analysis/diff";
import { classifyHeuristic, globToRegExp, UnsafeGlobError } from "../server/analysis/modules";
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

  // A3 regression: git always C-quotes a path containing a literal `"` or `\`, regardless of
  // core.quotepath. Before the fix this fell through every path regex and produced "unknown".
  it("un-quotes a C-quoted path (A3)", () => {
    const raw = `diff --git "a/quo\\"te.txt" "b/quo\\"te.txt"
index ce01362..3b18e51 100644
--- "a/quo\\"te.txt"
+++ "b/quo\\"te.txt"
@@ -1 +1 @@
-hello
+hello world
`;
    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('quo"te.txt');
    expect(files[0].status).toBe("modified");
  });

  // A4 regression: a binary file (no `---`/`+++` lines to correct the guess) whose name
  // contains the literal substring " b/" used to split the ambiguous header line wrong and
  // get mislabeled "renamed" with garbage paths, which also made it look like a no-op
  // rename-only noise change — silently hiding a real binary content change.
  it("does not fabricate a rename for a binary file with an ambiguous ' b/' path (A4)", () => {
    const raw = `diff --git a/a b/weird.bin b/a b/weird.bin
index afc4e8f..01525fe 100644
Binary files a/a b/weird.bin and b/a b/weird.bin differ
`;
    const files = parseUnifiedDiff(raw);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe("modified");
    expect(files[0].binary).toBe(true);
  });

  // A4 regression: git appends a trailing tab to `---`/`+++` paths that contain a space.
  // Left in place, the path would never match GitHub's (untabbed) path for the same file,
  // breaking viewed-state sync and file-diff lookups for any file with a space in its name.
  it("strips the trailing tab git appends for a path containing a space (A4)", () => {
    const raw = `diff --git a/a b/text.txt b/a b/text.txt
index e5c5c55..59afb9d 100644
--- a/a b/text.txt\t
+++ b/a b/text.txt\t
@@ -1,2 +1,2 @@
 line one
-line two
+line two changed
`;
    const files = parseUnifiedDiff(raw);
    expect(files[0].path).toBe("a b/text.txt");
    expect(files[0].oldPath).toBeNull();
  });

  // A11 regression: a dropped (truncated-away) hunk must not still count toward
  // additions/deletions, or file-level stats disagree with what's actually in `hunks` (and
  // with what validators ever see).
  it("excludes truncated-away hunks from additions/deletions (A11)", () => {
    const bigHunkLines = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    const raw = `diff --git a/big.ts b/big.ts
index 111..222 100644
--- a/big.ts
+++ b/big.ts
@@ -0,0 +1,5000 @@
${bigHunkLines}
@@ -5000,1 +5001,1 @@
-old
+new
`;
    const files = parseUnifiedDiff(raw);
    expect(files[0].truncated).toBe(true);
    expect(files[0].hunks).toHaveLength(1);
    // Only the first (kept) hunk's lines should be counted.
    expect(files[0].additions).toBe(5000);
    expect(files[0].deletions).toBe(0);
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

  it("marks a same-file run of >=3 consecutive lines moved when the same text reappears elsewhere in the same file", () => {
    const longLineA = "function doSomethingUseful(arg) {";
    const longLineB = "  return computeTheRealAnswer(arg) + 1;";
    const longLineC = "  // closing comment line for the moved block";
    const raw = `diff --git a/src/same.ts b/src/same.ts
index 111..222 100644
--- a/src/same.ts
+++ b/src/same.ts
@@ -1,3 +0,0 @@
-${longLineA}
-${longLineB}
-${longLineC}
@@ -40,0 +38,3 @@
+${longLineA}
+${longLineB}
+${longLineC}
`;
    const files = parseUnifiedDiff(raw);
    annotateMovesAndWhitespace(files);
    const file = files[0];
    expect(file.hunks[0].lines.every((l) => l.moved)).toBe(true);
    expect(file.hunks[1].lines.every((l) => l.moved)).toBe(true);
    expect(file.movedLines).toBe(6);
    expect(file.effectiveLines).toBe(0);
  });

  // A6: cross-file matches now require a longer run (>=6) than same-file matches (>=3) as
  // extra evidence it's a genuine move and not two unrelated edits sharing a few lines.
  it("marks a cross-file run moved only when it is >=6 lines long (A6)", () => {
    const lines = Array.from({ length: 6 }, (_, i) => `  this is distinctive moved line number ${i} right here`);
    const raw = `diff --git a/src/old.ts b/src/old.ts
index 111..222 100644
--- a/src/old.ts
+++ b/src/old.ts
@@ -1,6 +0,0 @@
${lines.map((l) => `-${l}`).join("\n")}
diff --git a/src/new.ts b/src/new.ts
index 000..333 100644
--- a/src/new.ts
+++ b/src/new.ts
@@ -0,0 +1,6 @@
${lines.map((l) => `+${l}`).join("\n")}
`;
    const files = parseUnifiedDiff(raw);
    annotateMovesAndWhitespace(files);
    const oldFile = files.find((f) => f.path === "src/old.ts")!;
    const newFile = files.find((f) => f.path === "src/new.ts")!;
    expect(oldFile.hunks[0].lines.every((l) => l.moved)).toBe(true);
    expect(newFile.hunks[0].lines.every((l) => l.moved)).toBe(true);
    expect(oldFile.movedLines).toBe(6);
  });

  // A6 regression: this is the exact false-positive this was designed to fix — two unrelated
  // files independently touching the same short, common boilerplate (e.g. shared log lines)
  // must NOT be flagged as a move.
  it("does not mark a short (<6 line) cross-file match as moved — boilerplate false positive (A6)", () => {
    const raw = `diff --git a/src/fileA.ts b/src/fileA.ts
index 111..222 100644
--- a/src/fileA.ts
+++ b/src/fileA.ts
@@ -10,3 +10,0 @@
-  console.log("starting the retry loop now");
-  console.log("about to call the remote service");
-  console.log("finished calling the remote service");
diff --git a/src/fileB.ts b/src/fileB.ts
index 333..444 100644
--- a/src/fileB.ts
+++ b/src/fileB.ts
@@ -5,0 +5,3 @@
+  console.log("starting the retry loop now");
+  console.log("about to call the remote service");
+  console.log("finished calling the remote service");
`;
    const files = parseUnifiedDiff(raw);
    annotateMovesAndWhitespace(files);
    const fileA = files.find((f) => f.path === "src/fileA.ts")!;
    const fileB = files.find((f) => f.path === "src/fileB.ts")!;
    expect(fileA.hunks[0].lines.every((l) => !l.moved)).toBe(true);
    expect(fileB.hunks[0].lines.every((l) => !l.moved)).toBe(true);
    expect(fileA.effectiveLines).toBe(3);
    expect(fileB.effectiveLines).toBe(3);
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

  // A5 regression: a hunk that is whitespace-only AND (because indentation-only del/add pairs
  // are trivially "moved" matches of each other) also moved must only be discounted once.
  // Before the fix, summing `movedLines + whitespaceLines` independently over-subtracted and
  // could zero out a genuinely unrelated real change elsewhere in the same file.
  it("does not double-count a line flagged both moved and whitespace-only (A5)", () => {
    const raw = `diff --git a/src/mixed.ts b/src/mixed.ts
index 111..222 100644
--- a/src/mixed.ts
+++ b/src/mixed.ts
@@ -1,4 +1,4 @@
 context before
-const totallyRealBehaviorChangeHere = computeSomethingDifferentNow();
+const totallyRealBehaviorChangeHere = computeSomethingDifferentNowFixed();
 context after
@@ -40,6 +40,6 @@
-  doFirstThing(arg);
-  doSecondThing(arg);
-  doThirdThing(arg);
+    doFirstThing(arg);
+    doSecondThing(arg);
+    doThirdThing(arg);
`;
    const files = parseUnifiedDiff(raw);
    annotateMovesAndWhitespace(files);
    const file = files[0];
    // additions=4, deletions=4 (total 8); hunk 2's 6 lines are pure noise (0 effective),
    // hunk 1's 2 lines (1 add + 1 del) are a genuine, non-noise change.
    expect(file.effectiveLines).toBe(2);
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

  // A1 regression: a glob translated naively into adjacent `[^/]*` wildcards is vulnerable to
  // catastrophic backtracking. Both the glob (`.paseo/review.yml`) and the path tested against
  // it (a PR file name) are attacker-controlled, so this must be rejected before compiling,
  // not merely "usually fast".
  it("rejects a glob with too many wildcards instead of compiling a catastrophically slow regex (A1)", () => {
    const evilGlob = Array.from({ length: 20 }, () => "a*").join("") + "b";
    expect(() => globToRegExp(evilGlob)).toThrow(UnsafeGlobError);
  });

  it("rejects an overly long glob", () => {
    expect(() => globToRegExp("a".repeat(500))).toThrow(UnsafeGlobError);
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

  // A1 regression: a malicious repo rule glob must not hang classification — it's skipped
  // (logged, not thrown) and the file falls through to the next heuristic.
  it("skips an unsafe repo-rule glob instead of hanging or throwing (A1)", () => {
    const evilGlob = Array.from({ length: 20 }, () => "a*").join("") + "b";
    const start = Date.now();
    const result = classifyHeuristic("src/weird/thing.xyz", emptyFile, [{ glob: evilGlob, module: "infra" }], [], DEFAULT_MODULES);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.moduleId).toBe("core");
  });
});
