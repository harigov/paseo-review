import { describe, expect, it } from "vitest";
import {
  buildChangeMapRows,
  countFilesByStatus,
  formatChangeMapCounts,
  moduleChangeMapStatus,
  orderModulesForChangeMap,
  type ChangeMapCounts,
} from "../client/app/change-map";
import type { AnalyzedFile, Module } from "../shared/types";

function mod(id: string, rank: number, fileCount = 1, extra: Partial<Module> = {}): Module {
  return {
    id,
    title: id,
    rank,
    description: "",
    fileCount,
    additions: 0,
    deletions: 0,
    effectiveLines: 0,
    maxRisk: null,
    viewedFiles: 0,
    summary: null,
    recommendedLevel: null,
    levelReason: null,
    ...extra,
  };
}

function file(moduleId: string, status: AnalyzedFile["status"]): AnalyzedFile {
  return {
    path: `${moduleId}/${status}-${Math.random()}`,
    oldPath: null,
    status,
    binary: false,
    additions: 1,
    deletions: 1,
    effectiveLines: 2,
    movedLines: 0,
    moduleId,
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
  };
}

describe("orderModulesForChangeMap", () => {
  it("drops modules with no files", () => {
    const modules = [mod("a", 0, 1), mod("empty", 1, 0)];
    expect(orderModulesForChangeMap(modules).map((m) => m.id)).toEqual(["a"]);
  });

  it("sorts by rank, with noise always last regardless of its rank", () => {
    const modules = [mod("noise", 0, 3), mod("b", 2, 1), mod("a", 1, 1)];
    expect(orderModulesForChangeMap(modules).map((m) => m.id)).toEqual(["a", "b", "noise"]);
  });

  it("does not mutate the input array", () => {
    const modules = [mod("b", 1, 1), mod("a", 0, 1)];
    const copy = [...modules];
    orderModulesForChangeMap(modules);
    expect(modules).toEqual(copy);
  });
});

describe("countFilesByStatus", () => {
  it("counts only the module's own files, by status", () => {
    const files = [
      file("core", "added"),
      file("core", "added"),
      file("core", "modified"),
      file("core", "deleted"),
      file("core", "renamed"),
      file("core", "copied"),
      file("other", "added"),
    ];
    expect(countFilesByStatus("core", files)).toEqual({ added: 2, modified: 1, deleted: 1, renamed: 1, copied: 1 });
  });

  it("returns all zeros for a module with no matching files", () => {
    expect(countFilesByStatus("core", [file("other", "added")])).toEqual({ added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0 });
  });
});

describe("moduleChangeMapStatus", () => {
  const zero: ChangeMapCounts = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0 };
  it("is New when every file is added", () => {
    expect(moduleChangeMapStatus({ ...zero, added: 3 })).toBe("new");
  });
  it("is Removed when every file is deleted", () => {
    expect(moduleChangeMapStatus({ ...zero, deleted: 2 })).toBe("removed");
  });
  it("is Changed for a mix, including all-renamed or all-copied", () => {
    expect(moduleChangeMapStatus({ ...zero, added: 1, modified: 1 })).toBe("changed");
    expect(moduleChangeMapStatus({ ...zero, renamed: 2 })).toBe("changed");
    expect(moduleChangeMapStatus({ ...zero, copied: 2 })).toBe("changed");
  });
  it("is Changed (not New or Removed) when there are no files at all", () => {
    expect(moduleChangeMapStatus(zero)).toBe("changed");
  });
});

describe("formatChangeMapCounts", () => {
  const zero: ChangeMapCounts = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0 };
  it("formats new/modified/deleted, omitting zero counts", () => {
    expect(formatChangeMapCounts({ ...zero, added: 3, modified: 5, deleted: 1 })).toBe("3 new · 5 modified · 1 deleted");
    expect(formatChangeMapCounts({ ...zero, added: 2 })).toBe("2 new");
    expect(formatChangeMapCounts(zero)).toBe("");
  });
  it("folds renamed and copied into the modified count", () => {
    expect(formatChangeMapCounts({ ...zero, modified: 1, renamed: 2, copied: 1 })).toBe("4 modified");
  });
});

describe("buildChangeMapRows", () => {
  it("builds one ordered row per module with files, each with its counts/status/label", () => {
    const modules = [mod("noise", 5, 1), mod("core", 0, 2)];
    const files = [file("core", "added"), file("core", "added"), file("noise", "modified")];
    const rows = buildChangeMapRows(modules, files);
    expect(rows.map((r) => r.module.id)).toEqual(["core", "noise"]);
    expect(rows[0]).toMatchObject({ status: "new", countsLabel: "2 new" });
    expect(rows[1]).toMatchObject({ status: "changed", countsLabel: "1 modified" });
  });
});
