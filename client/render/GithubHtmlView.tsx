import { useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Markdown } from "./Markdown";
import { renderGithubIframe, buildMermaidSectionBootstrapScript } from "./html-web";
import { buildGithubCss } from "./github-css";
import { findMermaidSources } from "./html-subset";
import { useMermaidRuntime } from "./mermaid-runtime";
import { isDarkSurface } from "../ui/color";

// Module-level counter for `id` generation below: GithubHtmlView instances post/receive
// window messages tagged with a per-instance id so one card's iframe can't move another
// card's height or trigger another card's link — a counter + Math.random keeps ids unique
// without pulling in a DOM/crypto API that isn't available in this no-DOM-lib file's callers.
let instanceCounter = 0;

const MIN_HEIGHT = 60;
const INITIAL_HEIGHT = 160;


/** Only `https:` URLs may be opened; root-relative hrefs (`/owner/repo/...`) are resolved
 * against github.com first. Everything else (http:, javascript:, mailto:, bare fragments, …)
 * is dropped rather than guessed at. */
function resolveExternalHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `https://github.com${trimmed}`;
  return null;
}

/**
 * `mermaidSources`/`mermaidScript` are null/empty unless `findMermaidSources` found at least
 * one diagram AND the (lazily-loaded, ~3 MB) runtime has finished loading — otherwise the
 * article renders exactly as it did before mermaid support: the diagram's source shows as a
 * plain code block, same as any other fenced block GitHub ships in `bodyHTML`.
 */
function buildSrcDoc(html: string, css: string, dark: boolean, id: string, mermaidSources: string[], mermaidScript: string | null): string {
  const hasMermaid = mermaidSources.length > 0 && mermaidScript !== null;
  // Mermaid's renderer needs `unsafe-eval` under a strict CSP (confirmed against its own CSP
  // guidance; not verified in an actual browser here, since this agent has none — flagged as a
  // risk in the round's report). Only loosened when there's actually a diagram to render.
  const scriptSrc = hasMermaid ? "'unsafe-inline' 'unsafe-eval'" : "'unsafe-inline'";
  const csp =
    `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src https: data: blob:; font-src data:; media-src https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'`;
  // Runs inside the sandboxed iframe (no `allow-same-origin`, so this has an opaque origin and
  // cannot reach the parent except via postMessage). Reports document height whenever it can
  // plausibly have changed, and turns clicks on links into a message instead of a navigation
  // (which the sandbox would block anyway, but intercepting first avoids a blocked-navigation
  // console error and lets the parent decide what, if anything, to open).
  const script = `
(function () {
  var ID = ${JSON.stringify(id)};
  function postHeight() {
    parent.postMessage({ type: "prr-html-height", id: ID, height: document.documentElement.scrollHeight }, "*");
  }
  window.addEventListener("load", postHeight);
  if (window.ResizeObserver && document.body) {
    new ResizeObserver(postHeight).observe(document.body);
  }
  document.addEventListener("toggle", postHeight, true);
  Array.prototype.forEach.call(document.querySelectorAll("img"), function (img) {
    img.addEventListener("load", postHeight);
  });
  Array.prototype.forEach.call(document.querySelectorAll("video"), function (video) {
    video.controls = true;
    video.addEventListener("loadedmetadata", postHeight);
  });
  document.addEventListener(
    "click",
    function (event) {
      var el = event.target;
      while (el && el.nodeType === 1 && el.tagName !== "A") el = el.parentElement;
      if (!el || el.tagName !== "A") return;
      var href = el.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      parent.postMessage({ type: "prr-html-link", id: ID, href: href }, "*");
    },
    true,
  );
})();
`;
  const mermaidBlock = hasMermaid
    ? `<script>${mermaidScript}</script><script>${buildMermaidSectionBootstrapScript(mermaidSources, dark, id)}</script>`
    : "";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${dark ? "dark" : "light"}"><base target="_blank"><style>${css}</style></head><body><article class="markdown-body">${html}</article><script>${script}</script>${mermaidBlock}</body></html>`;
}

export function GithubHtmlView({
  html,
  markdown,
  theme,
  baseUrl,
  maxHeight = 1600,
}: {
  html: string;
  markdown: string;
  theme: PluginSurfaceProps["theme"];
  baseUrl: string;
  maxHeight?: number;
}) {
  const c = theme.colors;
  const [id] = useState(() => `prr-html-${(instanceCounter += 1)}-${Math.random().toString(36).slice(2)}`);
  // Raw height as last reported by the iframe's content; clamped to [MIN_HEIGHT, maxHeight]
  // below so a single very tall render doesn't blow out the surrounding layout.
  const [rawHeight, setRawHeight] = useState(INITIAL_HEIGHT);
  // Cheap even on native (plain string scanning), but the runtime itself is only ever fetched
  // when there's actually a diagram to render — see `useMermaidRuntime`.
  const mermaidSources = useMemo(() => findMermaidSources(html), [html]);
  const mermaidRuntime = useMermaidRuntime(Platform.OS === "web" && mermaidSources.length > 0);

  useEffect(() => {
    function handler(event: any) {
      const data = event?.data;
      if (!data || data.id !== id) return;
      if (data.type === "prr-html-height" && typeof data.height === "number" && Number.isFinite(data.height)) {
        setRawHeight(data.height);
      } else if (data.type === "prr-html-link" && typeof data.href === "string") {
        const url = resolveExternalHref(data.href);
        if (url) void openExternalUrl(url).catch(() => {});
      }
    }
    (globalThis as any).addEventListener?.("message", handler);
    return () => {
      (globalThis as any).removeEventListener?.("message", handler);
    };
  }, [id]);

  if (Platform.OS !== "web") {
    return <Markdown body={markdown} theme={theme} baseUrl={baseUrl} />;
  }

  const dark = isDarkSurface(c.surface0);
  const css = buildGithubCss(c);
  const srcDoc = buildSrcDoc(html, css, dark, id, mermaidSources, mermaidRuntime.status === "ready" ? mermaidRuntime.script : null);

  const scroll = rawHeight > maxHeight;
  const height = Math.min(Math.max(rawHeight, MIN_HEIGHT), maxHeight);

  return renderGithubIframe({ srcDoc, height, scroll });
}
