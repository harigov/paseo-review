import { describe, expect, it } from "vitest";
import { buildGithubCss, type GithubCssColors } from "../client/render/github-css";

const COLORS: GithubCssColors = {
  foreground: "#111111",
  foregroundMuted: "#222222",
  surface0: "#333333",
  surface1: "#444444",
  surface2: "#555555",
  border: "#666666",
  accent: "#770077",
  statusSuccess: "#088008",
  statusWarning: "#998800",
  statusDanger: "#aa0011",
};

describe("buildGithubCss", () => {
  it("returns a string containing every injected colour", () => {
    const css = buildGithubCss(COLORS);
    expect(typeof css).toBe("string");
    for (const value of Object.values(COLORS)) {
      expect(css).toContain(value);
    }
  });

  it("never emits the literal string 'undefined'", () => {
    const css = buildGithubCss(COLORS);
    expect(css).not.toContain("undefined");
  });

  it("scopes every rule under .markdown-body", () => {
    const css = buildGithubCss(COLORS);
    // Anything other than the top-level html/body reset and the .markdown-body root rule
    // itself must be nested under `.markdown-body` so the stylesheet can't leak outside the
    // article it's injected alongside.
    const rulesOutsideScope = css
      .split("}")
      .map((rule) => rule.split("{")[0]?.trim())
      .filter((selector): selector is string => Boolean(selector) && !selector!.startsWith("/*"))
      .filter((selector) => selector !== "html, body" && !selector.includes(".markdown-body"));
    expect(rulesOutsideScope).toEqual([]);
  });
});
