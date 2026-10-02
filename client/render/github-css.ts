// Pure TypeScript: builds a GitHub-`markdown-body`-flavoured stylesheet string from the
// plugin's theme colours. No DOM, no React — this is interpolated straight into a `<style>`
// tag inside GithubHtmlView's iframe `srcDoc`, so it must come back as one self-contained
// string with every rule scoped under `.markdown-body` (the class GithubHtmlView puts on the
// `<article>` wrapping GitHub's `bodyHTML`).

export interface GithubCssColors {
  foreground: string;
  foregroundMuted: string;
  surface0: string;
  surface1: string;
  surface2: string;
  border: string;
  accent: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
}

/** Parses `#rgb`/`#rrggbb` and returns an `rgba(...)` string at the given alpha; falls back to
 * the original (opaque) value, rather than guessing, when the format isn't recognized. */
function hexToRgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const full = match[1]!.length === 3 ? match[1]!.split("").map((ch) => ch + ch).join("") : match[1]!;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function buildGithubCss(c: GithubCssColors): string {
  const zebra = hexToRgba(c.surface1, 0.4);

  return `
html, body { margin: 0; padding: 0; background: ${c.surface0}; }

.markdown-body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  font-size: 14px;
  line-height: 1.5;
  color: ${c.foreground};
  background: ${c.surface0};
  padding: 14px 16px;
  word-wrap: break-word;
}

.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 {
  font-weight: 600;
  line-height: 1.25;
  margin-top: 20px;
  margin-bottom: 14px;
  color: ${c.foreground};
}
.markdown-body h1 { font-size: 1.6em; padding-bottom: 0.3em; border-bottom: 1px solid ${c.border}; }
.markdown-body h2 { font-size: 1.3em; padding-bottom: 0.3em; border-bottom: 1px solid ${c.border}; }
.markdown-body h3 { font-size: 1.15em; }
.markdown-body h4 { font-size: 1em; }
.markdown-body h5 { font-size: 0.9em; }
.markdown-body h6 { font-size: 0.85em; color: ${c.foregroundMuted}; }

.markdown-body .anchor { display: none; }

.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body dl, .markdown-body table, .markdown-body pre, .markdown-body blockquote {
  margin-top: 0;
  margin-bottom: 14px;
}
.markdown-body ul, .markdown-body ol { padding-left: 1.8em; }
.markdown-body li { margin-top: 0.2em; }
.markdown-body li > ul, .markdown-body li > ol { margin-top: 0.2em; margin-bottom: 0; }
.markdown-body li + li { margin-top: 0.25em; }

.markdown-body code, .markdown-body tt {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 85%;
  background: ${c.surface2};
  padding: 0.15em 0.3em;
  border-radius: 4px;
}
.markdown-body pre {
  background: ${c.surface1};
  border: 1px solid ${c.border};
  border-radius: 6px;
  overflow: auto;
  padding: 12px;
  font-size: 12px;
  line-height: 1.45;
}
.markdown-body pre code, .markdown-body pre tt {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: 100%;
}

.markdown-body blockquote {
  padding: 0 1em;
  color: ${c.foregroundMuted};
  border-left: 3px solid ${c.border};
  margin-left: 0;
}
.markdown-body blockquote > :last-child { margin-bottom: 0; }

.markdown-body .markdown-alert {
  padding: 10px 14px;
  margin-bottom: 14px;
  border-left: 3px solid ${c.accent};
  background: ${c.surface1};
  border-radius: 4px;
}
.markdown-body .markdown-alert-title {
  font-weight: 600;
  color: ${c.accent};
}
.markdown-body .markdown-alert > :last-child { margin-bottom: 0; }
.markdown-body .markdown-alert-note { border-left-color: ${c.accent}; }
.markdown-body .markdown-alert-note .markdown-alert-title { color: ${c.accent}; }
.markdown-body .markdown-alert-tip { border-left-color: ${c.statusSuccess}; }
.markdown-body .markdown-alert-tip .markdown-alert-title { color: ${c.statusSuccess}; }
.markdown-body .markdown-alert-important { border-left-color: ${c.accent}; }
.markdown-body .markdown-alert-important .markdown-alert-title { color: ${c.accent}; }
.markdown-body .markdown-alert-warning { border-left-color: ${c.statusWarning}; }
.markdown-body .markdown-alert-warning .markdown-alert-title { color: ${c.statusWarning}; }
.markdown-body .markdown-alert-caution { border-left-color: ${c.statusDanger}; }
.markdown-body .markdown-alert-caution .markdown-alert-title { color: ${c.statusDanger}; }

.markdown-body table {
  border-collapse: collapse;
  width: max-content;
  max-width: 100%;
}
.markdown-body table th, .markdown-body table td {
  padding: 6px 12px;
  border: 1px solid ${c.border};
}
.markdown-body table th {
  background: ${c.surface1};
  font-weight: 600;
}
.markdown-body table tr:nth-child(2n) {
  background: ${zebra};
}

.markdown-body img {
  max-width: 100%;
  box-sizing: content-box;
}
.markdown-body img:not([width]):not([height]) {
  height: auto;
}

.markdown-body video {
  max-width: 100%;
}

.markdown-body .prr-mermaid-diagram {
  margin: 14px 0;
  overflow-x: auto;
}
.markdown-body .prr-mermaid-diagram svg {
  max-width: 100%;
}
.markdown-body .prr-mermaid-error {
  color: ${c.statusDanger};
  font-size: 12px;
  margin-top: 6px;
}

.markdown-body details > summary {
  cursor: pointer;
}
.markdown-body details > summary::marker,
.markdown-body details > summary::-webkit-details-marker {
  color: ${c.foregroundMuted};
}

.markdown-body kbd {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 85%;
  padding: 2px 6px;
  color: ${c.foreground};
  background: ${c.surface1};
  border: 1px solid ${c.border};
  border-bottom-width: 2px;
  border-radius: 6px;
}

.markdown-body sup, .markdown-body sub {
  font-size: 75%;
  vertical-align: baseline;
  position: relative;
}
.markdown-body sup { top: -0.5em; }
.markdown-body sub { bottom: -0.25em; }

.markdown-body hr {
  height: 1px;
  padding: 0;
  margin: 20px 0;
  background: ${c.border};
  border: 0;
}

.markdown-body a {
  color: ${c.accent};
  text-decoration: none;
}
.markdown-body a:hover {
  text-decoration: underline;
}

.markdown-body .task-list-item {
  list-style-type: none;
}
.markdown-body .contains-task-list {
  padding-left: 1.2em;
}
.markdown-body .task-list-item input[type="checkbox"] {
  margin: 0 0.5em 0 -1.4em;
  vertical-align: middle;
}

.markdown-body g-emoji {
  font-size: 1.1em;
  line-height: 1;
  vertical-align: -0.1em;
}

.markdown-body .user-mention {
  font-weight: 600;
  color: ${c.accent};
}

/* GitHub syntax-highlighting classes used inside fenced code blocks in bodyHTML. Restrained to
   a 5-colour palette drawn from the theme: accent, statusSuccess, statusWarning, foreground,
   and foregroundMuted — enough to separate comments/keywords/strings/names without inventing
   colours the rest of the theme doesn't have. */
.markdown-body .pl-c { color: ${c.foregroundMuted}; font-style: italic; }
.markdown-body .pl-k { color: ${c.accent}; }
.markdown-body .pl-s, .markdown-body .pl-pds { color: ${c.statusSuccess}; }
.markdown-body .pl-en { color: ${c.statusWarning}; }
.markdown-body .pl-c1 { color: ${c.statusWarning}; }
.markdown-body .pl-v { color: ${c.foreground}; }
.markdown-body .pl-smi { color: ${c.foreground}; }
.markdown-body .pl-e { color: ${c.foreground}; }
.markdown-body .pl-ent { color: ${c.accent}; }
`;
}
