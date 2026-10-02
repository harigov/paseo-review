// A tolerant parser for the small sanitised HTML subset GitHub lets through in PR bodies,
// review comments and bot-generated markdown (details/summary, div/p/section, tables, images,
// links, formatting tags, etc). Pure TypeScript — no React/RN imports — so it can be unit
// tested under the server tsconfig and reused by both the block and inline renderers in
// Markdown.tsx.

export type HtmlNode =
  | {
      type: "element";
      tag: string;
      attrs: Record<string, string>;
      children: HtmlNode[];
      /** Only populated for tags in `RAW_OUTER_HTML_TAGS` (currently just `svg`): the element's
       * exact original markup, byte-for-byte, for callers (inline SVG → data URI) that need to
       * pass it through unparsed rather than re-serialize the tree. */
      raw?: string;
    }
  | { type: "text"; text: string };

export type HtmlElement = Extract<HtmlNode, { type: "element" }>;

/** Elements that never take children, per the HTML spec (void elements). */
const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "meta", "link", "col", "wbr"]);

/** Elements whose entire content (including nested-looking markup) is opaque and dropped. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

/** Elements that additionally get their exact original markup captured onto `raw` (see
 * `HtmlNode`) once their matching close tag (or end of input) is found. Kept to a minimal,
 * explicit allowlist — rather than capturing it for every element — so this stays cheap and so
 * existing exact-shape assertions elsewhere (`toEqual` against a literal tree) aren't disturbed
 * by a surprise extra field. */
const RAW_OUTER_HTML_TAGS = new Set(["svg"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  times: "×",
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Decodes the common named entities above plus decimal (`&#39;`) and hex (`&#x27;`) refs. */
export function decodeEntities(text: string): string {
  if (!text || text.indexOf("&") === -1) return text;
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const num = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(num);
      } catch {
        return whole;
      }
    }
    const value = NAMED_ENTITIES[body];
    return value !== undefined ? value : whole;
  });
}

interface Frame {
  tag: string | null; // null marks the synthetic root frame
  children: HtmlNode[];
  /** Set only when `tag` is in `RAW_OUTER_HTML_TAGS`: the node to backfill with raw outer HTML,
   * and the source index of its opening "<", once this frame closes (or input ends). */
  node?: HtmlElement;
  rawStart?: number;
}

const WHITESPACE_RE = /\s/;
const OPEN_TAG_NAME_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)/;
const CLOSE_TAG_RE = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/;
const ATTR_NAME_RE = /^[^\s=/>]+/;
const UNQUOTED_VALUE_RE = /^[^\s>]*/;

/**
 * Tokenizes + builds a tree from an HTML fragment using a scanner and an explicit element
 * stack (not a single nesting-unaware regex pass). Comments are dropped, void elements never
 * get children, `<script>`/`<style>` and their raw content are dropped entirely, unclosed tags
 * are implicitly closed at the end of input (or when an ancestor closes), and stray closing
 * tags are ignored. Attribute values may be single-quoted, double-quoted, or unquoted.
 */
export function parseHtmlFragment(html: string): HtmlNode[] {
  const root: Frame = { tag: null, children: [] };
  const stack: Frame[] = [root];
  const len = html.length;
  let i = 0;
  let textStart = -1;
  let textParts: string[] = [];

  // Captures the pending plain-text run (if any) into `textParts` without turning it into a
  // node yet. Safe to call at any boundary, including ones that don't change the current
  // frame (a dropped comment, a stray closing tag) — that's what lets text on either side of
  // e.g. `a<!-- x -->b` merge into a single "ab" text node.
  function pushTextRun(end: number) {
    if (textStart !== -1 && end > textStart) textParts.push(html.slice(textStart, end));
    textStart = -1;
  }

  // Turns any accumulated text run into a node attached to the *current* top frame. Must be
  // called before the top frame changes (a new element is appended, or a matched closing tag
  // pops frames), so text ends up attached to the right parent.
  function flushTextNode() {
    if (textParts.length > 0) {
      stack[stack.length - 1]!.children.push({ type: "text", text: textParts.join("") });
      textParts = [];
    }
  }

  while (i < len) {
    if (html[i] !== "<") {
      if (textStart === -1) textStart = i;
      i++;
      continue;
    }

    // HTML comment: drop entirely (including unterminated ones, to end of input). Frame-
    // neutral, so just fold the text on either side together.
    if (html.startsWith("<!--", i)) {
      pushTextRun(i);
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    // Other bang declarations (e.g. doctype) — drop the tag, keep nothing. Also frame-neutral.
    if (html.startsWith("<!", i)) {
      pushTextRun(i);
      const end = html.indexOf(">", i);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // Closing tag.
    if (html[i + 1] === "/") {
      const match = CLOSE_TAG_RE.exec(html.slice(i));
      if (!match) {
        // Not a well-formed closing tag; treat the "<" as literal text.
        if (textStart === -1) textStart = i;
        i++;
        continue;
      }
      pushTextRun(i);
      const tagName = match[1]!.toLowerCase();
      let foundIdx = -1;
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s]!.tag === tagName) {
          foundIdx = s;
          break;
        }
      }
      if (foundIdx !== -1) {
        // Closes the matched frame (and implicitly any still-open descendants above it) — the
        // frame is changing, so finalize the pending text into it first.
        flushTextNode();
        const frame = stack[foundIdx]!;
        if (frame.node && frame.rawStart !== undefined) {
          frame.node.raw = html.slice(frame.rawStart, i + match[0].length);
        }
        stack.length = foundIdx;
      }
      // else: stray closing tag with no matching open ancestor — frame-neutral, ignored.
      i += match[0].length;
      continue;
    }

    // Opening tag?
    const openMatch = OPEN_TAG_NAME_RE.exec(html.slice(i));
    if (!openMatch) {
      if (textStart === -1) textStart = i;
      i++;
      continue;
    }

    const tagStart = i; // position of this tag's "<", for RAW_OUTER_HTML_TAGS capture below
    pushTextRun(i);
    flushTextNode();
    const tagName = openMatch[1]!.toLowerCase();
    let j = i + openMatch[0].length;
    const attrs: Record<string, string> = {};
    let selfClosing = false;

    attrLoop: while (j < len) {
      while (j < len && WHITESPACE_RE.test(html[j]!)) j++;
      if (j >= len) break;
      const ch = html[j];
      if (ch === "/") {
        if (html[j + 1] === ">") {
          selfClosing = true;
          j += 2;
        } else {
          j++;
        }
        break attrLoop;
      }
      if (ch === ">") {
        j++;
        break attrLoop;
      }
      const nameMatch = ATTR_NAME_RE.exec(html.slice(j));
      if (!nameMatch || nameMatch[0].length === 0) {
        // Stray '=' or similar — skip one char to make progress.
        j++;
        continue;
      }
      const attrName = nameMatch[0].toLowerCase();
      j += nameMatch[0].length;
      while (j < len && WHITESPACE_RE.test(html[j]!)) j++;
      let attrValue = "";
      if (html[j] === "=") {
        j++;
        while (j < len && WHITESPACE_RE.test(html[j]!)) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          j++;
          const endQuote = html.indexOf(quote, j);
          const valueEnd = endQuote === -1 ? len : endQuote;
          attrValue = html.slice(j, valueEnd);
          j = endQuote === -1 ? len : endQuote + 1;
        } else {
          const valueMatch = UNQUOTED_VALUE_RE.exec(html.slice(j));
          attrValue = valueMatch ? valueMatch[0] : "";
          j += attrValue.length;
          // An unquoted value can swallow a trailing self-close slash (e.g. `foo=bar/>`).
          if (attrValue.endsWith("/") && html[j] === ">") {
            attrValue = attrValue.slice(0, -1);
            selfClosing = true;
          }
        }
      }
      attrs[attrName] = attrValue;
    }
    i = Math.min(j, len);

    if (RAW_TEXT_TAGS.has(tagName) && !selfClosing) {
      const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
      const match = closeRe.exec(html.slice(i));
      i = match ? i + match.index + match[0].length : len;
      continue; // The whole element and its raw content are dropped — no node emitted.
    }

    const node: HtmlElement = { type: "element", tag: tagName, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    const capturesRaw = RAW_OUTER_HTML_TAGS.has(tagName);
    if (!selfClosing && !VOID_TAGS.has(tagName)) {
      const frame: Frame = { tag: tagName, children: node.children };
      if (capturesRaw) {
        frame.node = node;
        frame.rawStart = tagStart;
      }
      stack.push(frame);
    } else if (capturesRaw) {
      // Self-closing (or void, though none of RAW_OUTER_HTML_TAGS are void): the tag itself is
      // the whole element, so its raw outer HTML is just what was just scanned.
      node.raw = html.slice(tagStart, i);
    }
  }

  pushTextRun(len);
  flushTextNode();
  // Any still-open RAW_OUTER_HTML_TAGS frame (unterminated input) gets the rest of the string as
  // its best-effort raw outer HTML, rather than leaving `raw` unset.
  for (let s = stack.length - 1; s >= 1; s--) {
    const frame = stack[s]!;
    if (frame.node && frame.rawStart !== undefined) frame.node.raw = html.slice(frame.rawStart, len);
  }
  return root.children;
}

// ---------- GitHub-bodyHTML mermaid detection/extraction (GithubHtmlView) ----------

function textContent(nodes: HtmlNode[]): string {
  return nodes.map((n) => (n.type === "text" ? n.text : textContent(n.children))).join("");
}

function hasClassToken(attrs: Record<string, string>, token: string): boolean {
  return (attrs.class ?? "").split(/\s+/).includes(token);
}

/** `node` itself, else the first descendant (document order) matching `predicate`. */
function findSelfOrDescendant(node: HtmlElement, predicate: (el: HtmlElement) => boolean): HtmlElement | null {
  if (predicate(node)) return node;
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const found = findSelfOrDescendant(child, predicate);
    if (found) return found;
  }
  return null;
}

/**
 * Finds every mermaid diagram embedded in a GitHub `bodyHTML` document, in document order, and
 * returns its source text. Matches GitHub's own markup (`section[data-type="mermaid"]`, source
 * in a nested `[data-plain]` attribute, falling back to a nested `pre[lang="mermaid"]`'s text)
 * as well as a plain `<pre lang="mermaid">` or `<pre><code class="language-mermaid">` with no
 * wrapping section. Returns `[]` when there's nothing to render — the caller's signal not to
 * bother loading the (~3 MB) mermaid runtime at all.
 */
export function findMermaidSources(html: string): string[] {
  const sources: string[] = [];

  function visit(nodes: HtmlNode[]): void {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (node.tag === "section" && node.attrs["data-type"] === "mermaid") {
        const plainHolder = findSelfOrDescendant(node, (el) => "data-plain" in el.attrs);
        if (plainHolder) {
          sources.push(decodeEntities(plainHolder.attrs["data-plain"]!));
        } else {
          const pre = findSelfOrDescendant(node, (el) => el.tag === "pre");
          if (pre) sources.push(decodeEntities(textContent(pre.children)));
        }
        continue; // don't also match this section's own nested pre[lang="mermaid"] below
      }
      if (node.tag === "pre") {
        if (node.attrs.lang === "mermaid") {
          sources.push(decodeEntities(textContent(node.children)));
          continue;
        }
        const code = node.children.find(
          (c): c is HtmlElement => c.type === "element" && c.tag === "code" && hasClassToken(c.attrs, "language-mermaid"),
        );
        if (code) {
          sources.push(decodeEntities(textContent(code.children)));
          continue;
        }
      }
      visit(node.children);
    }
  }

  visit(parseHtmlFragment(html));
  return sources;
}

/** Cheap presence check for `class="mermaid"` (mermaid's own default marker class, which
 * `mermaid.run()` auto-detects) anywhere in an HTML document — used by `HtmlView` to decide
 * whether to load the runtime at all. */
export function hasMermaidClass(html: string): boolean {
  function visit(nodes: HtmlNode[]): boolean {
    return nodes.some((node) => node.type === "element" && (hasClassToken(node.attrs, "mermaid") || visit(node.children)));
  }
  return visit(parseHtmlFragment(html));
}

// ---------- inline <video> (Markdown.tsx) ----------

/** Resolves a `<video>` element's playable URL: its own `src`, else the first `<source src>`
 * child's. Null when neither is present. */
export function findVideoSrc(node: HtmlElement): string | null {
  if (node.attrs.src) return node.attrs.src;
  const source = node.children.find((c): c is HtmlElement => c.type === "element" && c.tag === "source" && Boolean(c.attrs.src));
  return source ? source.attrs.src! : null;
}

// ---------- inline <svg> → data URI (Markdown.tsx) ----------

/** Wraps raw SVG markup as a `data:` URI — script-free (an `<img>`/RN `Image` only ever decodes
 * the image, never executes it) and avoids re-serializing the parsed tree, which SVG's
 * stricter-than-HTML syntax (self-closing shape tags, `xmlns`, etc.) makes risky to get exactly
 * right from a parsed-and-rebuilt tree rather than the original bytes. */
export function svgDataUri(raw: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
}

const VIEWBOX_RE = /^\s*-?[\d.]+\s+-?[\d.]+\s+([\d.]+)\s+([\d.]+)\s*$/;

/** Intrinsic size for an `<svg>`, from its own `width`/`height` attributes when both are plain
 * numbers, else derived from `viewBox`'s width/height. Null when neither is usable, leaving the
 * caller to pick its own fallback size. */
export function svgDimensions(attrs: Record<string, string>): { width: number; height: number } | null {
  const width = Number(attrs.width);
  const height = Number(attrs.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return { width, height };
  const viewBox = VIEWBOX_RE.exec(attrs.viewBox ?? "");
  if (viewBox) {
    const vbWidth = Number(viewBox[1]);
    const vbHeight = Number(viewBox[2]);
    if (vbWidth > 0 && vbHeight > 0) return { width: vbWidth, height: vbHeight };
  }
  return null;
}
