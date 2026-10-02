import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dataDir } from "../server/core/paths";
import { loadUiState, mergeRecents, saveUiState } from "../server/ui-state";
import { DEFAULT_UI_STATE, markReviewed, pushRecent, type UiState } from "../shared/ui-state";

beforeAll(() => {
  process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pr-review-ui-state-"));
});

describe("ui-state store", () => {
  it("round-trips a saved state through loadUiState", async () => {
    const state: UiState = {
      version: 1,
      lastLocation: { kind: "pr", repo: "owner/repo", number: 7, tab: "validators" },
      recentPrs: [
        { repo: "owner/repo", number: 7, title: "Fix the thing", openedAt: "2026-01-01T00:00:00.000Z", reviewedAt: null },
      ],
      inboxFilters: { repo: null, hideDrafts: true, ci: "failing", review: "any", sort: "updated" },
    };

    await saveUiState(state);
    const loaded = await loadUiState();

    expect(loaded).toEqual(state);
  });

  it("falls back to defaults when the file holds invalid JSON", async () => {
    const file = path.join(dataDir(), "ui-state.json");
    writeFileSync(file, "{ not valid json", "utf8");

    const loaded = await loadUiState();

    expect(loaded).toEqual(DEFAULT_UI_STATE);
  });

  it("falls back to defaults when the file holds JSON that fails the schema", async () => {
    const file = path.join(dataDir(), "ui-state.json");
    writeFileSync(file, JSON.stringify({ version: 1, lastLocation: { kind: "pr" /* missing repo/number */ } }), "utf8");

    const loaded = await loadUiState();

    expect(loaded).toEqual(DEFAULT_UI_STATE);
  });

  it("falls back to defaults when there is no file at all", async () => {
    process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pr-review-ui-state-empty-"));

    const loaded = await loadUiState();

    expect(loaded).toEqual(DEFAULT_UI_STATE);
  });
});

describe("pushRecent", () => {
  it("caps the recent-PR list at 20 entries, newest first", () => {
    let state = DEFAULT_UI_STATE;
    for (let i = 1; i <= 25; i++) {
      state = pushRecent(state, { repo: "owner/repo", number: i, title: `PR ${i}` }, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`);
    }

    expect(state.recentPrs).toHaveLength(20);
    // Most recently pushed (25) is first; the oldest five (1-5) were evicted.
    expect(state.recentPrs[0].number).toBe(25);
    expect(state.recentPrs.map((r) => r.number)).not.toContain(1);
    expect(state.recentPrs.map((r) => r.number)).not.toContain(5);
    expect(state.recentPrs.map((r) => r.number)).toContain(6);
  });

  it("dedupes by repo#number case-insensitively and moves the entry to the front", () => {
    let state = DEFAULT_UI_STATE;
    state = pushRecent(state, { repo: "owner/repo", number: 1, title: "First" }, "2026-01-01T00:00:01.000Z");
    state = pushRecent(state, { repo: "owner/repo", number: 2, title: "Second" }, "2026-01-01T00:00:02.000Z");
    state = pushRecent(state, { repo: "Owner/Repo", number: 1, title: "First (reopened)" }, "2026-01-01T00:00:03.000Z");

    expect(state.recentPrs).toHaveLength(2);
    expect(state.recentPrs[0]).toMatchObject({ repo: "Owner/Repo", number: 1, title: "First (reopened)" });
    expect(state.recentPrs[1]).toMatchObject({ repo: "owner/repo", number: 2, title: "Second" });
  });

  it("preserves an existing entry's reviewedAt across a re-open", () => {
    let state = DEFAULT_UI_STATE;
    state = pushRecent(state, { repo: "owner/repo", number: 1, title: "First" }, "2026-01-01T00:00:01.000Z");
    state = markReviewed(state, "owner/repo", 1, "2026-01-01T00:00:02.000Z");
    state = pushRecent(state, { repo: "owner/repo", number: 1, title: "First (reopened)" }, "2026-01-01T00:00:03.000Z");

    expect(state.recentPrs[0].reviewedAt).toBe("2026-01-01T00:00:02.000Z");
  });
});

describe("markReviewed", () => {
  it("stamps reviewedAt on the matching entry only", () => {
    let state = DEFAULT_UI_STATE;
    state = pushRecent(state, { repo: "owner/repo", number: 1, title: "First" }, "2026-01-01T00:00:01.000Z");
    state = pushRecent(state, { repo: "owner/other", number: 2, title: "Second" }, "2026-01-01T00:00:02.000Z");

    const next = markReviewed(state, "OWNER/REPO", 1, "2026-01-01T00:00:03.000Z");

    expect(next.recentPrs.find((r) => r.number === 1)?.reviewedAt).toBe("2026-01-01T00:00:03.000Z");
    expect(next.recentPrs.find((r) => r.number === 2)?.reviewedAt).toBeNull();
  });

  it("is a no-op (returns the same reference) when nothing matches", () => {
    const state = pushRecent(DEFAULT_UI_STATE, { repo: "owner/repo", number: 1, title: "First" }, "2026-01-01T00:00:01.000Z");

    const next = markReviewed(state, "owner/repo", 999, "2026-01-01T00:00:02.000Z");

    expect(next).toBe(state);
  });
});

describe("mergeRecents", () => {
  const pr = (number: number, openedAt: string, reviewedAt: string | null = null) => ({ repo: "acme/widgets", number, title: `#${number}`, openedAt, reviewedAt });

  it("keeps PRs that only one side knows about and the newer timestamps for shared ones", () => {
    const existing = [pr(1, "2026-10-01T10:00:00Z"), pr(2, "2026-10-01T09:00:00Z", "2026-10-01T09:30:00Z")];
    const incoming = [pr(3, "2026-10-01T11:00:00Z"), pr(2, "2026-10-01T08:00:00Z")];
    const merged = mergeRecents(existing, incoming);
    expect(merged.map((p) => p.number)).toEqual([3, 1, 2]);
    expect(merged[2].reviewedAt).toBe("2026-10-01T09:30:00Z");
  });

  it("caps the merged list at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => pr(i + 1, `2026-10-01T${String(i).padStart(2, "0")}:00:00Z`));
    expect(mergeRecents(many.slice(0, 15), many.slice(10))).toHaveLength(20);
  });
});
