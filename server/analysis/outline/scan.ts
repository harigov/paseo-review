import { createHash } from "node:crypto";

// Shared, language-agnostic scanning helpers used by every per-language extractor: a brace/
// semicolon-balancing scanner for finding where a declaration ends, plus small text utilities
// (whitespace collapsing, signature truncation, body hashing).

export interface ScanOptions {
  /** Prefix that starts a line comment (e.g. "//", "#"); null if the language has none relevant here. */
  lineComment: string | null;
  /** [open, close] markers for a block comment (e.g. ["/*", "*\/"]); null to disable. */
  blockComment: [string, string] | null;
  /** Characters that open/close a string literal (escaped by a preceding backslash). */
  stringChars: string[];
}

export interface ScanResult {
  /** 0-based, inclusive line index where the declaration ends. */
  endLineIdx: number;
  /** Whether a `{ ... }` body was found and balanced (false => ended at a top-level `;` or EOF). */
  hasBody: boolean;
}

const DEFAULT_MAX_LINES = 4000;

/** Suffixes that mean a header line is not finished yet — the declaration continues onto the
 * next line even though no brace has opened and no semicolon has been seen (e.g. a body-less
 * arrow function whose parameter list wraps, or a multi-line generic constraint). */
const CONTINUATION_SUFFIXES = [",", "(", "[", "{", "=>", "=", "&&", "||", "?", ":", "+", "-", "*", "/", "|", "&", ".", "<"];

function endsWithContinuation(s: string): boolean {
  return CONTINUATION_SUFFIXES.some((tok) => s.endsWith(tok));
}

function nextNonBlankLineIdx(lines: string[], fromIdx: number): number {
  for (let k = fromIdx; k < lines.length; k++) {
    if (!isBlankLine(lines[k])) return k;
  }
  return -1;
}

/**
 * Scans forward from `startLineIdx` (the declaration's header line) to find where the
 * declaration ends: either the line where a brace opened on/after the header returns to depth
 * zero, or — if no brace is ever opened — the first top-level `;` (a body-less declaration like
 * a variable, type alias, or an interface method stub), or the end of the header line itself for
 * a body-less declaration in a semicolon-free codebase (e.g. `const inc = (a) => a + 1`), judged
 * by the next line starting back at column 0. Ignores braces/semicolons inside string literals,
 * line comments, and block comments. A `{`/`}` pair is also ignored while inside a parenthesised
 * parameter list or (before the body starts) inside angle brackets, so a destructured parameter
 * type or a generic constraint — `function F({ a }: { a: string })`, `Promise<{ a: string }>`,
 * `class Foo<T extends { id: string }>` — isn't mistaken for the body; and when a depth-zero
 * brace group closes but the rest of the line (after whitespace) starts with another `{`, that
 * group was a bare object-literal return type (`function f(): { a: string } {`), not the body,
 * so scanning keeps going for the real one. Best-effort only: doesn't understand nested
 * template-literal interpolation or (for Rust) lifetime-annotation quotes — callers pass
 * `stringChars` without `'` where that would misfire.
 */
export function scanDeclarationEnd(lines: string[], startLineIdx: number, opts: ScanOptions, maxLines = DEFAULT_MAX_LINES): ScanResult {
  let depth = 0;
  let sawBrace = false;
  // Braces inside a parenthesised parameter list — `function F({ a, b }: { a: string }) {` or a
  // multi-line destructured React props object — are not the body; the body brace comes after
  // the parentheses close.
  let parenDepth = 0;
  // Angle-bracket depth, tracked only before the body starts and outside parentheses — braces
  // inside a generic constraint or return-type argument (`Promise<{ a: string }>`) are ignored
  // just like braces inside parens.
  let angleDepth = 0;
  let inBlockComment = false;
  let inString: string | null = null;
  const limit = Math.min(lines.length, startLineIdx + maxLines);

  for (let li = startLineIdx; li < limit; li++) {
    const line = lines[li];
    let ci = 0;
    let lineContentEnd = line.length;
    let openBlockCommentAt: number | null = null;
    while (ci < line.length) {
      if (inBlockComment) {
        const closeIdx = line.indexOf(opts.blockComment![1], ci);
        if (closeIdx === -1) {
          lineContentEnd = Math.min(lineContentEnd, openBlockCommentAt ?? 0);
          ci = line.length;
        } else {
          inBlockComment = false;
          openBlockCommentAt = null;
          ci = closeIdx + opts.blockComment![1].length;
        }
        continue;
      }
      if (inString !== null) {
        const ch = line[ci];
        if (ch === "\\") {
          ci += 2;
          continue;
        }
        if (ch === inString) inString = null;
        ci++;
        continue;
      }
      if (opts.lineComment && line.startsWith(opts.lineComment, ci)) {
        lineContentEnd = Math.min(lineContentEnd, ci);
        ci = line.length;
        continue;
      }
      if (opts.blockComment && line.startsWith(opts.blockComment[0], ci)) {
        inBlockComment = true;
        openBlockCommentAt = ci;
        ci += opts.blockComment[0].length;
        continue;
      }
      const ch = line[ci];
      if (opts.stringChars.includes(ch)) {
        inString = ch;
        ci++;
        continue;
      }
      if (ch === "(") {
        parenDepth++;
        ci++;
        continue;
      }
      if (ch === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
        ci++;
        continue;
      }
      if (!sawBrace && parenDepth === 0) {
        if (ch === "<") {
          angleDepth++;
          ci++;
          continue;
        }
        if (ch === ">") {
          if (line[ci - 1] !== "=") angleDepth = Math.max(0, angleDepth - 1);
          ci++;
          continue;
        }
      }
      if (ch === "{") {
        if (parenDepth === 0 && angleDepth === 0) {
          depth++;
          sawBrace = true;
        }
        ci++;
        continue;
      }
      if (ch === "}") {
        ci++;
        if (parenDepth === 0 && angleDepth === 0) {
          depth--;
          if (sawBrace && depth <= 0) {
            let restIdx = ci;
            while (restIdx < line.length && (line[restIdx] === " " || line[restIdx] === "\t")) restIdx++;
            if (restIdx < line.length && line[restIdx] === "{") {
              // The group that just closed was a type literal (e.g. a bare object-literal
              // return type), not the body — the real body brace follows later on this line.
              sawBrace = false;
              depth = 0;
            } else {
              return { endLineIdx: li, hasBody: true };
            }
          }
        }
        continue;
      }
      if (ch === ";" && depth === 0 && parenDepth === 0 && !sawBrace) return { endLineIdx: li, hasBody: false };
      ci++;
    }

    // No body brace seen yet and not mid-parameter-list: a body-less declaration in a
    // semicolon-free codebase ends on its header line once the line doesn't trail off with a
    // continuation token and the next line doesn't keep going at the same (or deeper) indent.
    if (!sawBrace && parenDepth === 0) {
      const effective = line.slice(0, lineContentEnd).trimEnd();
      if (effective.length > 0 && !endsWithContinuation(effective)) {
        const nextIdx = nextNonBlankLineIdx(lines, li + 1);
        if (nextIdx === -1 || indentWidth(lines[nextIdx]) === 0) {
          return { endLineIdx: li, hasBody: false };
        }
      }
    }
  }
  return { endLineIdx: Math.max(startLineIdx, limit - 1), hasBody: sawBrace };
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncateSignature(s: string, max = 200): string {
  const collapsed = collapseWhitespace(s);
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

export function normalizeBody(lines: string[]): string {
  return collapseWhitespace(lines.join(" "));
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Normalised bodies shorter than this are too trivial to anchor a rename/move match. */
export const SUBSTANTIAL_MIN_LENGTH = 40;

export function isSubstantialBody(normalized: string): boolean {
  return normalized.length >= SUBSTANTIAL_MIN_LENGTH;
}

export function indentWidth(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

export function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}
