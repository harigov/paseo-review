import { createElement, type ReactElement } from "react";

// Web-only: builds a sandboxed <iframe srcDoc> element. This file must only be reached when
// Platform.OS === "web"; it uses no DOM globals directly, only React.createElement with a
// loosely-typed prop bag so it typechecks without the DOM lib.

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
