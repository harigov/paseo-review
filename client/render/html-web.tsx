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
