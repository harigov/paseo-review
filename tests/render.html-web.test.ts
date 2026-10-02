import { describe, expect, it } from "vitest";
import {
  buildMermaidDiagramSrcDoc,
  buildMermaidRunBootstrapScript,
  buildMermaidSectionBootstrapScript,
  escapeScriptClose,
} from "../client/render/html-web";

// html-web.tsx's element builders (renderHtmlIframe, renderGithubIframe, renderMermaidIframe,
// renderVideoElement) return React elements via createElement and aren't exercised here — this
// repo doesn't render React components in its test suite (several client/render/* files import
// "react-native", which the vitest/rollup pipeline can't even parse). What's covered here is
// the pure string-template half of the file: the "srcDoc assembly" pieces called out in
// docs/plan-round4.md §5's quality bar.

describe("escapeScriptClose", () => {
  it("defangs </script> so it can't close an enclosing <script> tag", () => {
    expect(escapeScriptClose("const x = '</script>';")).toBe("const x = '<\\/script>';");
  });

  it("is case-insensitive", () => {
    expect(escapeScriptClose("</SCRIPT>")).toBe("<\\/SCRIPT>");
  });

  it("leaves text with no </script in it untouched", () => {
    expect(escapeScriptClose("const x = 1;")).toBe("const x = 1;");
  });

  it("is idempotent — escaping already-escaped text is a no-op", () => {
    const once = escapeScriptClose("</script>");
    const twice = escapeScriptClose(once);
    expect(twice).toBe(once);
  });
});

describe("buildMermaidSectionBootstrapScript", () => {
  it("embeds the theme, the sources array, and the instance id", () => {
    const script = buildMermaidSectionBootstrapScript(["graph TD; A-->B;"], true, "prr-html-42");
    expect(script).toContain('theme: "dark"');
    expect(script).toContain("graph TD; A-->B;");
    expect(script).toContain('"prr-html-42"');
    expect(script).toContain("securityLevel: \"strict\"");
    expect(script).toContain("startOnLoad: false");
  });

  it("uses the default theme when not dark", () => {
    expect(buildMermaidSectionBootstrapScript([], false, "x")).toContain('theme: "default"');
  });

  it("finds section[data-type=mermaid] and pre blocks, skips a pre already inside a matched section, and posts height once settled", () => {
    const script = buildMermaidSectionBootstrapScript([], false, "x");
    expect(script).toContain('section[data-type="mermaid"], pre');
    expect(script).toContain('node.closest(\'section[data-type="mermaid"]\')');
    expect(script).toContain("code.language-mermaid");
    expect(script).toContain("prr-html-height");
    expect(script).toContain("Promise.all(pending).then(postHeight)");
  });

  it("shows the source plus the error message on a render failure", () => {
    const script = buildMermaidSectionBootstrapScript([], false, "x");
    expect(script).toContain("Mermaid render failed:");
    expect(script).toContain("pre.textContent = source");
  });

  it("defangs a </script> sequence hiding inside an embedded diagram source", () => {
    const script = buildMermaidSectionBootstrapScript(["a</script><script>alert(1)"], false, "x");
    expect(script).not.toContain("</script><script>alert(1)");
    expect(script).toContain("<\\/script>");
  });

  it("guards on window.mermaid before doing anything else", () => {
    expect(buildMermaidSectionBootstrapScript([], false, "x")).toContain("if (!window.mermaid) return;");
  });
});

describe("buildMermaidRunBootstrapScript", () => {
  it("initializes with the right theme and calls mermaid.run()", () => {
    const script = buildMermaidRunBootstrapScript(true);
    expect(script).toContain('theme: "dark"');
    expect(script).toContain("mermaid.run()");
    expect(script).toContain("if (!window.mermaid) return;");
  });

  it("uses the default theme when not dark", () => {
    expect(buildMermaidRunBootstrapScript(false)).toContain('theme: "default"');
  });
});

describe("buildMermaidDiagramSrcDoc", () => {
  it("assembles a full document with CSP, the runtime script, the source, and the theme", () => {
    const srcDoc = buildMermaidDiagramSrcDoc({ runtimeScript: "/* runtime */", source: "graph TD; A-->B;", dark: false, id: "prr-mermaid-1" });
    expect(srcDoc).toContain("Content-Security-Policy");
    expect(srcDoc).toContain("'unsafe-eval'");
    expect(srcDoc).toContain("/* runtime */");
    expect(srcDoc).toContain("graph TD; A-->B;");
    expect(srcDoc).toContain('theme: "default"');
    expect(srcDoc).toContain('"prr-mermaid-1"');
    expect(srcDoc).toContain("prr-mermaid-container");
  });

  it("switches the color-scheme meta and theme for dark", () => {
    const srcDoc = buildMermaidDiagramSrcDoc({ runtimeScript: "", source: "", dark: true, id: "x" });
    expect(srcDoc).toContain('name="color-scheme" content="dark"');
    expect(srcDoc).toContain('theme: "dark"');
  });

  it("defangs </script> inside the runtime script so it can't break out of its <script> tag", () => {
    const srcDoc = buildMermaidDiagramSrcDoc({ runtimeScript: "window.x='</script>'", source: "s", dark: false, id: "x" });
    expect(srcDoc).not.toContain("</script>'");
    expect(srcDoc).toContain("<\\/script>");
  });

  it("defangs </script> inside the embedded diagram source", () => {
    const srcDoc = buildMermaidDiagramSrcDoc({ runtimeScript: "", source: "a</script>alert(1)", dark: false, id: "x" });
    expect(srcDoc).not.toContain("a</script>alert(1)");
  });

  it("falls back to posting height without rendering when the runtime never loaded", () => {
    const srcDoc = buildMermaidDiagramSrcDoc({ runtimeScript: "", source: "s", dark: false, id: "x" });
    expect(srcDoc).toContain("if (!window.mermaid) {");
    expect(srcDoc).toContain("postHeight();\n    return;");
  });
});
