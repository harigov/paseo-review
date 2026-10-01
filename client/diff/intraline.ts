/**
 * Pure word-level (intra-line) diff helper.
 *
 * Given the old and new text of a single changed line, `intralineDiff` finds which *tokens*
 * (words, whitespace runs, and individual punctuation characters) were added or removed, so a
 * renderer can highlight just the changed words inside an otherwise-unchanged line instead of
 * tinting the whole line uniformly. `applySpansToTokens` then lets a caller project those char
 * spans onto an already-syntax-highlighted token array (e.g. from `@getpaseo/highlight`),
 * splitting tokens that straddle a span boundary. `intralineForPairs` pairs up a del-run and an
 * add-run positionally (the same shape `pairHunkLines` in `pairing.ts` uses for a hunk) and runs
 * `intralineDiff` once per pair, which is how S2 is expected to call this per del/add block.
 */

/** A half-open `[start, end)` character offset range within a line's text. */
export interface Span {
  start: number;
  end: number;
}

export interface IntralineResult {
  old: Span[];
  new: Span[];
  /** true when the lines differ too much to be worth highlighting (whole line changed). */
  whole: boolean;
}

/** A tokenized piece of a line's text, with its char offsets in that line. */
interface Token {
  text: string;
  start: number;
  end: number;
  whitespace: boolean;
}

const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_MIN_SIMILARITY = 0.3;

// Word runs (identifier-shaped), whitespace runs, then one punctuation character at a time —
// the first two alternatives are greedy runs, so anything left over (a lone `.`, `(`, etc.) falls
// through to the single-character alternative instead of being grouped with its neighbors.
const TOKEN_RE = /[A-Za-z0-9_$]+|\s+|./g;

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    const text = match[0];
    const start = match.index;
    tokens.push({ text, start, end: start + text.length, whitespace: /^\s+$/.test(text) });
  }
  return tokens;
}

/**
 * Longest common subsequence between two token sequences, matched by exact token text, computed
 * by the standard O(n*m) DP table (filled backwards so the subsequence can be recovered by a
 * forward scan). Returns index pairs `[oldIndex, newIndex]` in increasing order on both sides.
 */
function lcsPairs(a: Token[], b: Token[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i].text === b[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text && dp[i][j] === dp[i + 1][j + 1] + 1) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Turns the tokens *not* in `matched` into merged spans covering each maximal unmatched run. */
function buildSpans(tokens: Token[], matched: Set<number>): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (matched.has(i)) {
      i += 1;
      continue;
    }
    const start = tokens[i].start;
    let j = i;
    while (j < tokens.length && !matched.has(j)) j += 1;
    spans.push({ start, end: tokens[j - 1].end });
    i = j;
  }
  return spans;
}

function isWhitespaceOnly(text: string, span: Span): boolean {
  return /^\s*$/.test(text.slice(span.start, span.end));
}

/**
 * Diffs two line strings at the token level. See the module doc comment for the overall
 * approach; `options.maxTokens` and `options.minSimilarity` default to 300 and 0.3.
 */
export function intralineDiff(
  oldText: string,
  newText: string,
  options?: { maxTokens?: number; minSimilarity?: number },
): IntralineResult {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const minSimilarity = options?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);

  if (oldTokens.length > maxTokens || newTokens.length > maxTokens) {
    return { old: [], new: [], whole: true };
  }

  const pairs = lcsPairs(oldTokens, newTokens);

  const oldNonWsCount = oldTokens.filter((t) => !t.whitespace).length;
  const newNonWsCount = newTokens.filter((t) => !t.whitespace).length;
  const maxNonWs = Math.max(oldNonWsCount, newNonWsCount);
  const matchedNonWsCount = pairs.filter(([oi]) => !oldTokens[oi].whitespace).length;
  if (maxNonWs > 0 && matchedNonWsCount / maxNonWs < minSimilarity) {
    return { old: [], new: [], whole: true };
  }

  const matchedOld = new Set(pairs.map(([oi]) => oi));
  const matchedNew = new Set(pairs.map(([, ni]) => ni));
  const oldSpans = buildSpans(oldTokens, matchedOld);
  const newSpans = buildSpans(newTokens, matchedNew);

  const oldWsOnly = oldSpans.map((span) => isWhitespaceOnly(oldText, span));
  const newWsOnly = newSpans.map((span) => isWhitespaceOnly(newText, span));
  const hasNonWhitespaceChange = oldWsOnly.includes(false) || newWsOnly.includes(false);

  if (hasNonWhitespaceChange) {
    return {
      old: oldSpans.filter((_, idx) => !oldWsOnly[idx]),
      new: newSpans.filter((_, idx) => !newWsOnly[idx]),
      whole: false,
    };
  }
  return { old: oldSpans, new: newSpans, whole: false };
}

/**
 * Splits highlight tokens (objects carrying at least `text`, e.g. `HighlightToken` from
 * `@getpaseo/highlight`) at `spans`' char boundaries, assuming the tokens are given in order and
 * their `text` lengths sum to the full line (so a token's offset is the running total of the
 * lengths of the tokens before it). Every other property on each token is preserved by spreading
 * it onto each piece. With no spans, returns the tokens unchanged plus `emphasized: false`.
 */
export function applySpansToTokens<T extends { text: string }>(
  tokens: T[],
  spans: Span[],
): Array<T & { emphasized: boolean }> {
  if (spans.length === 0) {
    return tokens.map((token) => ({ ...token, emphasized: false }));
  }
  const result: Array<T & { emphasized: boolean }> = [];
  let offset = 0;
  for (const token of tokens) {
    const tokenStart = offset;
    const tokenEnd = offset + token.text.length;
    offset = tokenEnd;
    if (tokenStart === tokenEnd) {
      result.push({ ...token, emphasized: false });
      continue;
    }
    const cuts = new Set<number>([tokenStart, tokenEnd]);
    for (const span of spans) {
      if (span.start > tokenStart && span.start < tokenEnd) cuts.add(span.start);
      if (span.end > tokenStart && span.end < tokenEnd) cuts.add(span.end);
    }
    const points = Array.from(cuts).sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i += 1) {
      const segStart = points[i];
      const segEnd = points[i + 1];
      const text = token.text.slice(segStart - tokenStart, segEnd - tokenStart);
      const emphasized = spans.some((span) => segStart >= span.start && segEnd <= span.end);
      result.push({ ...token, text, emphasized });
    }
  }
  return result;
}

/**
 * Pairs `oldLines` and `newLines` positionally — like `pairHunkLines` pairs a del-run followed by
 * an add-run, del[k] with add[k] — and runs `intralineDiff` on each pair. Whichever side has
 * fewer lines leaves its extra lines paired with nothing: an unpaired old line yields a single
 * span covering its whole text on the old side (nothing on the new side), and an unpaired new
 * line yields a single span covering its whole text on the new side (nothing on the old side);
 * both report `whole: false` since there's no "lines differ too much" judgment to make when
 * there is no counterpart to compare against.
 */
export function intralineForPairs(
  oldLines: string[],
  newLines: string[],
  options?: { maxTokens?: number; minSimilarity?: number },
): IntralineResult[] {
  const runLength = Math.max(oldLines.length, newLines.length);
  const results: IntralineResult[] = [];
  for (let k = 0; k < runLength; k += 1) {
    const oldLine = k < oldLines.length ? oldLines[k] : null;
    const newLine = k < newLines.length ? newLines[k] : null;
    if (oldLine !== null && newLine !== null) {
      results.push(intralineDiff(oldLine, newLine, options));
    } else if (oldLine !== null) {
      results.push({ old: oldLine.length ? [{ start: 0, end: oldLine.length }] : [], new: [], whole: false });
    } else if (newLine !== null) {
      results.push({ old: [], new: newLine.length ? [{ start: 0, end: newLine.length }] : [], whole: false });
    }
  }
  return results;
}
