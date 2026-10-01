import { describe, expect, it } from "vitest";
import { detectAlert, linkifyGithubRefs, stripHtmlComments } from "../client/render/markdown-text";

describe("stripHtmlComments", () => {
  it("removes a single-line comment", () => {
    expect(stripHtmlComments("before <!-- hidden --> after")).toBe("before  after");
  });

  it("removes a multi-line comment", () => {
    const body = "line one\n<!-- LOCATIONS START\nsrc/a.ts#L1-L2\nLOCATIONS END -->\nline two";
    expect(stripHtmlComments(body)).toBe("line one\n\nline two");
  });

  it("removes multiple comments anywhere in the body", () => {
    const body = "<!-- a -->one<!-- b -->two<!-- c -->";
    expect(stripHtmlComments(body)).toBe("onetwo");
  });

  it("leaves comment-like text inside a fenced code block untouched", () => {
    const body = "before\n```\n<!-- not a real comment -->\n```\nafter <!-- real --> done";
    expect(stripHtmlComments(body)).toBe("before\n```\n<!-- not a real comment -->\n```\nafter  done");
  });

  it("handles a tilde-fenced code block too", () => {
    const body = "~~~\n<!-- kept -->\n~~~\n<!-- dropped -->";
    expect(stripHtmlComments(body)).toBe("~~~\n<!-- kept -->\n~~~\n");
  });

  it("is a no-op when there are no comments", () => {
    expect(stripHtmlComments("just plain text")).toBe("just plain text");
  });
});

describe("linkifyGithubRefs", () => {
  const baseUrl = "https://github.com/acme/widgets/pull/42";

  it("returns a single unlinked segment when there is nothing to link", () => {
    expect(linkifyGithubRefs("plain text", baseUrl)).toEqual([{ text: "plain text" }]);
  });

  it("linkifies an @mention", () => {
    expect(linkifyGithubRefs("thanks @octocat for the fix", baseUrl)).toEqual([
      { text: "thanks " },
      { text: "@octocat", href: "https://github.com/octocat" },
      { text: " for the fix" },
    ]);
  });

  it("linkifies a bare #123 issue reference against the PR's own repo", () => {
    expect(linkifyGithubRefs("see #123 for context", baseUrl)).toEqual([
      { text: "see " },
      { text: "#123", href: "https://github.com/acme/widgets/issues/123" },
      { text: " for context" },
    ]);
  });

  it("linkifies an owner/repo#123 cross-repo reference", () => {
    expect(linkifyGithubRefs("see other/repo#7 please", baseUrl)).toEqual([
      { text: "see " },
      { text: "other/repo#7", href: "https://github.com/other/repo/issues/7" },
      { text: " please" },
    ]);
  });

  it("does not linkify inside an email address", () => {
    expect(linkifyGithubRefs("contact a@b.com for help", baseUrl)).toEqual([{ text: "contact a@b.com for help" }]);
  });

  it("does not linkify a mention embedded inside a word", () => {
    expect(linkifyGithubRefs("foo@bar-baz", baseUrl)).toEqual([{ text: "foo@bar-baz" }]);
  });

  it("does not linkify a bare SHA", () => {
    expect(linkifyGithubRefs("commit fb0e91d2abc1234 fixed it", baseUrl)).toEqual([
      { text: "commit fb0e91d2abc1234 fixed it" },
    ]);
  });

  it("handles multiple references in one string", () => {
    expect(linkifyGithubRefs("@a and @b fixed #1", baseUrl)).toEqual([
      { text: "@a", href: "https://github.com/a" },
      { text: " and " },
      { text: "@b", href: "https://github.com/b" },
      { text: " fixed " },
      { text: "#1", href: "https://github.com/acme/widgets/issues/1" },
    ]);
  });
});

describe("detectAlert", () => {
  it("recognises each alert kind", () => {
    expect(detectAlert("[!NOTE]")).toEqual({ kind: "NOTE", rest: "" });
    expect(detectAlert("[!TIP]")).toEqual({ kind: "TIP", rest: "" });
    expect(detectAlert("[!IMPORTANT]")).toEqual({ kind: "IMPORTANT", rest: "" });
    expect(detectAlert("[!WARNING]")).toEqual({ kind: "WARNING", rest: "" });
    expect(detectAlert("[!CAUTION]")).toEqual({ kind: "CAUTION", rest: "" });
  });

  it("is case-insensitive and captures trailing text on the marker line", () => {
    expect(detectAlert("[!note] heads up")).toEqual({ kind: "NOTE", rest: "heads up" });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(detectAlert("  [!TIP]  ")).toEqual({ kind: "TIP", rest: "" });
  });

  it("returns null for a non-alert line", () => {
    expect(detectAlert("just a regular blockquote")).toBeNull();
    expect(detectAlert("[!UNKNOWN]")).toBeNull();
  });
});
