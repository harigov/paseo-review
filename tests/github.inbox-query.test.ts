import { describe, expect, it } from "vitest";
import { INBOX_MAX_AGE_MS, isInboxListedPr } from "../shared/types";
import { inboxSearchSections } from "../server/github/index";

const NOW = new Date("2026-10-02T15:00:00.000Z");

describe("inboxSearchSections", () => {
  const sections = inboxSearchSections("repo:acme/app", NOW);

  it("excludes merged PRs from every section", () => {
    expect(sections.recent).toContain("-is:merged");
    expect(sections.recent).not.toContain(" is:merged");
    for (const query of [sections.mine, sections.review_requested, sections.assigned, sections.all]) {
      expect(query).toContain("is:open");
    }
  });

  it("limits every section to PRs updated in the last 30 days", () => {
    for (const query of Object.values(sections)) {
      expect(query).toContain("updated:>=2026-09-02");
    }
  });
});

describe("isInboxListedPr", () => {
  it("drops merged PRs even when they were updated just now", () => {
    expect(isInboxListedPr({ state: "MERGED", updatedAt: NOW.toISOString() }, NOW.getTime())).toBe(false);
  });

  it("keeps an open or closed PR updated within 30 days", () => {
    const updatedAt = new Date(NOW.getTime() - INBOX_MAX_AGE_MS).toISOString();
    expect(isInboxListedPr({ state: "OPEN", updatedAt }, NOW.getTime())).toBe(true);
    expect(isInboxListedPr({ state: "CLOSED", updatedAt }, NOW.getTime())).toBe(true);
  });

  it("drops a PR last updated more than 30 days ago", () => {
    const updatedAt = new Date(NOW.getTime() - INBOX_MAX_AGE_MS - 1).toISOString();
    expect(isInboxListedPr({ state: "OPEN", updatedAt }, NOW.getTime())).toBe(false);
  });
});
