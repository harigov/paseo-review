import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, type ParsedFile } from "../server/analysis/diff";
import { extractDeclarations } from "../server/analysis/outline/index";
import { computeOutlines, OUTLINE_MAX_BYTES, outlineLanguageOf, type ReadFile } from "../server/analysis/outline";
import { extractTypeScript } from "../server/analysis/outline/typescript";

function fakeReadFile(contents: Record<string, string>): ReadFile {
  return async (side, path) => {
    const key = `${side}:${path}`;
    return Object.prototype.hasOwnProperty.call(contents, key) ? contents[key] : null;
  };
}

function throwingReadFile(): ReadFile {
  return async () => {
    throw new Error("readFile must not be called for a skipped file");
  };
}

function makeFile(opts: {
  path: string;
  oldPath?: string | null;
  status?: ParsedFile["status"];
  binary?: boolean;
  hunks?: ParsedFile["hunks"];
}): ParsedFile {
  return {
    path: opts.path,
    oldPath: opts.oldPath ?? null,
    status: opts.status ?? "modified",
    binary: opts.binary ?? false,
    truncated: false,
    additions: 0,
    deletions: 0,
    hunks: opts.hunks ?? [],
    movedLines: 0,
    effectiveLines: 0,
  };
}

describe("outlineLanguageOf", () => {
  it("maps known extensions to a language id and unknown ones to null", () => {
    expect(outlineLanguageOf("src/a.ts")).toBe("typescript");
    expect(outlineLanguageOf("src/a.py")).toBe("python");
    expect(outlineLanguageOf("README.md")).toBeNull();
  });
});

describe("computeOutlines — TypeScript function changes", () => {
  it("categorises added/removed/modified/signature-changed top-level functions", async () => {
    const file = makeFile({ path: "src/funcs.ts" });
    const base = `export function removedFn() {
  return 1;
}

export function modifiedFn() {
  return 1;
}

export function sigFn(a) {
  return 1;
}
`;
    const head = `export function modifiedFn() {
  return 2;
}

export function sigFn(a, b) {
  return 1;
}

export function addedFn() {
  return 1;
}
`;
    const result = await computeOutlines([file], fakeReadFile({ "base:src/funcs.ts": base, "head:src/funcs.ts": head }));
    const entries = result.get("src/funcs.ts");
    expect(entries).not.toBeNull();

    const byName = new Map(entries!.map((e) => [e.name, e]));
    expect(byName.get("removedFn")?.change).toBe("removed");
    expect(byName.get("modifiedFn")?.change).toBe("modified");
    const sig = byName.get("sigFn");
    expect(sig?.change).toBe("signature");
    expect(sig?.oldSignature).toBe("export function sigFn(a) {");
    expect(sig?.signature).toBe("export function sigFn(a, b) {");
    expect(byName.get("addedFn")?.change).toBe("added");
  });
});

describe("computeOutlines — TypeScript class members", () => {
  it("qualifies member names and cascades exported from the container", async () => {
    const file = makeFile({ path: "src/service.ts", status: "added" });
    const head = `export class UserService {
  async create(name: string) {
    return name;
  }

  private helper() {
    return 1;
  }

  #priv() {
    return 2;
  }
}

class Internal {
  method() {
    return 1;
  }
}
`;
    const result = await computeOutlines([file], fakeReadFile({ "head:src/service.ts": head }));
    const entries = result.get("src/service.ts")!;
    const byName = new Map(entries.map((e) => [e.name, e]));

    expect(byName.get("UserService")?.kind).toBe("class");
    expect(byName.get("UserService")?.exported).toBe(true);
    expect(byName.get("UserService.create")?.kind).toBe("method");
    expect(byName.get("UserService.create")?.exported).toBe(true);
    expect(byName.get("UserService.helper")?.exported).toBe(false);
    expect(byName.get("UserService.#priv")?.exported).toBe(false);

    expect(byName.get("Internal")?.exported).toBe(false);
    // Member of a non-exported class is never exported, even though it has no private modifier.
    expect(byName.get("Internal.method")?.exported).toBe(false);
  });
});

describe("computeOutlines — rename within a file", () => {
  it("matches a renamed declaration by identical body and reports a counterpart in the same file", async () => {
    const file = makeFile({ path: "src/r.ts" });
    const base = `export function oldName(x) {
  const value = x * 3 + computeAnotherDistinctiveThing(x);
  return value;
}
`;
    const head = `export function newName(x) {
  const value = x * 3 + computeAnotherDistinctiveThing(x);
  return value;
}
`;
    const result = await computeOutlines([file], fakeReadFile({ "base:src/r.ts": base, "head:src/r.ts": head }));
    const entries = result.get("src/r.ts")!;
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("newName");
    expect(entries[0].change).toBe("renamed");
    expect(entries[0].counterpart).toEqual({ path: "src/r.ts", name: "oldName" });
  });
});

describe("computeOutlines — move across files", () => {
  it("reports a moved entry in both the source and destination file", async () => {
    const fileA = makeFile({ path: "src/a.ts", status: "modified" });
    const fileB = makeFile({ path: "src/b.ts", status: "added" });
    const sharedBody = `export function sharedFn(x) {
  const total = x * 2 + computeSomeDistinctiveValue(x);
  return total;
}
`;
    const contents = {
      "base:src/a.ts": sharedBody,
      "head:src/a.ts": `export function other() {\n  return 0;\n}\n`,
      "head:src/b.ts": sharedBody,
    };
    const result = await computeOutlines([fileA, fileB], fakeReadFile(contents));
    const entriesA = result.get("src/a.ts")!;
    const entriesB = result.get("src/b.ts")!;

    const movedInA = entriesA.find((e) => e.name === "sharedFn");
    expect(movedInA?.change).toBe("moved");
    expect(movedInA?.oldStart).not.toBeNull();
    expect(movedInA?.newStart).toBeNull();
    expect(movedInA?.counterpart).toEqual({ path: "src/b.ts", name: "sharedFn" });

    const movedInB = entriesB.find((e) => e.name === "sharedFn");
    expect(movedInB?.change).toBe("moved");
    expect(movedInB?.newStart).not.toBeNull();
    expect(movedInB?.oldStart).toBeNull();
    expect(movedInB?.counterpart).toEqual({ path: "src/a.ts", name: "sharedFn" });
  });
});

describe("computeOutlines — Python indentation nesting", () => {
  it("qualifies methods under their class and applies the leading-underscore export rule", async () => {
    const file = makeFile({ path: "src/helper.py", status: "added" });
    const head = `class Helper:
    def public_method(self):
        return 1

    def _private_method(self):
        return 2

def top_level():
    return 3
`;
    const result = await computeOutlines([file], fakeReadFile({ "head:src/helper.py": head }));
    const entries = result.get("src/helper.py")!;
    const byName = new Map(entries.map((e) => [e.name, e]));

    expect(byName.get("Helper")?.kind).toBe("class");
    expect(byName.get("Helper")?.exported).toBe(true);
    expect(byName.get("Helper.public_method")?.kind).toBe("method");
    expect(byName.get("Helper.public_method")?.exported).toBe(true);
    expect(byName.get("Helper._private_method")?.exported).toBe(false);
    expect(byName.get("top_level")?.kind).toBe("function");
    expect(byName.get("top_level")?.exported).toBe(true);
  });
});

describe("computeOutlines — Go exported-by-case", () => {
  it("derives exported from the identifier's first letter for funcs, methods and types", async () => {
    const file = makeFile({ path: "pkg/foo.go", status: "added" });
    const head = `package main

func Exported() {
}

func unexported() {
}

type Foo struct {
\tName string
}

func (f *Foo) Method() {
}

func (f *Foo) privateMethod() {
}
`;
    const result = await computeOutlines([file], fakeReadFile({ "head:pkg/foo.go": head }));
    const entries = result.get("pkg/foo.go")!;
    const byName = new Map(entries.map((e) => [e.name, e]));

    expect(byName.get("Exported")?.exported).toBe(true);
    expect(byName.get("unexported")?.exported).toBe(false);
    expect(byName.get("Foo")?.kind).toBe("struct");
    expect(byName.get("Foo")?.exported).toBe(true);
    expect(byName.get("Foo.Method")?.kind).toBe("method");
    expect(byName.get("Foo.Method")?.exported).toBe(true);
    expect(byName.get("Foo.privateMethod")?.exported).toBe(false);
  });
});

describe("computeOutlines — Rust impl methods", () => {
  it("qualifies fn members with the impl target and derives exported from pub", async () => {
    const file = makeFile({ path: "src/point.rs", status: "added" });
    const head = `pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub fn new(x: i32, y: i32) -> Point {
        Point { x, y }
    }

    fn helper(&self) -> i32 {
        self.x + self.y
    }
}
`;
    const result = await computeOutlines([file], fakeReadFile({ "head:src/point.rs": head }));
    const entries = result.get("src/point.rs")!;
    // "impl Point" intentionally shares its name with "struct Point" (per spec: impl's name is
    // just the implemented type's name), so disambiguate by kind rather than by a name map.
    const byName = new Map(entries.filter((e) => e.kind !== "impl").map((e) => [e.name, e]));

    expect(byName.get("Point")?.kind).toBe("struct");
    expect(byName.get("Point")?.exported).toBe(true);
    expect(entries.some((e) => e.kind === "impl" && e.name === "Point")).toBe(true);
    expect(byName.get("Point.new")?.kind).toBe("method");
    expect(byName.get("Point.new")?.exported).toBe(true);
    expect(byName.get("Point.helper")?.exported).toBe(false);
  });
});

describe("computeOutlines — skip rules", () => {
  it("skips a binary file without reading its contents", async () => {
    const file = makeFile({ path: "image.png", binary: true });
    const result = await computeOutlines([file], throwingReadFile());
    expect(result.get("image.png")).toBeNull();
  });

  it("skips a file with an unsupported extension without reading its contents", async () => {
    const file = makeFile({ path: "README.md", status: "added" });
    const result = await computeOutlines([file], throwingReadFile());
    expect(result.get("README.md")).toBeNull();
  });

  it("skips a file whose content exceeds OUTLINE_MAX_BYTES", async () => {
    const file = makeFile({ path: "src/big.ts", status: "added" });
    const huge = "a".repeat(OUTLINE_MAX_BYTES + 10);
    const result = await computeOutlines([file], fakeReadFile({ "head:src/big.ts": huge }));
    expect(result.get("src/big.ts")).toBeNull();
  });
});

describe("computeOutlines — changedLines", () => {
  it("counts add/del lines of the hunks that fall inside the entry's range", async () => {
    const raw = `diff --git a/src/calc.ts b/src/calc.ts
index 111..222 100644
--- a/src/calc.ts
+++ b/src/calc.ts
@@ -1,3 +1,3 @@
 export function calc(a, b) {
-  return a + b;
+  return a + b + 1;
 }
`;
    const [file] = parseUnifiedDiff(raw);
    const base = `export function calc(a, b) {
  return a + b;
}
`;
    const head = `export function calc(a, b) {
  return a + b + 1;
}
`;
    const result = await computeOutlines([file], fakeReadFile({ "base:src/calc.ts": base, "head:src/calc.ts": head }));
    const entries = result.get("src/calc.ts")!;
    const calc = entries.find((e) => e.name === "calc");
    expect(calc?.change).toBe("modified");
    expect(calc?.changedLines).toBe(2); // one del + one add line inside the function's range
  });
});

describe("computeOutlines — renamed file reads base at oldPath", () => {
  it("reads the base side at the file's oldPath, not its new path", async () => {
    const file = makeFile({ path: "new/path.ts", oldPath: "old/path.ts", status: "renamed" });
    const calls: Array<[string, string]> = [];
    const content = `export function foo() {\n  return 1;\n}\n`;
    const readFile: ReadFile = async (side, path) => {
      calls.push([side, path]);
      const key = `${side}:${path}`;
      const contents: Record<string, string> = { "base:old/path.ts": content, "head:new/path.ts": content };
      return Object.prototype.hasOwnProperty.call(contents, key) ? contents[key] : null;
    };
    const result = await computeOutlines([file], readFile);
    expect(result.get("new/path.ts")).not.toBeNull();
    expect(calls).toContainEqual(["base", "old/path.ts"]);
    expect(calls).toContainEqual(["head", "new/path.ts"]);
    expect(calls.some(([side, path]) => side === "base" && path === "new/path.ts")).toBe(false);
  });
});

describe("scanDeclarationEnd with parenthesised headers", () => {
  it("does not end a function at the closing brace of a destructured parameter object", async () => {
    const head = [
      "export function Panel({",
      "  title,",
      "  items,",
      "}: {",
      "  title: string;",
      "  items: string[];",
      "}) {",
      "  const count = items.length;",
      "  return count;",
      "}",
      "",
      "export function after() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const base = head.replace("  return count;", "  return count + 1;");
    const file = parseUnifiedDiff(
      [
        "diff --git a/src/panel.tsx b/src/panel.tsx",
        "index 111..222 100644",
        "--- a/src/panel.tsx",
        "+++ b/src/panel.tsx",
        "@@ -8,3 +8,3 @@",
        "   const count = items.length;",
        "-  return count + 1;",
        "+  return count;",
        " }",
        "",
      ].join("\n"),
    )[0];
    const contents = new Map<string, string>([["base:src/panel.tsx", base], ["head:src/panel.tsx", head]]);
    const out = await computeOutlines([file], async (side, path) => contents.get(`${side}:${path}`) ?? null);
    const entries = out.get("src/panel.tsx") ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("Panel");
    expect(entries[0].change).toBe("modified");
    expect(entries[0].newStart).toBe(1);
    expect(entries[0].newEnd).toBe(10);
    expect(entries[0].changedLines).toBe(2);
  });
});

describe("extractTypeScript — a brace before the body is not mistaken for it", () => {
  it("does not end a function at a brace inside an angle-bracketed return type", () => {
    const content = [
      "export async function f(): Promise<{ a: string }> {",
      "  const value = await load();",
      "  return value;",
      "}",
      "",
      "export function after() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const decls = extractTypeScript(content);
    const f = decls.find((d) => d.name === "f");
    const after = decls.find((d) => d.name === "after");
    expect(f?.startLine).toBe(1);
    expect(f?.endLine).toBe(4);
    expect(after?.startLine).toBe(6);
  });

  it("does not end a class at a brace inside a generic constraint, and still extracts its members", () => {
    const content = [
      "export class Foo<T extends { id: string }> {",
      "  bar() {}",
      "}",
      "",
      "export function after() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const decls = extractTypeScript(content);
    const foo = decls.find((d) => d.name === "Foo");
    const bar = decls.find((d) => d.name === "Foo.bar");
    const after = decls.find((d) => d.name === "after");
    expect(foo?.startLine).toBe(1);
    expect(foo?.endLine).toBe(3);
    expect(bar).toBeDefined();
    expect(after?.startLine).toBe(5);
  });

  it("does not end a function at the brace of a bare object-literal return type", () => {
    const content = [
      "function f(): { a: string } {",
      "  return { a: '1' };",
      "}",
      "",
      "function after() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const decls = extractTypeScript(content);
    const f = decls.find((d) => d.name === "f");
    const after = decls.find((d) => d.name === "after");
    expect(f?.startLine).toBe(1);
    expect(f?.endLine).toBe(3);
    expect(after?.startLine).toBe(5);
  });
});

describe("extractTypeScript — body-less arrow function without a trailing semicolon", () => {
  it("ends a semicolon-free arrow function declaration on its own line, in a semi:false codebase", () => {
    const content = ["export const inc = (a: number) => a + 1", "", "export function f() {", "  return 1;", "}", ""].join("\n");
    const decls = extractTypeScript(content);
    const inc = decls.find((d) => d.name === "inc");
    const f = decls.find((d) => d.name === "f");
    expect(inc?.startLine).toBe(1);
    expect(inc?.endLine).toBe(1);
    expect(f?.startLine).toBe(3);
    expect(f?.endLine).toBe(5);
  });
});

describe("computeOutlines — Python module-level statements between declarations", () => {
  it("does not fold a module-level statement into the preceding function's range", async () => {
    const file = makeFile({ path: "src/mod.py", status: "added" });
    const head = `def first():
    return 1

CONSTANT = 42

def second():
    return 2

if __name__ == "__main__":
    main()
`;
    const result = await computeOutlines([file], fakeReadFile({ "head:src/mod.py": head }));
    const entries = result.get("src/mod.py")!;
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("first")?.newStart).toBe(1);
    expect(byName.get("first")?.newEnd).toBe(2);
    expect(byName.get("second")?.newStart).toBe(6);
    expect(byName.get("second")?.newEnd).toBe(7);
  });

  it("reports no entry for a module-level constant edited between two unchanged functions", async () => {
    const file = makeFile({ path: "src/mod2.py" });
    const base = `def first():
    return 1

CONSTANT = 42

def second():
    return 2
`;
    const head = `def first():
    return 1

CONSTANT = 43

def second():
    return 2
`;
    const result = await computeOutlines([file], fakeReadFile({ "base:src/mod2.py": base, "head:src/mod2.py": head }));
    expect(result.get("src/mod2.py")).toHaveLength(0);
  });
});

describe("computeOutlines — Ruby trailing module-level statement after a class", () => {
  it("ends the class at its own `end`, excluding a trailing module-level statement", async () => {
    const file = makeFile({ path: "src/greeter.rb", status: "added" });
    const head = `class Greeter
  def hello
    puts "hi"
  end

  def bye
    puts "bye"
  end
end

VERSION = "1.0"
`;
    const result = await computeOutlines([file], fakeReadFile({ "head:src/greeter.rb": head }));
    const entries = result.get("src/greeter.rb")!;
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("Greeter")?.newStart).toBe(1);
    expect(byName.get("Greeter")?.newEnd).toBe(9);
    expect(byName.get("Greeter.hello")?.newStart).toBe(2);
    expect(byName.get("Greeter.hello")?.newEnd).toBe(4);
    expect(byName.get("Greeter.bye")?.newStart).toBe(6);
    expect(byName.get("Greeter.bye")?.newEnd).toBe(8);
  });
});

describe("computeOutlines — changedLines counts deletions against the old range", () => {
  it("counts a deletion inside a function shifted by unrelated insertions above it", async () => {
    const fillerCount = 100;
    const filler = Array.from({ length: fillerCount }, (_, idx) => `// filler ${idx + 1}`);

    const base = [
      "function target() {",
      "  line1;",
      "  line2;",
      "  line3;",
      "  return 1;",
      "}",
      "",
      "function neighbour() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");

    const head = [...filler, "function target() {", "  return 1;", "}", "", "function neighbour() {", "  return 2;", "}", ""].join("\n");

    const hunkLines = [
      ...filler.map((l) => `+${l}`),
      " function target() {",
      "-  line1;",
      "-  line2;",
      "-  line3;",
      "   return 1;",
      " }",
      " ",
      " function neighbour() {",
      "   return 2;",
      " }",
    ];
    const raw = [
      "diff --git a/src/shift.ts b/src/shift.ts",
      "index 111..222 100644",
      "--- a/src/shift.ts",
      "+++ b/src/shift.ts",
      `@@ -1,10 +1,${fillerCount + 7} @@`,
      ...hunkLines,
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(raw);
    const result = await computeOutlines([file], fakeReadFile({ "base:src/shift.ts": base, "head:src/shift.ts": head }));
    const entries = result.get("src/shift.ts")!;
    const target = entries.find((e) => e.name === "target");
    const neighbour = entries.find((e) => e.name === "neighbour");

    expect(target?.change).toBe("modified");
    expect(target?.changedLines).toBe(3);
    expect(neighbour).toBeUndefined(); // unchanged, and the shift/deletion must not leak into it
  });
});

describe("computeOutlines — rename matching scales to many declarations", () => {
  it("pairs up multiple renamed functions across two files", async () => {
    const fileA = makeFile({ path: "src/a.ts" });
    const fileB = makeFile({ path: "src/b.ts" });
    const baseA = `export function alpha(x) {
  const total = x * 11 + computeAlphaDistinctThing(x);
  return total;
}

export function beta(x) {
  const total = x * 13 + computeBetaDistinctThing(x);
  return total;
}
`;
    const headA = `export function alphaRenamed(x) {
  const total = x * 11 + computeAlphaDistinctThing(x);
  return total;
}

export function betaRenamed(x) {
  const total = x * 13 + computeBetaDistinctThing(x);
  return total;
}
`;
    const baseB = `export function gamma(x) {
  const total = x * 17 + computeGammaDistinctThing(x);
  return total;
}
`;
    const headB = `export function gammaRenamed(x) {
  const total = x * 17 + computeGammaDistinctThing(x);
  return total;
}
`;
    const result = await computeOutlines(
      [fileA, fileB],
      fakeReadFile({
        "base:src/a.ts": baseA,
        "head:src/a.ts": headA,
        "base:src/b.ts": baseB,
        "head:src/b.ts": headB,
      }),
    );
    const entriesA = result.get("src/a.ts")!;
    const entriesB = result.get("src/b.ts")!;

    const alphaEntry = entriesA.find((e) => e.name === "alphaRenamed");
    const betaEntry = entriesA.find((e) => e.name === "betaRenamed");
    const gammaEntry = entriesB.find((e) => e.name === "gammaRenamed");

    expect(alphaEntry?.change).toBe("renamed");
    expect(alphaEntry?.counterpart).toEqual({ path: "src/a.ts", name: "alpha" });
    expect(betaEntry?.change).toBe("renamed");
    expect(betaEntry?.counterpart).toEqual({ path: "src/a.ts", name: "beta" });
    expect(gammaEntry?.change).toBe("renamed");
    expect(gammaEntry?.counterpart).toEqual({ path: "src/b.ts", name: "gamma" });
  });
});

describe("scanDeclarationEnd with regex literals", () => {
  it("does not mistake // or quotes inside a regex literal for a comment or string", () => {
    const content = [
      "function resolveHref(href: string): string | null {",
      "  const trimmed = href.trim();",
      '  if (/^https:\\/\\//i.test(trimmed)) return trimmed;',
      "  const quoted = /\"[^\"]*\"/.test(trimmed);",
      '  if (trimmed.startsWith("/")) return `https://github.com${trimmed}`;',
      "  return quoted ? null : trimmed;",
      "}",
      "",
      "export function after(a: number) {",
      "  return a + 1;",
      "}",
      "",
    ].join("\n");
    const decls = extractDeclarations("typescript", content);
    expect(decls.map((d) => [d.name, d.startLine, d.endLine])).toEqual([
      ["resolveHref", 1, 7],
      ["after", 9, 11],
    ]);
  });
});
