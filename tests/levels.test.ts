import { describe, expect, it } from "vitest";
import { activeDepthRules, deeperLevel, defaultModuleLevel, depthRulesHash, pickRuleLevel, resolveFileLevel, resolveModuleLevel } from "../shared/levels";
import type { DepthRule } from "../shared/settings";

const outline = [
  { name: "f", kind: "function" as const, change: "added" as const, exported: true, signature: "f()", oldSignature: null, newStart: 1, newEnd: 2, oldStart: null, oldEnd: null, changedLines: 2, counterpart: null },
];

function file(moduleId: string, hasOutline: boolean, extra: Partial<{ binary: boolean; structuralKind: "json" | null }> = {}) {
  return { moduleId, binary: extra.binary ?? false, outline: hasOutline ? outline : null, structuralKind: extra.structuralKind ?? null };
}

describe("defaultModuleLevel", () => {
  it("puts noise at Files", () => {
    expect(defaultModuleLevel({ id: "noise", maxRisk: 5, effectiveLines: 5 }, [])).toBe("files");
  });
  it("puts high-risk modules at Code even when large", () => {
    expect(defaultModuleLevel({ id: "core", maxRisk: 4, effectiveLines: 5000 }, [file("core", true)])).toBe("code");
  });
  it("puts large, outline-covered modules at Declarations", () => {
    const files = [file("core", true), file("core", true), file("core", false, { structuralKind: "json" }), file("core", false)];
    expect(defaultModuleLevel({ id: "core", maxRisk: 2, effectiveLines: 900 }, files)).toBe("declarations");
  });
  it("keeps large modules with poor outline coverage at Code", () => {
    const files = [file("core", true), file("core", false), file("core", false)];
    expect(defaultModuleLevel({ id: "core", maxRisk: null, effectiveLines: 900 }, files)).toBe("code");
  });
  it("ignores binary files and other modules when measuring coverage", () => {
    const files = [file("core", true), file("core", false, { binary: true }), file("ui", false), file("ui", false)];
    expect(defaultModuleLevel({ id: "core", maxRisk: null, effectiveLines: 700 }, files)).toBe("declarations");
  });
  it("keeps small modules at Code", () => {
    expect(defaultModuleLevel({ id: "core", maxRisk: 1, effectiveLines: 120 }, [file("core", true)])).toBe("code");
  });
});

describe("resolveModuleLevel / resolveFileLevel", () => {
  const module = { id: "core", maxRisk: 1, effectiveLines: 10, recommendedLevel: "declarations" as const };
  it("prefers the user's choice, then the rule, then the default", () => {
    expect(resolveModuleLevel("files", module, [])).toEqual({ level: "files", source: "user" });
    expect(resolveModuleLevel(undefined, module, [])).toEqual({ level: "declarations", source: "rule" });
    expect(resolveModuleLevel(null, { ...module, recommendedLevel: null }, [])).toEqual({ level: "code", source: "default" });
  });
  it("lets a file override its module", () => {
    expect(resolveFileLevel("code", "files")).toBe("code");
    expect(resolveFileLevel(undefined, "declarations")).toBe("declarations");
  });
  it("orders levels files < declarations < code", () => {
    expect(deeperLevel("files", "code")).toBe("code");
    expect(deeperLevel("declarations", "files")).toBe("declarations");
  });
});

describe("depth rules", () => {
  const rules: DepthRule[] = [
    { when: "Only tests or fixtures", level: "files", enabled: true },
    { when: "Touches authentication", level: "code", enabled: true },
    { when: "Additive API surface", level: "declarations", enabled: true },
    { when: "   ", level: "code", enabled: true },
    { when: "Disabled rule", level: "code", enabled: false },
  ];

  it("drops disabled and blank rules", () => {
    expect(activeDepthRules(rules).map((rule) => rule.when)).toEqual(["Only tests or fixtures", "Touches authentication", "Additive API surface"]);
  });

  it("hashes only active rules, stably and order-sensitively", () => {
    expect(depthRulesHash([])).toBe("");
    expect(depthRulesHash([rules[4]])).toBe("");
    const active = activeDepthRules(rules);
    expect(depthRulesHash(rules)).toBe(depthRulesHash(active));
    expect(depthRulesHash(active)).toBe(depthRulesHash(active.map((rule) => ({ ...rule, when: `  ${rule.when} ` }))));
    expect(depthRulesHash(active)).not.toBe(depthRulesHash([...active].reverse()));
    expect(depthRulesHash(active)).not.toBe(depthRulesHash(active.map((rule, i) => (i === 0 ? { ...rule, level: "code" as const } : rule))));
  });

  it("picks the deepest matching rule, ties to the earlier one", () => {
    const active = activeDepthRules(rules);
    expect(pickRuleLevel(active, [true, false, true])).toEqual({ level: "declarations", reason: "Additive API surface" });
    expect(pickRuleLevel(active, [true, true, true])).toEqual({ level: "code", reason: "Touches authentication" });
    const tie: DepthRule[] = [
      { when: "A", level: "code", enabled: true },
      { when: "B", level: "code", enabled: true },
    ];
    expect(pickRuleLevel(tie, [true, true])).toEqual({ level: "code", reason: "A" });
    expect(pickRuleLevel(active, [false, false, false])).toBeNull();
  });
});
