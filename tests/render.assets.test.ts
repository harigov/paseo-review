import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findAssetFile, sliceChunk } from "../server/assets/index";

// server/assets/index.ts is owned by workstream E2 (docs/plan-round4.md §5). Named
// `render.*` to stay in this workstream's test-file lane alongside client/render/*.

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("sliceChunk", () => {
  it("returns the whole text in one chunk when it is under the cap", () => {
    const result = sliceChunk("hello world", 0);
    expect(result).toEqual({ text: "hello world", nextOffset: null, total: 11 });
  });

  it("splits text larger than the chunk size and reconstructs it via nextOffset", () => {
    const chunkSize = 512 * 1024;
    const text = "a".repeat(chunkSize * 2 + 10);
    const chunks: string[] = [];
    let offset: number | null = 0;
    let iterations = 0;
    while (offset !== null) {
      const result = sliceChunk(text, offset);
      expect(result.total).toBe(text.length);
      expect(result.text.length).toBeLessThanOrEqual(chunkSize);
      chunks.push(result.text);
      offset = result.nextOffset;
      iterations++;
    }
    expect(iterations).toBe(3); // 512K + 512K + 10
    expect(chunks.join("")).toBe(text);
  });

  it("returns an empty chunk and null nextOffset once offset reaches total", () => {
    expect(sliceChunk("abc", 3)).toEqual({ text: "", nextOffset: null, total: 3 });
    expect(sliceChunk("abc", 99)).toEqual({ text: "", nextOffset: null, total: 3 });
  });

  it("handles empty text", () => {
    expect(sliceChunk("", 0)).toEqual({ text: "", nextOffset: null, total: 0 });
  });
});

describe("findAssetFile", () => {
  it("finds the asset by walking up from dirnameRoot", () => {
    const root = tempDir("pr-review-assets-dirname-");
    const nested = path.join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const assetDir = path.join(root, "node_modules", "mermaid", "dist");
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(path.join(assetDir, "mermaid.min.js"), "window.mermaid = {};");

    const found = findAssetFile("mermaid", { dirnameRoot: nested, cwdRoot: tempDir("pr-review-assets-empty-cwd-") });
    expect(found).toBe(path.join(assetDir, "mermaid.min.js"));
  });

  it("finds the asset by walking up from cwdRoot when dirnameRoot has nothing", () => {
    const dirnameRoot = tempDir("pr-review-assets-empty-dirname-");
    const cwdRoot = tempDir("pr-review-assets-cwd-");
    const assetDir = path.join(cwdRoot, "node_modules", "mermaid", "dist");
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(path.join(assetDir, "mermaid.min.js"), "window.mermaid = {};");

    const found = findAssetFile("mermaid", { dirnameRoot, cwdRoot });
    expect(found).toBe(path.join(assetDir, "mermaid.min.js"));
  });

  it("falls back to the newest plugin checkout under $PASEO_HOME when neither root has it", () => {
    const dirnameRoot = tempDir("pr-review-assets-empty-dirname-");
    const cwdRoot = tempDir("pr-review-assets-empty-cwd-");
    const paseoHome = tempDir("pr-review-assets-home-");

    const older = path.join(paseoHome, "plugins", "pr-review", "older-uuid", "checkout", "node_modules", "mermaid", "dist");
    const newer = path.join(paseoHome, "plugins", "pr-review", "newer-uuid", "checkout", "node_modules", "mermaid", "dist");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(path.join(older, "mermaid.min.js"), "// older checkout");
    writeFileSync(path.join(newer, "mermaid.min.js"), "// newer checkout");

    // Both checkout dirs are created back-to-back, so make the mtime difference explicit rather
    // than relying on filesystem timestamp resolution.
    const now = Date.now() / 1000;
    utimesSync(path.join(paseoHome, "plugins", "pr-review", "older-uuid", "checkout"), now - 3600, now - 3600);
    utimesSync(path.join(paseoHome, "plugins", "pr-review", "newer-uuid", "checkout"), now, now);

    const found = findAssetFile("mermaid", { dirnameRoot, cwdRoot, paseoHome });
    expect(found).toBe(path.join(newer, "mermaid.min.js"));
  });

  it("returns null when the asset exists nowhere in any candidate location", () => {
    const dirnameRoot = tempDir("pr-review-assets-empty-dirname-");
    const cwdRoot = tempDir("pr-review-assets-empty-cwd-");
    const paseoHome = tempDir("pr-review-assets-empty-home-");

    const found = findAssetFile("mermaid", { dirnameRoot, cwdRoot, paseoHome });
    expect(found).toBeNull();
  });
});
