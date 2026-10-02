import { createElement, type ReactElement } from "react";

// Web-only helpers for the renderers in this directory. Two kinds of exports:
//  - Element builders (iframe, video): React.createElement with a loosely-typed prop bag, no
//    DOM types, so this file typechecks under the client (no-DOM-lib) tsconfig. Callers own all
//    web-only *behaviour* (listening for messages, resolving link hrefs); these own only shape.
//  - Pure string builders for the mermaid-rendering bootstrap injected into those iframes'
//    `srcDoc` (and into HtmlView's already-DOM-free html string) — kept here, rather than next
//    to the components that use them, specifically so they stay free of React Native imports
//    and are unit testable (GithubHtmlView.tsx/HtmlView.tsx/MermaidView.tsx import
//    "react-native", which vitest can't parse at all; see docs/plan-round4.md §5).
// This file must only be reached (for the element builders) when Platform.OS === "web".

// CSP prologue adapted (Apache-2.0) from Paseo's own HTML preview sandbox, credit:
// packages/app/src/file-pane/html-preview-csp.ts in getpaseo/paseo.
const CSP_PROLOGUE =
  "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'\">";

export function renderHtmlIframe(html: string, height: number | "flex"): ReactElement {
  const props: Record<string, unknown> = {
    srcDoc: CSP_PROLOGUE + html,
    sandbox: "allow-scripts",
    referrerPolicy: "no-referrer",
    style: {
      border: "none",
      width: "100%",
      height: height === "flex" ? "100%" : height,
      flex: height === "flex" ? 1 : undefined,
    },
  };
  return createElement("iframe", props as any);
}

/**
 * Builds a sandboxed `<iframe srcDoc>` element for a fully-formed GitHub-flavoured HTML
 * document (CSP meta tag, stylesheet, `<article class="markdown-body">`, and the height/link
 * postMessage script already baked into `srcDoc` by the caller). Kept separate from
 * `renderHtmlIframe` above because that CSP ("data:/blob: only, no https images") is wrong for
 * GitHub content, which needs `img-src https:` for avatar/user-images. Like `renderHtmlIframe`,
 * this builds the element with a loosely-typed prop bag so the file typechecks without the DOM
 * lib — GithubHtmlView.tsx owns all web-only *behaviour* (listening for messages, resolving
 * link hrefs); this function only owns the element shape.
 */
export function renderGithubIframe({
  srcDoc,
  height,
  scroll,
}: {
  srcDoc: string;
  height: number;
  scroll: boolean;
}): ReactElement {
  const props: Record<string, unknown> = {
    srcDoc,
    sandbox: "allow-scripts",
    referrerPolicy: "no-referrer",
    // `scrolling` is a deprecated iframe attribute, but it's still honored by every current
    // engine and is a plain string prop here (no DOM types needed), unlike reaching for
    // `overflow` on the iframe's own document from the outside.
    scrolling: scroll ? "yes" : "no",
    style: {
      border: "none",
      width: "100%",
      height,
      overflow: scroll ? "auto" : "hidden",
    },
  };
  return createElement("iframe", props as any);
}

/**
 * Builds a sandboxed `<iframe srcDoc>` for a single mermaid diagram (`MermaidView`'s web path):
 * same shape as `renderGithubIframe`, but there's no horizontal-scroll toggle — a diagram just
 * grows to its natural size, like the rest of a markdown body.
 */
export function renderMermaidIframe({ srcDoc, height }: { srcDoc: string; height: number }): ReactElement {
  const props: Record<string, unknown> = {
    srcDoc,
    sandbox: "allow-scripts",
    referrerPolicy: "no-referrer",
    style: { border: "none", width: "100%", height },
  };
  return createElement("iframe", props as any);
}

/**
 * A real `<video controls>` element for a GitHub-attached (or markdown `<video>`) clip. Unlike
 * the iframe builders, this isn't sandboxed content — it plays the URL directly — so it's only
 * reached for an already-validated `https:` `src` (the caller's job, same as `AutoImage`/links).
 */
export function renderVideoElement({ src }: { src: string }): ReactElement {
  const props: Record<string, unknown> = {
    src,
    controls: true,
    style: { maxWidth: "100%", width: "100%" },
  };
  return createElement("video", props as any);
}

// ---------- mermaid bootstrap scripts (pure string templates) ----------

/**
 * Defangs any `</script` inside `js` before it's interpolated into an inline `<script>…</script>`
 * block — otherwise a stray occurrence (inside the ~3 MB mermaid runtime's own source, or inside
 * a user-authored diagram label embedded via `JSON.stringify` below) would prematurely close the
 * tag and corrupt the surrounding `srcDoc`. Idempotent: re-escaping already-escaped text is a
 * safe no-op, since the inserted backslash breaks the pattern on a second pass.
 */
export function escapeScriptClose(js: string): string {
  return js.replace(/<\/script/gi, (match) => `<\\/${match.slice(2)}`);
}

function mermaidTheme(dark: boolean): string {
  return dark ? "dark" : "default";
}

/**
 * The bootstrap script GithubHtmlView injects (after the runtime itself) when `findMermaidSources`
 * found at least one diagram in GitHub's `bodyHTML`. Finds the same blocks again at runtime via
 * real DOM APIs — `section[data-type="mermaid"]`, a standalone `pre[lang="mermaid"]`, or a `pre`
 * containing `code.language-mermaid` — in document order, pairs them positionally with `sources`
 * (produced by that same function, in that same order), renders each with `mermaid.render`, and
 * replaces the block with the resulting SVG (or, on failure, the source plus the error message).
 * Posts the iframe's new height via the existing `prr-html-height` message once every diagram has
 * settled. `id` must match the instance id GithubHtmlView filters that message by.
 */
export function buildMermaidSectionBootstrapScript(sources: string[], dark: boolean, id: string): string {
  const script = `
(function () {
  if (!window.mermaid) return;
  var ID = ${JSON.stringify(id)};
  function postHeight() {
    parent.postMessage({ type: "prr-html-height", id: ID, height: document.documentElement.scrollHeight }, "*");
  }
  // A failed mermaid.render leaves its own "Syntax error" graphic (#d<id>) at the end of the
  // body; the source + message shown in place is the error display, so drop the duplicate.
  function removeMermaidLeftovers(renderId) {
    var leftover = document.getElementById("d" + renderId) || document.getElementById(renderId);
    if (leftover && leftover.parentNode) leftover.parentNode.removeChild(leftover);
  }
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${JSON.stringify(mermaidTheme(dark))} });
  var sources = ${JSON.stringify(sources)};
  var targets = [];
  Array.prototype.forEach.call(document.querySelectorAll('section[data-type="mermaid"], pre'), function (node) {
    if (node.tagName === "SECTION") {
      targets.push(node);
      return;
    }
    if (node.closest && node.closest('section[data-type="mermaid"]')) return;
    var isLangMermaid = (node.getAttribute("lang") || "").toLowerCase() === "mermaid";
    var codeChild = node.querySelector ? node.querySelector("code.language-mermaid") : null;
    if (isLangMermaid || codeChild) targets.push(node);
  });
  var pending = targets.map(function (node, i) {
    var source = sources[i];
    if (source === undefined || !node.parentNode) return Promise.resolve();
    var container = document.createElement("div");
    container.className = "prr-mermaid-diagram";
    node.parentNode.replaceChild(container, node);
    var renderId = "prr-mermaid-" + i;
    return mermaid
      .render(renderId, source)
      .then(function (result) {
        container.innerHTML = result.svg;
      })
      .catch(function (error) {
        removeMermaidLeftovers(renderId);
        var pre = document.createElement("pre");
        pre.textContent = source;
        var note = document.createElement("div");
        note.className = "prr-mermaid-error";
        note.textContent = "Mermaid render failed: " + (error && error.message ? error.message : String(error));
        container.appendChild(pre);
        container.appendChild(note);
      });
  });
  Promise.all(pending).then(postHeight);
})();
`;
  return escapeScriptClose(script);
}

/**
 * The bootstrap script `HtmlView` injects when the agent-authored HTML contains a `.mermaid`
 * block — mermaid's own `run()` already auto-detects and renders every `.mermaid` element, so
 * unlike the GitHub-section case above there's no manual find/replace needed here.
 */
export function buildMermaidRunBootstrapScript(dark: boolean): string {
  return `
(function () {
  if (!window.mermaid) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${JSON.stringify(mermaidTheme(dark))} });
  mermaid.run().catch(function () {});
})();
`;
}

/**
 * Full `srcDoc` for `MermaidView`'s web path: one diagram, rendered with the already-loaded
 * runtime (`runtimeScript`) and reporting its height the same way GithubHtmlView's iframe does.
 * CSP is `'unsafe-eval'` (mermaid's renderer needs it under a strict CSP) but otherwise locked
 * down — no network, no same-origin access.
 */
export function buildMermaidDiagramSrcDoc({
  runtimeScript,
  source,
  dark,
  id,
}: {
  runtimeScript: string;
  source: string;
  dark: boolean;
  id: string;
}): string {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
  const bootstrap = escapeScriptClose(`
(function () {
  var ID = ${JSON.stringify(id)};
  // The document's own box, not scrollHeight: scrollHeight never drops below the iframe's
  // current height, so a frame sized larger than its diagram could never shrink to fit.
  function postHeight() {
    parent.postMessage({ type: "prr-html-height", id: ID, height: Math.ceil(document.documentElement.getBoundingClientRect().height) }, "*");
  }
  if (!window.mermaid) {
    postHeight();
    return;
  }
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${JSON.stringify(mermaidTheme(dark))} });
  var container = document.getElementById("prr-mermaid-container");
  mermaid
    .render("prr-mermaid-diagram", ${JSON.stringify(source)})
    .then(function (result) {
      container.innerHTML = result.svg;
    })
    .catch(function (error) {
      var leftover = document.getElementById("dprr-mermaid-diagram");
      if (leftover && leftover.parentNode) leftover.parentNode.removeChild(leftover);
      var pre = document.createElement("pre");
      pre.textContent = ${JSON.stringify(source)};
      var note = document.createElement("div");
      note.className = "prr-mermaid-error";
      note.textContent = "Mermaid render failed: " + (error && error.message ? error.message : String(error));
      container.appendChild(pre);
      container.appendChild(note);
    })
    .finally(postHeight);
})();
`);
  const style =
    "html,body{margin:0;padding:8px;background:transparent;}" +
    "#prr-mermaid-container svg{max-width:100%;height:auto;display:block;}" +
    "pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:12px;}" +
    ".prr-mermaid-error{color:#c0392b;font-size:12px;font-family:-apple-system,sans-serif;}";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${dark ? "dark" : "light"}"><style>${style}</style></head><body><div id="prr-mermaid-container"></div><script>${escapeScriptClose(runtimeScript)}</script><script>${bootstrap}</script></body></html>`;
}
