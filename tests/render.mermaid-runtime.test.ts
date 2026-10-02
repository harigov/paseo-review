import { describe, expect, it } from "vitest";
import { loadMermaidScript } from "../client/render/mermaid-runtime";

// The `useMermaidRuntime` hook itself (useRpc/useSyncExternalStore) isn't exercised here — it
// needs a live plugin RPC context, and this file is a plain hook, not a component, so there's
// nothing to mount. What's covered is the pure chunk-fetching loop it's built on.

describe("loadMermaidScript", () => {
  it("concatenates every chunk from offset 0 through a null nextOffset", async () => {
    const chunks = [
      { text: "part one ", nextOffset: 9, total: 20, message: null },
      { text: "part two.", nextOffset: null, total: 20, message: null },
    ];
    const calls: number[] = [];
    const fetchChunk = async ({ offset }: { offset: number }) => {
      calls.push(offset);
      return chunks[calls.length - 1]!;
    };
    const result = await loadMermaidScript(fetchChunk);
    expect(result).toEqual({ script: "part one part two.", message: null });
    expect(calls).toEqual([0, 9]);
  });

  it("returns a single chunk unchanged when nextOffset is already null", async () => {
    const result = await loadMermaidScript(async () => ({ text: "window.mermaid = {};", nextOffset: null, total: 21, message: null }));
    expect(result).toEqual({ script: "window.mermaid = {};", message: null });
  });

  it("surfaces the server's not-found message when text is null", async () => {
    const result = await loadMermaidScript(async () => ({ text: null, nextOffset: null, total: 0, message: "Could not find it." }));
    expect(result).toEqual({ script: null, message: "Could not find it." });
  });

  it("falls back to a generic message when text is null with no message", async () => {
    const result = await loadMermaidScript(async () => ({ text: null, nextOffset: null, total: 0, message: null }));
    expect(result.script).toBeNull();
    expect(result.message).toMatch(/could not be loaded/i);
  });

  it("treats an empty-but-complete script as unavailable", async () => {
    const result = await loadMermaidScript(async () => ({ text: "", nextOffset: null, total: 0, message: null }));
    expect(result.script).toBeNull();
    expect(result.message).toMatch(/empty/i);
  });

  it("gives up if the server reports a nextOffset that doesn't advance", async () => {
    const result = await loadMermaidScript(async () => ({ text: "x", nextOffset: 0, total: 10, message: null }));
    expect(result.script).toBeNull();
    expect(result.message).toMatch(/no progress/i);
  });

  it("escapes a </script> sequence inside the loaded runtime text", async () => {
    const result = await loadMermaidScript(async () => ({
      text: "globalThis.x = '</script><script>evil()</script>';",
      nextOffset: null,
      total: 50,
      message: null,
    }));
    expect(result.script).not.toContain("</script><script>evil()</script>");
    expect(result.script).toContain("<\\/script>");
  });
});
