import { describe, expect, it } from "vitest";
import { gqlString, parseGithubSlug, splitRepo } from "../server/github/gh";

describe("parseGithubSlug", () => {
  it("parses https remotes", () => {
    expect(parseGithubSlug("https://github.com/owner/repo.git")).toEqual({ owner: "owner", name: "repo" });
    expect(parseGithubSlug("https://github.com/owner/repo")).toEqual({ owner: "owner", name: "repo" });
    expect(parseGithubSlug("https://github.com/owner/repo/")).toEqual({ owner: "owner", name: "repo" });
  });

  it("parses scp-like ssh remotes, including host aliases", () => {
    expect(parseGithubSlug("git@github.com:owner/repo.git")).toEqual({ owner: "owner", name: "repo" });
    expect(parseGithubSlug("git@github.com-work:owner/repo.git")).toEqual({ owner: "owner", name: "repo" });
  });

  it("parses ssh:// remotes, including an explicit port", () => {
    expect(parseGithubSlug("ssh://git@github.com/owner/repo.git")).toEqual({ owner: "owner", name: "repo" });
    expect(parseGithubSlug("ssh://git@github.com:22/owner/repo.git")).toEqual({ owner: "owner", name: "repo" });
  });

  it("rejects a path with an extra trailing segment instead of silently misattributing owner/name", () => {
    // Previously `segments.slice(-2)` would turn this into {owner:"repo", name:"extra"}.
    expect(parseGithubSlug("https://github.com/owner/repo/extra")).toBeNull();
  });

  it("rejects non-github hosts, including lookalikes", () => {
    expect(parseGithubSlug("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGithubSlug("https://github.com.evil.com/owner/repo.git")).toBeNull();
    expect(parseGithubSlug("https://notgithub.com/owner/repo.git")).toBeNull();
  });

  it("rejects urls with too few path segments", () => {
    expect(parseGithubSlug("https://github.com/owner")).toBeNull();
    expect(parseGithubSlug("https://github.com/")).toBeNull();
  });
});

describe("splitRepo", () => {
  it("splits owner/name", () => {
    expect(splitRepo("owner/repo")).toEqual({ owner: "owner", name: "repo" });
  });

  it("throws on a slug with no slash", () => {
    expect(() => splitRepo("not-a-slug")).toThrow();
  });
});

describe("gqlString", () => {
  it("escapes quotes and backslashes so a value can't break out of the GraphQL string", () => {
    const value = `a" ) { maliciousField } mutation { evil(x: "`;
    const escaped = gqlString(value);
    expect(escaped.startsWith('"')).toBe(true);
    expect(escaped.endsWith('"')).toBe(true);
    // The escaped form must not contain an unescaped quote that could terminate the string early.
    expect(escaped.slice(1, -1)).not.toMatch(/(^|[^\\])"/);
  });
});
