import { describe, expect, it } from "vitest";
import { mapLatestReviews, mapReviewRequests } from "../server/github/index";

describe("mapLatestReviews", () => {
  it("excludes the PR author's own review", () => {
    const out = mapLatestReviews(
      [{ state: "APPROVED", submittedAt: "2024-01-01T00:00:00Z", url: "u1", author: { __typename: "User", login: "author" } }],
      "author",
    );
    expect(out).toEqual([]);
  });

  it("sorts changes-requested first, then approved, then the rest — newest first within a group", () => {
    const out = mapLatestReviews(
      [
        { state: "COMMENTED", submittedAt: "2024-01-03T00:00:00Z", url: "c1", author: { __typename: "User", login: "carol" } },
        { state: "APPROVED", submittedAt: "2024-01-01T00:00:00Z", url: "a1", author: { __typename: "User", login: "alice" } },
        { state: "CHANGES_REQUESTED", submittedAt: "2024-01-02T00:00:00Z", url: "b1", author: { __typename: "User", login: "bob" } },
        { state: "APPROVED", submittedAt: "2024-01-04T00:00:00Z", url: "a2", author: { __typename: "User", login: "dave" } },
        { state: "PENDING", submittedAt: "2024-01-05T00:00:00Z", url: "e1", author: { __typename: "User", login: "erin" } },
      ],
      "author",
    );
    expect(out.map((r) => r.author)).toEqual(["bob", "dave", "alice", "erin", "carol"]);
  });

  it("marks a Bot author's authorKind as 'bot' and a User's as 'user'", () => {
    const out = mapLatestReviews(
      [
        { state: "COMMENTED", submittedAt: "2024-01-01T00:00:00Z", url: "b1", author: { __typename: "Bot", login: "dependabot" } },
        { state: "COMMENTED", submittedAt: "2024-01-01T00:00:00Z", url: "u1", author: { __typename: "User", login: "alice" } },
      ],
      "author",
    );
    const bot = out.find((r) => r.author === "dependabot");
    const user = out.find((r) => r.author === "alice");
    expect(bot?.authorKind).toBe("bot");
    expect(user?.authorKind).toBe("user");
  });

  it("falls back to 'ghost' when the author is null", () => {
    const out = mapLatestReviews([{ state: "APPROVED", submittedAt: null, url: null, author: null }], "author");
    expect(out[0].author).toBe("ghost");
  });

  it("falls back to COMMENTED for an unrecognised state", () => {
    const out = mapLatestReviews(
      [{ state: "SOMETHING_NEW", submittedAt: null, url: null, author: { __typename: "User", login: "alice" } }],
      "author",
    );
    expect(out[0].state).toBe("COMMENTED");
  });

  it("treats a null submittedAt as oldest within its group", () => {
    const out = mapLatestReviews(
      [
        { state: "APPROVED", submittedAt: null, url: null, author: { __typename: "User", login: "alice" } },
        { state: "APPROVED", submittedAt: "2024-01-01T00:00:00Z", url: null, author: { __typename: "User", login: "bob" } },
      ],
      "author",
    );
    expect(out.map((r) => r.author)).toEqual(["bob", "alice"]);
  });
});

describe("mapReviewRequests", () => {
  it("maps a User to kind 'user'", () => {
    const out = mapReviewRequests([{ requestedReviewer: { __typename: "User", login: "alice" } }]);
    expect(out).toEqual([{ kind: "user", name: "alice" }]);
  });

  it("maps a Mannequin to kind 'user'", () => {
    const out = mapReviewRequests([{ requestedReviewer: { __typename: "Mannequin", login: "ghost-account" } }]);
    expect(out).toEqual([{ kind: "user", name: "ghost-account" }]);
  });

  it("maps a Bot to kind 'bot'", () => {
    const out = mapReviewRequests([{ requestedReviewer: { __typename: "Bot", login: "some-bot" } }]);
    expect(out).toEqual([{ kind: "bot", name: "some-bot" }]);
  });

  it("maps a Team to kind 'team', preferring slug over name", () => {
    const out = mapReviewRequests([{ requestedReviewer: { __typename: "Team", name: "Core Team", slug: "core-team" } }]);
    expect(out).toEqual([{ kind: "team", name: "core-team" }]);
  });

  it("falls back to a Team's name when slug is missing", () => {
    const out = mapReviewRequests([{ requestedReviewer: { __typename: "Team", name: "Core Team" } }]);
    expect(out).toEqual([{ kind: "team", name: "Core Team" }]);
  });

  it("skips a null requestedReviewer", () => {
    const out = mapReviewRequests([{ requestedReviewer: null }]);
    expect(out).toEqual([]);
  });
});
