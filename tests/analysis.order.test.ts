import { describe, expect, it } from "vitest";
import { computeFoundationsOrder, computeRiskOrder, type OrderableFile } from "../server/analysis/order";

function file(path: string, overrides: Partial<OrderableFile> = {}): OrderableFile {
  return { path, moduleId: "core", risk: null, complexity: null, effectiveLines: 1, binary: false, ...overrides };
}

describe("computeFoundationsOrder", () => {
  it("orders modules by taxonomy rank, then files by import dependency (definitions before users)", () => {
    const files = [file("b.ts", { moduleId: "core" }), file("a.ts", { moduleId: "core" }), file("doc.md", { moduleId: "docs" })];
    const taxonomy = [
      { id: "core", rank: 1 },
      { id: "docs", rank: 2 },
    ];
    // b.ts imports a.ts, so a.ts (the definition) must come before b.ts (the user).
    const graph = new Map([
      ["b.ts", new Set(["a.ts"])],
      ["a.ts", new Set<string>()],
    ]);
    const order = computeFoundationsOrder(files, taxonomy, graph);
    expect(order.indexOf("a.ts")).toBeLessThan(order.indexOf("b.ts"));
    expect(order.indexOf("b.ts")).toBeLessThan(order.indexOf("doc.md"));
  });

  it("breaks an import cycle without infinite-looping or dropping files", () => {
    const files = [file("a.ts"), file("b.ts")];
    const taxonomy = [{ id: "core", rank: 1 }];
    const graph = new Map([
      ["a.ts", new Set(["b.ts"])],
      ["b.ts", new Set(["a.ts"])],
    ]);
    const order = computeFoundationsOrder(files, taxonomy, graph);
    expect(new Set(order)).toEqual(new Set(["a.ts", "b.ts"]));
    expect(order).toHaveLength(2);
  });

  it("falls back to path order for files in an unranked module", () => {
    const files = [file("z.ts", { moduleId: "unknown" }), file("a.ts", { moduleId: "unknown" })];
    const order = computeFoundationsOrder(files, [], new Map());
    expect(order).toHaveLength(2);
  });
});

describe("computeRiskOrder", () => {
  it("sorts by risk desc, then complexity desc, then effective lines desc", () => {
    const files = [
      file("low.ts", { risk: 1, complexity: 5, effectiveLines: 100 }),
      file("high.ts", { risk: 5, complexity: 1, effectiveLines: 1 }),
      file("tieBig.ts", { risk: 3, complexity: 2, effectiveLines: 50 }),
      file("tieSmall.ts", { risk: 3, complexity: 2, effectiveLines: 10 }),
    ];
    const order = computeRiskOrder(files);
    expect(order).toEqual(["high.ts", "tieBig.ts", "tieSmall.ts", "low.ts"]);
  });

  it("treats null risk/complexity as lowest", () => {
    const files = [file("unscored.ts", { risk: null, complexity: null }), file("scored.ts", { risk: 1, complexity: 1 })];
    const order = computeRiskOrder(files);
    expect(order).toEqual(["scored.ts", "unscored.ts"]);
  });
});
