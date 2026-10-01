import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dataDir } from "../server/core/paths";
import { getLocalViewedRecords, recordViewed, removeViewed } from "../server/github/viewed-store";

beforeAll(() => {
  process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pr-review-viewed-store-"));
});

describe("viewed-store path safety", () => {
  it("rejects a repo slug that tries to escape the viewed data directory", async () => {
    await expect(recordViewed("a/../../../../../../tmp/pwned", 1, "foo.ts", "sha1")).rejects.toThrow();
    // Nothing should have been written outside the plugin's data directory.
    expect(existsSync(path.join(tmpdir(), "tmp", "pwned__1.json"))).toBe(false);
  });

  it("keeps the recorded file inside the viewed data directory for a normal slug", async () => {
    await recordViewed("owner/repo", 42, "src/a.ts", "headsha1");
    const dir = dataDir("viewed");
    const files = readdirSync(dir);
    expect(files.some((f) => f.toLowerCase() === "owner__repo__42.json")).toBe(true);
  });
});

describe("viewed-store concurrency", () => {
  it("doesn't lose an update when two writes race for the same PR", async () => {
    const repo = "owner/concurrent-repo";
    const number = 7;

    await Promise.all([
      recordViewed(repo, number, "a.ts", "sha-a"),
      recordViewed(repo, number, "b.ts", "sha-b"),
      recordViewed(repo, number, "c.ts", "sha-c"),
      recordViewed(repo, number, "d.ts", "sha-d"),
    ]);

    const records = await getLocalViewedRecords(repo, number);
    expect(Object.keys(records).sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  it("removeViewed racing with recordViewed still ends in a consistent state", async () => {
    const repo = "owner/concurrent-repo-2";
    const number = 9;
    await recordViewed(repo, number, "keep.ts", "sha-keep");

    await Promise.all([
      recordViewed(repo, number, "new.ts", "sha-new"),
      removeViewed(repo, number, "keep.ts"),
    ]);

    const records = await getLocalViewedRecords(repo, number);
    expect(records["new.ts"]).toBeDefined();
    expect(records["keep.ts"]).toBeUndefined();
  });
});
