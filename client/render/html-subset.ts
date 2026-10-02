// A tolerant parser for the small sanitised HTML subset GitHub lets through in PR bodies,
// review comments and bot-generated markdown (details/summary, div/p/section, tables, images,
// links, formatting tags, etc). Pure TypeScript — no React/RN imports — so it can be unit
// tested under the server tsconfig and reused by both the block and inline renderers in
// Markdown.tsx.

export type HtmlNode =
  | { type: "element"; tag: string; attrs: Record<string, string>; children: HtmlNode[] }
  | { type: "text"; text: string };

/** Elements that never take children, per the HTML spec (void elements). */
const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "meta", "link", "col", "wbr"]);

/** Elements whose entire content (including nested-looking markup) is opaque and dropped. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

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

    const node: HtmlNode = { type: "element", tag: tagName, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing && !VOID_TAGS.has(tagName)) {
      stack.push({ tag: tagName, children: (node as { children: HtmlNode[] }).children });
    }
  }

  pushTextRun(len);
  flushTextNode();
  return root.children;
}
