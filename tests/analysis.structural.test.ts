import { describe, expect, it } from "vitest";
import { computeStructuralDiff, lockfileFormat, structuralKindFor } from "../server/analysis/structural";
import type { StructuralEntry } from "../shared/types";

function byPath(entries: StructuralEntry[], path: string): StructuralEntry | undefined {
  return entries.find((e) => e.path === path);
}

describe("structuralKindFor / lockfileFormat", () => {
  it("recognizes known lockfiles by basename, case-insensitively", () => {
    expect(structuralKindFor("package-lock.json")).toBe("lockfile");
    expect(structuralKindFor("sub/dir/Gemfile.lock")).toBe("lockfile");
    expect(lockfileFormat("yarn.lock")).toBe("yarn");
    expect(lockfileFormat("Gemfile.lock")).toBe("bundler");
    expect(lockfileFormat("pnpm-lock.yaml")).toBe("pnpm");
    expect(lockfileFormat("go.sum")).toBe("go");
  });

  it("recognizes json and yaml by extension", () => {
    expect(structuralKindFor("config.JSON")).toBe("json");
    expect(structuralKindFor("config.yaml")).toBe("yaml");
    expect(structuralKindFor("config.yml")).toBe("yaml");
  });

  it("returns null for unsupported paths", () => {
    expect(structuralKindFor("README.md")).toBeNull();
    expect(lockfileFormat("package.json")).toBeNull();
  });
});

describe("JSON / YAML structural diff", () => {
  it("diffs added, removed and changed keys with dotted paths and line numbers", () => {
    const oldText = [
      "{",
      '  "name": "pkg",',
      '  "version": "1.0.0",',
      '  "license": "MIT",',
      '  "scripts": {',
      '    "build": "tsc"',
      "  }",
      "}",
      "",
    ].join("\n");
    const newText = [
      "{",
      '  "name": "pkg",',
      '  "version": "2.0.0",',
      '  "scripts": {',
      '    "build": "tsc",',
      '    "test": "vitest"',
      "  },",
      '  "author": "me"',
      "}",
      "",
    ].join("\n");

    const result = computeStructuralDiff("package.json", "json", oldText, newText);
    expect(result.error).toBeNull();
    expect(result.truncated).toBe(false);

    const version = byPath(result.entries, "version")!;
    expect(version).toMatchObject({ change: "changed", oldValue: '"1.0.0"', newValue: '"2.0.0"', oldLine: 3, newLine: 3 });

    const license = byPath(result.entries, "license")!;
    expect(license).toMatchObject({ change: "removed", oldValue: '"MIT"', newValue: null, oldLine: 4, newLine: null });

    const scriptsTest = byPath(result.entries, "scripts.test")!;
    expect(scriptsTest).toMatchObject({ change: "added", oldValue: null, newValue: '"vitest"', oldLine: null, newLine: 6 });

    const author = byPath(result.entries, "author")!;
    expect(author).toMatchObject({ change: "added", oldValue: null, newValue: '"me"', oldLine: null, newLine: 8 });

    // "name" is unchanged and "scripts" itself (a container present on both sides) is never emitted.
    expect(byPath(result.entries, "name")).toBeUndefined();
    expect(byPath(result.entries, "scripts")).toBeUndefined();
  });

  it("quotes keys containing dots, brackets or spaces", () => {
    const oldText = JSON.stringify({ normal: 1, "weird.key": 1, "has space": 1, "arr[idx]": 1, group: { "weird key": 1 } });
    const newText = JSON.stringify({ normal: 2, "weird.key": 2, "has space": 2, "arr[idx]": 2, group: { "weird key": 2 } });
    const result = computeStructuralDiff("data.json", "json", oldText, newText);
    expect(result.error).toBeNull();
    expect(byPath(result.entries, "normal")).toBeDefined();
    expect(byPath(result.entries, '["weird.key"]')).toBeDefined();
    expect(byPath(result.entries, '["has space"]')).toBeDefined();
    expect(byPath(result.entries, '["arr[idx]"]')).toBeDefined();
    expect(byPath(result.entries, 'group["weird key"]')).toBeDefined();
  });

  it("recurses into nested containers of the same kind without emitting the parent", () => {
    const oldText = JSON.stringify({ a: { b: { c: 1, keep: true } } });
    const newText = JSON.stringify({ a: { b: { c: 2, keep: true } } });
    const result = computeStructuralDiff("data.json", "json", oldText, newText);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ path: "a.b.c", change: "changed", oldValue: "1", newValue: "2" });
    expect(byPath(result.entries, "a")).toBeUndefined();
    expect(byPath(result.entries, "a.b")).toBeUndefined();
  });

  it("reports mixed scalar/container values and container-kind mismatches as changed, with summaries and no recursion", () => {
    const oldText = JSON.stringify({ config: { a: 1, b: 2 }, flag: true, obj: { a: 1 }, list: [1, 2, 3] });
    const newText = JSON.stringify({ config: "disabled", flag: { on: true }, obj: [1, 2], list: [1, 2] });
    const result = computeStructuralDiff("data.json", "json", oldText, newText);

    expect(byPath(result.entries, "config")).toMatchObject({ change: "changed", oldValue: "{2 keys}", newValue: '"disabled"' });
    expect(byPath(result.entries, "flag")).toMatchObject({ change: "changed", oldValue: "true", newValue: "{1 keys}" });
    expect(byPath(result.entries, "obj")).toMatchObject({ change: "changed", oldValue: "{1 keys}", newValue: "[2 items]" });
    // None of these recurse into their children.
    expect(byPath(result.entries, "config.a")).toBeUndefined();
    expect(byPath(result.entries, "flag.on")).toBeUndefined();
    expect(byPath(result.entries, "obj.a")).toBeUndefined();
    expect(byPath(result.entries, "obj[0]")).toBeUndefined();
    // list[2] (old only, tail removed) is the only array diff.
    expect(byPath(result.entries, "list[2]")).toMatchObject({ change: "removed", oldValue: "3" });
    expect(byPath(result.entries, "list[0]")).toBeUndefined();
    expect(byPath(result.entries, "list[1]")).toBeUndefined();
  });

  it("diffs arrays positionally", () => {
    const oldText = JSON.stringify({ items: ["a", "b", "c"] });
    const newText = JSON.stringify({ items: ["a", "x", "c", "d"] });
    const result = computeStructuralDiff("data.json", "json", oldText, newText);
    expect(result.entries).toHaveLength(2);
    expect(byPath(result.entries, "items[1]")).toMatchObject({ change: "changed", oldValue: '"b"', newValue: '"x"' });
    expect(byPath(result.entries, "items[3]")).toMatchObject({ change: "added", oldValue: null, newValue: '"d"' });
  });

  it("orders entries by new-side order, inserting removed keys after their last surviving neighbor", () => {
    const oldText = JSON.stringify({ a: 1, b: 1, c: 1, d: 1 });
    const newText = JSON.stringify({ a: 2, c: 2, e: 2 });
    const result = computeStructuralDiff("data.json", "json", oldText, newText);
    expect(result.entries.map((e) => e.path)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("places a removed key with no surviving predecessor at the very start", () => {
    const oldText = JSON.stringify({ z: 1, a: 1 });
    const newText = JSON.stringify({ a: 2 });
    const result = computeStructuralDiff("data.json", "json", oldText, newText);
    expect(result.entries.map((e) => e.path)).toEqual(["z", "a"]);
    expect(byPath(result.entries, "z")!.change).toBe("removed");
  });

  it("computes line numbers for a GitHub Actions-style workflow file", () => {
    const oldText = [
      "name: CI",
      "on:",
      "  push:",
      "    branches: [main]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v3",
      "      - run: npm test",
      "",
    ].join("\n");
    const newText = [
      "name: CI",
      "on:",
      "  push:",
      "    branches: [main, develop]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-22.04",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: npm test",
      "      - run: npm run lint",
      "",
    ].join("\n");

    const result = computeStructuralDiff(".github/workflows/ci.yml", "yaml", oldText, newText);
    expect(result.error).toBeNull();

    expect(byPath(result.entries, "on.push.branches[1]")).toMatchObject({ change: "added", newValue: '"develop"', newLine: 4 });
    expect(byPath(result.entries, "jobs.build.runs-on")).toMatchObject({
      change: "changed",
      oldValue: '"ubuntu-latest"',
      newValue: '"ubuntu-22.04"',
      oldLine: 7,
      newLine: 7,
    });
    expect(byPath(result.entries, "jobs.build.steps[0].uses")).toMatchObject({
      change: "changed",
      oldValue: '"actions/checkout@v3"',
      newValue: '"actions/checkout@v4"',
      oldLine: 9,
      newLine: 9,
    });
    // steps[1] (run: npm test) is unchanged on both sides, so it recurses to nothing.
    expect(byPath(result.entries, "jobs.build.steps[1]")).toBeUndefined();
    expect(byPath(result.entries, "jobs.build.steps[1].run")).toBeUndefined();
    // steps[2] only exists on the new side: one container-summary entry, not expanded.
    expect(byPath(result.entries, "jobs.build.steps[2]")).toMatchObject({ change: "added", newValue: "{1 keys}", newLine: 11 });
    expect(byPath(result.entries, "jobs.build.steps[2].run")).toBeUndefined();
  });

  it("falls back to JSON.parse (no line numbers) when the YAML parser errors on a .json file", () => {
    // Valid JSON (last key wins), but YAML treats a duplicate map key as an error.
    const oldText = '{"a": 1}';
    const newText = '{"a": 1, "a": 2, "b": 3}';
    const result = computeStructuralDiff("data.json", "json", oldText, newText);
    expect(result.error).toBeNull();
    const a = byPath(result.entries, "a")!;
    expect(a).toMatchObject({ change: "changed", oldValue: "1", newValue: "2", oldLine: 1, newLine: null });
    const b = byPath(result.entries, "b")!;
    expect(b).toMatchObject({ change: "added", newValue: "3", newLine: null });
  });

  it("returns an error and no entries on a genuine YAML parse failure", () => {
    const oldText = "key: 1\n";
    const newText = "key: [1, 2\n"; // unterminated flow sequence
    const result = computeStructuralDiff("config.yaml", "yaml", oldText, newText);
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("never throws, even when both sides are unparsable as JSON or YAML", () => {
    const oldText = "{not valid json or yaml: [";
    const newText = "{also not valid: [[[";
    expect(() => computeStructuralDiff("data.json", "json", oldText, newText)).not.toThrow();
    const result = computeStructuralDiff("data.json", "json", oldText, newText);
    expect(result.entries).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("reports one entry per top-level key for an entirely added file, without expanding containers", () => {
    const newText = ["{", '  "name": "demo",', '  "config": {', '    "x": 1', "  },", '  "list": [1, 2]', "}", ""].join("\n");
    const result = computeStructuralDiff("data.json", "json", null, newText);
    expect(result.entries).toHaveLength(3);
    expect(byPath(result.entries, "name")).toMatchObject({ change: "added", newValue: '"demo"', newLine: 2 });
    expect(byPath(result.entries, "config")).toMatchObject({ change: "added", newValue: "{1 keys}", newLine: 3 });
    expect(byPath(result.entries, "list")).toMatchObject({ change: "added", newValue: "[2 items]", newLine: 6 });
    expect(byPath(result.entries, "config.x")).toBeUndefined();
  });

  it("reports one entry per top-level key for an entirely deleted file, without expanding containers", () => {
    const oldText = ["{", '  "name": "demo",', '  "config": {', '    "x": 1', "  },", '  "list": [1, 2]', "}", ""].join("\n");
    const result = computeStructuralDiff("data.json", "json", oldText, null);
    expect(result.entries).toHaveLength(3);
    expect(byPath(result.entries, "name")).toMatchObject({ change: "removed", oldValue: '"demo"', oldLine: 2 });
    expect(byPath(result.entries, "config")).toMatchObject({ change: "removed", oldValue: "{1 keys}", oldLine: 3 });
    expect(byPath(result.entries, "list")).toMatchObject({ change: "removed", oldValue: "[2 items]", oldLine: 6 });
  });

  it("returns no entries for an unchanged file", () => {
    const text = JSON.stringify({ a: 1, b: { c: 2 }, d: [1, 2, 3] });
    const result = computeStructuralDiff("data.json", "json", text, text);
    expect(result.entries).toEqual([]);
    expect(result.error).toBeNull();
  });

  it("caps entries at 2000 and sets truncated", () => {
    const count = 2500;
    const oldObj: Record<string, number> = {};
    const newObj: Record<string, number> = {};
    for (let i = 0; i < count; i++) {
      oldObj[`k${i}`] = i;
      newObj[`k${i}`] = i + 1;
    }
    const result = computeStructuralDiff("data.json", "json", JSON.stringify(oldObj), JSON.stringify(newObj));
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(2000);
    expect(result.entries[0]!.path).toBe("k0");
    expect(result.entries[1999]!.path).toBe("k1999");
  });

  it("reports an error without parsing for a JSON file over 2 MB", () => {
    const oldText = JSON.stringify({ filler: "x".repeat(2.5 * 1024 * 1024), version: "1.0.0" });
    const result = computeStructuralDiff("data.json", "json", oldText, oldText);
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.error).toBe("File too large for a structural view (over 2 MB).");
  });

  it("uses JSON.parse directly (null lines) for a .json file over 300 KB", () => {
    const filler = "x".repeat(400 * 1024);
    const oldText = JSON.stringify({ filler, version: "1.0.0" });
    const newText = JSON.stringify({ filler, version: "2.0.0" });
    const result = computeStructuralDiff("data.json", "json", oldText, newText);
    expect(result.error).toBeNull();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ path: "version", change: "changed", oldValue: '"1.0.0"', newValue: '"2.0.0"', oldLine: null, newLine: null });
  });

  it("reports an error without parsing for a YAML file over 1 MB (below the 2 MB JSON cap)", () => {
    const oldText = `key: ${"x".repeat(1.2 * 1024 * 1024)}\n`;
    const result = computeStructuralDiff("config.yaml", "yaml", oldText, oldText);
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.error).toBe("File too large for a structural view (over 2 MB).");
  });
});

describe("lockfile structural diff", () => {
  it("diffs an npm v1 lockfile (dependencies tree): add, remove, bump", () => {
    const oldText = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        chalk: { version: "1.0.0" },
        "old-pkg": { version: "0.1.0" },
        "left-same": { version: "1.2.3" },
      },
    });
    const newText = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        chalk: { version: "2.0.0" },
        "new-pkg": { version: "1.0.0" },
        "left-same": { version: "1.2.3" },
      },
    });
    const result = computeStructuralDiff("package-lock.json", "lockfile", oldText, newText);
    expect(result.format).toBe("npm");
    expect(result.error).toBeNull();
    expect(byPath(result.entries, "chalk")).toMatchObject({ change: "changed", oldValue: "1.0.0", newValue: "2.0.0" });
    expect(byPath(result.entries, "new-pkg")).toMatchObject({ change: "added", newValue: "1.0.0" });
    expect(byPath(result.entries, "old-pkg")).toMatchObject({ change: "removed", oldValue: "0.1.0" });
    expect(byPath(result.entries, "left-same")).toBeUndefined();
    // Sorted alphabetically.
    expect(result.entries.map((e) => e.path)).toEqual(["chalk", "new-pkg", "old-pkg"]);
  });

  it("diffs an npm v3 lockfile (packages map): add, remove, bump, scoped names, and collapses multiple versions", () => {
    const oldText = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "demo", version: "1.0.0" },
        "node_modules/foo": { version: "1.0.0" },
        "node_modules/bar": { version: "2.0.0" },
        "node_modules/bar/node_modules/foo": { version: "1.5.0" },
        "node_modules/old-pkg": { version: "0.1.0" },
        "node_modules/@scope/pkg": { version: "1.0.0" },
      },
    });
    const newText = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "demo", version: "1.0.0" },
        "node_modules/foo": { version: "1.0.0" },
        "node_modules/bar": { version: "2.0.0" },
        "node_modules/new-pkg": { version: "3.0.0" },
        "node_modules/@scope/pkg": { version: "1.1.0" },
      },
    });
    const result = computeStructuralDiff("package-lock.json", "lockfile", oldText, newText);
    expect(result.format).toBe("npm");
    expect(byPath(result.entries, "bar")).toBeUndefined();
    // foo had two versions on the old side (root + nested under bar), collapsed to a sorted list.
    expect(byPath(result.entries, "foo")).toMatchObject({ change: "changed", oldValue: "1.0.0, 1.5.0", newValue: "1.0.0" });
    expect(byPath(result.entries, "new-pkg")).toMatchObject({ change: "added", newValue: "3.0.0" });
    expect(byPath(result.entries, "old-pkg")).toMatchObject({ change: "removed", oldValue: "0.1.0" });
    expect(byPath(result.entries, "@scope/pkg")).toMatchObject({ change: "changed", oldValue: "1.0.0", newValue: "1.1.0" });
  });

  it("diffs a pnpm lockfile (v6/v9 and v5 key shapes): add, remove, bump", () => {
    const oldText = [
      "packages:",
      "  /lodash@4.17.20: {}",
      "  /@scope/pkg@1.0.0(react@18.0.0): {}",
      "  /old-pkg@0.1.0: {}",
      "  /@scope/legacy/1.0.0: {}",
      "snapshots:",
      "  foo@1.0.0: {}",
      "importers:",
      "  .:",
      "    dependencies: {}",
      "",
    ].join("\n");
    const newText = [
      "packages:",
      "  /lodash@4.17.21: {}",
      "  /@scope/pkg@1.0.0(react@18.0.0): {}",
      "  /new-pkg@1.0.0: {}",
      "  /legacy2/2.0.0: {}",
      "",
    ].join("\n");
    const result = computeStructuralDiff("pnpm-lock.yaml", "lockfile", oldText, newText);
    expect(result.format).toBe("pnpm");
    expect(result.error).toBeNull();
    expect(byPath(result.entries, "lodash")).toMatchObject({ change: "changed", oldValue: "4.17.20", newValue: "4.17.21" });
    expect(byPath(result.entries, "@scope/pkg")).toBeUndefined();
    expect(byPath(result.entries, "new-pkg")).toMatchObject({ change: "added", newValue: "1.0.0" });
    expect(byPath(result.entries, "legacy2")).toMatchObject({ change: "added", newValue: "2.0.0" });
    expect(byPath(result.entries, "old-pkg")).toMatchObject({ change: "removed", oldValue: "0.1.0" });
    expect(byPath(result.entries, "@scope/legacy")).toMatchObject({ change: "removed", oldValue: "1.0.0" });
    // snapshots/importers are ignored entirely.
    expect(byPath(result.entries, "foo")).toBeUndefined();
  });

  it("diffs a pnpm lockfile with peer-dependency suffixes (v5 underscore and v6+ parens), both as one changed entry", () => {
    const oldText = ["packages:", "  /react-dom/18.2.0_react@18.2.0: {}", "  react-dom@18.2.0(react@18.2.0): {}", ""].join("\n");
    const newText = ["packages:", "  /react-dom/18.3.0_react@18.3.0: {}", "  react-dom@18.3.0(react@18.3.0): {}", ""].join("\n");
    const result = computeStructuralDiff("pnpm-lock.yaml", "lockfile", oldText, newText);
    expect(result.format).toBe("pnpm");
    expect(result.error).toBeNull();
    // Both keys name the same package; one "react-dom" entry, correctly named (not polluted by the
    // peer suffix), with the version bump recognized in both the v5 and v6+ key shapes.
    expect(result.entries).toHaveLength(1);
    expect(byPath(result.entries, "react-dom")).toMatchObject({ change: "changed", oldValue: "18.2.0", newValue: "18.3.0" });
  });

  it("diffs a pnpm lockfile with a scoped package's peer-dependency suffix (v5 underscore shape)", () => {
    const oldText = ["packages:", "  /@scope/react-dom/18.2.0_react@18.2.0: {}", ""].join("\n");
    const newText = ["packages:", "  /@scope/react-dom/18.3.0_react@18.3.0: {}", ""].join("\n");
    const result = computeStructuralDiff("pnpm-lock.yaml", "lockfile", oldText, newText);
    expect(result.format).toBe("pnpm");
    expect(result.entries).toHaveLength(1);
    expect(byPath(result.entries, "@scope/react-dom")).toMatchObject({ change: "changed", oldValue: "18.2.0", newValue: "18.3.0" });
  });

  it("diffs a yarn v1 lockfile: add, remove, bump, scoped selectors", () => {
    const oldText = [
      "# THIS IS AN AUTOGENERATED FILE",
      "# yarn lockfile v1",
      "",
      "",
      "chalk@^1.0.0:",
      '  version "1.0.0"',
      '  resolved "https://example.com/chalk-1.0.0.tgz"',
      "",
      '"@scope/pkg@^2.0.0", "@scope/pkg@^2.1.0":',
      '  version "2.1.0"',
      '  resolved "https://example.com/pkg-2.1.0.tgz"',
      "",
      "old-pkg@^1.0.0:",
      '  version "1.0.0"',
      "",
    ].join("\n");
    const newText = [
      "# THIS IS AN AUTOGENERATED FILE",
      "# yarn lockfile v1",
      "",
      "",
      "chalk@^1.0.0:",
      '  version "1.2.0"',
      '  resolved "https://example.com/chalk-1.2.0.tgz"',
      "",
      '"@scope/pkg@^2.0.0", "@scope/pkg@^2.1.0":',
      '  version "2.1.0"',
      '  resolved "https://example.com/pkg-2.1.0.tgz"',
      "",
      "new-pkg@^1.0.0:",
      '  version "1.0.0"',
      "",
    ].join("\n");
    const result = computeStructuralDiff("yarn.lock", "lockfile", oldText, newText);
    expect(result.format).toBe("yarn");
    expect(byPath(result.entries, "chalk")).toMatchObject({ change: "changed", oldValue: "1.0.0", newValue: "1.2.0" });
    expect(byPath(result.entries, "@scope/pkg")).toBeUndefined();
    expect(byPath(result.entries, "new-pkg")).toMatchObject({ change: "added", newValue: "1.0.0" });
    expect(byPath(result.entries, "old-pkg")).toMatchObject({ change: "removed", oldValue: "1.0.0" });
  });

  it("diffs a yarn Berry lockfile: add, remove, bump, scoped selectors", () => {
    const oldText = [
      "__metadata:",
      "  version: 6",
      "  cacheKey: 8",
      "",
      '"chalk@npm:^1.0.0":',
      "  version: 1.0.0",
      '  resolution: "chalk@npm:1.0.0"',
      "",
      '"@scope/pkg@npm:^2.0.0, @scope/pkg@npm:^2.1.0":',
      "  version: 2.1.0",
      '  resolution: "@scope/pkg@npm:2.1.0"',
      "",
      '"old-pkg@npm:^1.0.0":',
      "  version: 1.0.0",
      "",
    ].join("\n");
    const newText = [
      "__metadata:",
      "  version: 6",
      "  cacheKey: 8",
      "",
      '"chalk@npm:^1.0.0":',
      "  version: 1.5.0",
      '  resolution: "chalk@npm:1.5.0"',
      "",
      '"@scope/pkg@npm:^2.0.0, @scope/pkg@npm:^2.1.0":',
      "  version: 2.1.0",
      '  resolution: "@scope/pkg@npm:2.1.0"',
      "",
      '"new-pkg@npm:^1.0.0":',
      "  version: 1.0.0",
      "",
    ].join("\n");
    const result = computeStructuralDiff("yarn.lock", "lockfile", oldText, newText);
    expect(result.format).toBe("yarn");
    expect(byPath(result.entries, "chalk")).toMatchObject({ change: "changed", oldValue: "1.0.0", newValue: "1.5.0" });
    expect(byPath(result.entries, "@scope/pkg")).toBeUndefined();
    expect(byPath(result.entries, "new-pkg")).toMatchObject({ change: "added", newValue: "1.0.0" });
    expect(byPath(result.entries, "old-pkg")).toMatchObject({ change: "removed", oldValue: "1.0.0" });
  });

  it("diffs a Cargo.lock: add, remove, bump", () => {
    const oldText = [
      "# This file is automatically @generated by Cargo.",
      "version = 3",
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.100"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "old-crate"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "left-same"',
      'version = "2.0.0"',
      "",
    ].join("\n");
    const newText = [
      "# This file is automatically @generated by Cargo.",
      "version = 3",
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.200"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "new-crate"',
      'version = "0.2.0"',
      "",
      "[[package]]",
      'name = "left-same"',
      'version = "2.0.0"',
      "",
    ].join("\n");
    const result = computeStructuralDiff("Cargo.lock", "lockfile", oldText, newText);
    expect(result.format).toBe("cargo");
    expect(byPath(result.entries, "serde")).toMatchObject({ change: "changed", oldValue: "1.0.100", newValue: "1.0.200" });
    expect(byPath(result.entries, "new-crate")).toMatchObject({ change: "added", newValue: "0.2.0" });
    expect(byPath(result.entries, "old-crate")).toMatchObject({ change: "removed", oldValue: "0.1.0" });
    expect(byPath(result.entries, "left-same")).toBeUndefined();
  });

  it("diffs a poetry.lock: add, remove, bump, ignoring nested dependency tables", () => {
    const oldText = [
      "[[package]]",
      'name = "requests"',
      'version = "2.25.0"',
      "",
      "[package.dependencies]",
      'certifi = ">=2017.4.17"',
      "",
      "[[package]]",
      'name = "old-pkg"',
      'version = "0.1.0"',
      "",
    ].join("\n");
    const newText = [
      "[[package]]",
      'name = "requests"',
      'version = "2.26.0"',
      "",
      "[package.dependencies]",
      'certifi = ">=2017.4.17"',
      "",
      "[[package]]",
      'name = "new-pkg"',
      'version = "1.0.0"',
      "",
    ].join("\n");
    const result = computeStructuralDiff("poetry.lock", "lockfile", oldText, newText);
    expect(result.format).toBe("poetry");
    expect(byPath(result.entries, "requests")).toMatchObject({ change: "changed", oldValue: "2.25.0", newValue: "2.26.0" });
    expect(byPath(result.entries, "new-pkg")).toMatchObject({ change: "added", newValue: "1.0.0" });
    expect(byPath(result.entries, "old-pkg")).toMatchObject({ change: "removed", oldValue: "0.1.0" });
    expect(byPath(result.entries, "certifi")).toBeUndefined();
  });

  it("diffs a go.sum: add, remove, bump, deduping the /go.mod hash line", () => {
    const oldText = ["github.com/pkg/errors v0.9.0 h1:abc=", "github.com/pkg/errors v0.9.0/go.mod h1:def=", "github.com/old/mod v1.0.0 h1:ghi=", "github.com/old/mod v1.0.0/go.mod h1:jkl=", ""].join(
      "\n",
    );
    const newText = ["github.com/pkg/errors v0.9.1 h1:abc2=", "github.com/pkg/errors v0.9.1/go.mod h1:def2=", "github.com/new/mod v1.0.0 h1:mno=", "github.com/new/mod v1.0.0/go.mod h1:pqr=", ""].join(
      "\n",
    );
    const result = computeStructuralDiff("go.sum", "lockfile", oldText, newText);
    expect(result.format).toBe("go");
    expect(byPath(result.entries, "github.com/pkg/errors")).toMatchObject({ change: "changed", oldValue: "v0.9.0", newValue: "v0.9.1" });
    expect(byPath(result.entries, "github.com/new/mod")).toMatchObject({ change: "added", newValue: "v1.0.0" });
    expect(byPath(result.entries, "github.com/old/mod")).toMatchObject({ change: "removed", oldValue: "v1.0.0" });
  });

  it("diffs a Gemfile.lock: add, remove, bump, ignoring deeper-indented dependency lines", () => {
    const oldText = [
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    actionpack (7.0.4)",
      "      actionview (= 7.0.4)",
      "      rack (~> 2.0)",
      "    actionview (7.0.4)",
      "      rack (~> 2.0)",
      "    old-gem (1.0.0)",
      "",
      "PLATFORMS",
      "  ruby",
      "",
      "DEPENDENCIES",
      "  actionpack",
      "  old-gem",
      "",
    ].join("\n");
    const newText = [
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    actionpack (7.0.5)",
      "      actionview (= 7.0.5)",
      "      rack (~> 2.0)",
      "    actionview (7.0.5)",
      "      rack (~> 2.0)",
      "    new-gem (1.0.0)",
      "",
      "PLATFORMS",
      "  ruby",
      "",
      "DEPENDENCIES",
      "  actionpack",
      "  new-gem",
      "",
    ].join("\n");
    const result = computeStructuralDiff("Gemfile.lock", "lockfile", oldText, newText);
    expect(result.format).toBe("bundler");
    expect(byPath(result.entries, "actionpack")).toMatchObject({ change: "changed", oldValue: "7.0.4", newValue: "7.0.5" });
    // actionview's value must be the clean spec version, not polluted by the nested "(= 7.0.4)" dependency line.
    expect(byPath(result.entries, "actionview")).toMatchObject({ change: "changed", oldValue: "7.0.4", newValue: "7.0.5" });
    expect(byPath(result.entries, "new-gem")).toMatchObject({ change: "added", newValue: "1.0.0" });
    expect(byPath(result.entries, "old-gem")).toMatchObject({ change: "removed", oldValue: "1.0.0" });
    expect(byPath(result.entries, "rack")).toBeUndefined();
  });

  it("diffs a Gemfile.lock gem sourced from a GIT section (same specs: layout as GEM)", () => {
    const oldText = [
      "GIT",
      "  remote: https://github.com/example/my_gem.git",
      "  revision: abc123",
      "  specs:",
      "    my_gem (1.0.0)",
      "",
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    rack (2.0.0)",
      "",
      "PLATFORMS",
      "  ruby",
      "",
      "DEPENDENCIES",
      "  my_gem!",
      "  rack",
      "",
    ].join("\n");
    const newText = [
      "GIT",
      "  remote: https://github.com/example/my_gem.git",
      "  revision: def456",
      "  specs:",
      "    my_gem (1.1.0)",
      "",
      "GEM",
      "  remote: https://rubygems.org/",
      "  specs:",
      "    rack (2.0.0)",
      "",
      "PLATFORMS",
      "  ruby",
      "",
      "DEPENDENCIES",
      "  my_gem!",
      "  rack",
      "",
    ].join("\n");
    const result = computeStructuralDiff("Gemfile.lock", "lockfile", oldText, newText);
    expect(result.format).toBe("bundler");
    expect(result.error).toBeNull();
    expect(result.entries).toHaveLength(1);
    expect(byPath(result.entries, "my_gem")).toMatchObject({ change: "changed", oldValue: "1.0.0", newValue: "1.1.0" });
    expect(byPath(result.entries, "rack")).toBeUndefined();
  });

  it("diffs a composer.lock: add, remove, bump across packages and packages-dev", () => {
    const oldText = JSON.stringify({
      packages: [
        { name: "vendor/pkg-a", version: "1.0.0" },
        { name: "vendor/old-pkg", version: "0.1.0" },
      ],
      "packages-dev": [{ name: "vendor/dev-pkg", version: "1.0.0" }],
    });
    const newText = JSON.stringify({
      packages: [
        { name: "vendor/pkg-a", version: "1.1.0" },
        { name: "vendor/new-pkg", version: "1.0.0" },
      ],
      "packages-dev": [{ name: "vendor/dev-pkg", version: "1.0.0" }],
    });
    const result = computeStructuralDiff("composer.lock", "lockfile", oldText, newText);
    expect(result.format).toBe("composer");
    expect(byPath(result.entries, "vendor/pkg-a")).toMatchObject({ change: "changed", oldValue: "1.0.0", newValue: "1.1.0" });
    expect(byPath(result.entries, "vendor/new-pkg")).toMatchObject({ change: "added", newValue: "1.0.0" });
    expect(byPath(result.entries, "vendor/old-pkg")).toMatchObject({ change: "removed", oldValue: "0.1.0" });
    expect(byPath(result.entries, "vendor/dev-pkg")).toBeUndefined();
  });

  it("diffs a Pipfile.lock: add, remove, bump, stripping a leading '=='", () => {
    const oldText = JSON.stringify({
      default: { requests: { version: "==2.25.0" }, "old-pkg": { version: "==1.0.0" } },
      develop: { pytest: { version: "==6.0.0" } },
    });
    const newText = JSON.stringify({
      default: { requests: { version: "==2.26.0" }, "new-pkg": { version: "==1.0.0" } },
      develop: { pytest: { version: "==6.0.0" } },
    });
    const result = computeStructuralDiff("Pipfile.lock", "lockfile", oldText, newText);
    expect(result.format).toBe("pipenv");
    expect(byPath(result.entries, "requests")).toMatchObject({ change: "changed", oldValue: "2.25.0", newValue: "2.26.0" });
    expect(byPath(result.entries, "new-pkg")).toMatchObject({ change: "added", newValue: "1.0.0" });
    expect(byPath(result.entries, "old-pkg")).toMatchObject({ change: "removed", oldValue: "1.0.0" });
    expect(byPath(result.entries, "pytest")).toBeUndefined();
  });

  it("reports an error for an unsupported lockfile format", () => {
    const result = computeStructuralDiff("random.lock", "lockfile", "a", "b");
    expect(result.entries).toEqual([]);
    expect(result.error).toBe("Unsupported lockfile");
  });

  it("never throws on malformed lockfile content", () => {
    expect(() => computeStructuralDiff("package-lock.json", "lockfile", "{not json", "{also not json")).not.toThrow();
    const result = computeStructuralDiff("package-lock.json", "lockfile", "{not json", "{also not json");
    expect(result.entries).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
