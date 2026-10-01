import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Markdown } from "./Markdown";
import { renderGithubIframe } from "./html-web";
import { buildGithubCss } from "./github-css";

// Module-level counter for `id` generation below: GithubHtmlView instances post/receive
// window messages tagged with a per-instance id so one card's iframe can't move another
// card's height or trigger another card's link — a counter + Math.random keeps ids unique
// without pulling in a DOM/crypto API that isn't available in this no-DOM-lib file's callers.
let instanceCounter = 0;

const MIN_HEIGHT = 60;
const INITIAL_HEIGHT = 160;

/** Parses `#rgb`/`#rrggbb`; returns null (rather than guessing) when the format is unknown.
 * Mirrors the luminance test FileDiffView.tsx uses on `theme.colors.surface0` to decide
 * dark vs. light, duplicated here because that file is out of scope for this change. */
function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const full = match[1]!.length === 3 ? match[1]!.split("").map((ch) => ch + ch).join("") : match[1]!;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** Only `https:` URLs may be opened; root-relative hrefs (`/owner/repo/...`) are resolved
 * against github.com first. Everything else (http:, javascript:, mailto:, bare fragments, …)
 * is dropped rather than guessed at. */
function resolveExternalHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `https://github.com${trimmed}`;
  return null;
}

function buildSrcDoc(html: string, css: string, dark: boolean, id: string): string {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src data:; media-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
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
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${dark ? "dark" : "light"}"><base target="_blank"><style>${css}</style></head><body><article class="markdown-body">${html}</article><script>${script}</script></body></html>`;
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

  const surfaceLuminance = luminance(c.surface0);
  // Fail open to "light" when the theme doesn't hand back a parseable hex color, same as
  // FileDiffView does for its own surface0-driven syntax palette choice.
  const dark = surfaceLuminance !== null && surfaceLuminance < 128;
  const css = buildGithubCss(c);
  const srcDoc = buildSrcDoc(html, css, dark, id);

  const scroll = rawHeight > maxHeight;
  const height = Math.min(Math.max(rawHeight, MIN_HEIGHT), maxHeight);

  return renderGithubIframe({ srcDoc, height, scroll });
}
