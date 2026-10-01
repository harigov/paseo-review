import { describe, expect, it } from "vitest";
import { applySpansToTokens, intralineDiff, intralineForPairs } from "../client/diff/intraline";

describe("intralineDiff", () => {
  it("returns no spans for identical lines", () => {
    const result = intralineDiff("const x = foo(bar);", "const x = foo(bar);");
    expect(result).toEqual({ old: [], new: [], whole: false });
  });

  it("covers only the changed word when one word changes in the middle", () => {
    const result = intralineDiff("the quick fox jumps", "the slow fox jumps");
    expect(result.whole).toBe(false);
    expect(result.old).toEqual([{ start: 4, end: 9 }]);
    expect(result.new).toEqual([{ start: 4, end: 8 }]);
    expect("the quick fox jumps".slice(4, 9)).toBe("quick");
    expect("the slow fox jumps".slice(4, 8)).toBe("slow");
  });

  it("marks an inserted word as a new-only span", () => {
    const oldText = "run fast now";
    const newText = "run very fast now";
    const result = intralineDiff(oldText, newText);
    expect(result.whole).toBe(false);
    expect(result.old).toEqual([]);
    expect(result.new).toEqual([{ start: 4, end: 9 }]);
    expect(newText.slice(4, 9)).toBe("very ");
  });

  it("marks a deleted word as an old-only span", () => {
    const oldText = "run very fast now";
    const newText = "run fast now";
    const result = intralineDiff(oldText, newText);
    expect(result.whole).toBe(false);
    expect(result.new).toEqual([]);
    expect(result.old).toEqual([{ start: 4, end: 9 }]);
    expect(oldText.slice(4, 9)).toBe("very ");
  });

  it("covers a punctuation-only change", () => {
    const oldText = "foo(bar);";
    const newText = "foo(bar),";
    const result = intralineDiff(oldText, newText);
    expect(result.whole).toBe(false);
    expect(result.old).toEqual([{ start: 8, end: 9 }]);
    expect(result.new).toEqual([{ start: 8, end: 9 }]);
    expect(oldText.slice(8, 9)).toBe(";");
    expect(newText.slice(8, 9)).toBe(",");
  });

  it("keeps whitespace spans when the only change is whitespace", () => {
    const oldText = "foo(  bar)";
    const newText = "foo(bar)";
    const result = intralineDiff(oldText, newText);
    expect(result.whole).toBe(false);
    expect(result.old).toEqual([{ start: 4, end: 6 }]);
    expect(oldText.slice(4, 6)).toBe("  ");
    expect(result.new).toEqual([]);
  });

  it("drops whitespace-only spans when a non-whitespace change is also present", () => {
    // Both the indentation (2 spaces vs. 1) and "baz"/"qux" differ; only the word change should
    // surface since it isn't purely whitespace.
    const oldText = "foo  bar baz";
    const newText = "foo bar qux";
    const result = intralineDiff(oldText, newText);
    expect(result.whole).toBe(false);
    expect(result.old).toEqual([{ start: 9, end: 12 }]);
    expect(result.new).toEqual([{ start: 8, end: 11 }]);
    expect(oldText.slice(9, 12)).toBe("baz");
    expect(newText.slice(8, 11)).toBe("qux");
  });

  it("reports whole:true with no spans for a long rewritten line", () => {
    const result = intralineDiff(
      "function foo(a, b) { return a + b; }",
      "xyzzyPlughWaldoFred qux corge grault garply",
    );
    expect(result).toEqual({ old: [], new: [], whole: true });
  });

  it("caps by maxTokens and reports whole:true without computing spans", () => {
    const oldText = "a ".repeat(5);
    const newText = "a ".repeat(5);
    const result = intralineDiff(oldText, newText, { maxTokens: 3 });
    expect(result).toEqual({ old: [], new: [], whole: true });
  });
});

describe("applySpansToTokens", () => {
  it("returns tokens unmarked when there are no spans", () => {
    const tokens = [{ text: "foo", extra: 1 }, { text: "bar", extra: 2 }];
    expect(applySpansToTokens(tokens, [])).toEqual([
      { text: "foo", extra: 1, emphasized: false },
      { text: "bar", extra: 2, emphasized: false },
    ]);
  });

  it("splits a token that straddles a span boundary and preserves its other properties", () => {
    const tokens = [
      { text: "foobar", style: null },
      { text: "baz", style: "keyword" },
    ];
    const spans = [{ start: 3, end: 6 }]; // covers "bar" inside the first token only
    expect(applySpansToTokens(tokens, spans)).toEqual([
      { text: "foo", style: null, emphasized: false },
      { text: "bar", style: null, emphasized: true },
      { text: "baz", style: "keyword", emphasized: false },
    ]);
  });

  it("splits a span that straddles two adjacent tokens, marking a piece of each", () => {
    const tokens = [
      { text: "foo", extra: 1 },
      { text: "bar", extra: 2 },
    ];
    const spans = [{ start: 1, end: 4 }]; // "oo" (end of token 1) + "b" (start of token 2)
    expect(applySpansToTokens(tokens, spans)).toEqual([
      { text: "f", extra: 1, emphasized: false },
      { text: "oo", extra: 1, emphasized: true },
      { text: "b", extra: 2, emphasized: true },
      { text: "ar", extra: 2, emphasized: false },
    ]);
  });
});

describe("intralineForPairs", () => {
  it("pairs a 2-del/3-add block, with the unpaired add getting an all-new span", () => {
    const results = intralineForPairs(["foo", "bar"], ["foo", "bar", "baz extra"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ old: [], new: [], whole: false });
    expect(results[1]).toEqual({ old: [], new: [], whole: false });
    expect(results[2]).toEqual({ old: [], new: [{ start: 0, end: 9 }], whole: false });
  });

  it("pairs a 3-del/2-add block, with the unpaired del getting an all-old span", () => {
    const results = intralineForPairs(["foo", "bar", "baz extra"], ["foo", "bar"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ old: [], new: [], whole: false });
    expect(results[1]).toEqual({ old: [], new: [], whole: false });
    expect(results[2]).toEqual({ old: [{ start: 0, end: 9 }], new: [], whole: false });
  });
});
