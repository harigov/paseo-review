// Pure preprocessing helpers for the markdown renderer: dropping HTML comments before marked
// ever sees them, turning `@mentions` / `#123` / `owner/repo#123` into link segments, and
// recognising GitHub's `[!NOTE]`-style alert markers. No React/RN imports, so this is unit
// tested directly under the server tsconfig.

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Removes `<!-- ... -->` blocks (which may span multiple lines) anywhere in the body, except
 * inside fenced code blocks (``` or ~~~), which are left byte-for-byte untouched.
 */
export function stripHtmlComments(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  function flush() {
    if (buffer.length === 0) return;
    out.push(buffer.join("\n").replace(COMMENT_RE, ""));
    buffer = [];
  }

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (!inFence) {
        flush();
        out.push(line);
        inFence = true;
      } else {
        out.push(line);
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      out.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out.join("\n");
}

export interface LinkifySegment {
  text: string;
  href?: string;
}

// `@login` — not preceded by a word/`.`/`@`/`-` char (so `a@b.com` is left alone) and not
// immediately followed by one (so it doesn't eat into a trailing word).
const MENTION_RE = /(?<![\w.@-])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})?)(?![\w-])/g;
// `owner/repo#123` cross-repo issue/PR reference.
const CROSS_REPO_ISSUE_RE = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g;
// Bare `#123`, but not the `#123` tail of an `owner/repo#123` match (word char before `#`).
const ISSUE_RE = /(?<![\w/])#(\d+)\b/g;

function repoOrigin(baseUrl: string): { origin: string; owner: string; repo: string } | null {
  const match = /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)/i.exec(baseUrl);
  if (!match) return null;
  return { origin: match[1]!, owner: match[2]!, repo: match[3]! };
}

interface RawMatch {
  start: number;
  end: number;
  href: string;
}

/**
 * Splits `text` into plain-text / linked segments, turning `@login` into a profile link and
 * `#123` / `owner/repo#123` into issue links (resolved against the PR's own repo, derived from
 * `baseUrl`). Does not linkify SHAs, and never matches inside a word or an email address.
 */
export function linkifyGithubRefs(text: string, baseUrl: string): LinkifySegment[] {
  const repo = repoOrigin(baseUrl);
  const matches: RawMatch[] = [];

  for (const m of text.matchAll(MENTION_RE)) {
    matches.push({ start: m.index!, end: m.index! + m[0].length, href: `https://github.com/${m[1]}` });
  }
  if (repo) {
    for (const m of text.matchAll(CROSS_REPO_ISSUE_RE)) {
      matches.push({ start: m.index!, end: m.index! + m[0].length, href: `${repo.origin}/${m[1]}/issues/${m[2]}` });
    }
    for (const m of text.matchAll(ISSUE_RE)) {
      matches.push({ start: m.index!, end: m.index! + m[0].length, href: `${repo.origin}/${repo.owner}/${repo.repo}/issues/${m[1]}` });
    }
  }

  if (matches.length === 0) return [{ text }];

  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const resolved: RawMatch[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start < lastEnd) continue; // overlaps an already-accepted match — skip
    resolved.push(m);
    lastEnd = m.end;
  }

  const segments: LinkifySegment[] = [];
  let cursor = 0;
  for (const m of resolved) {
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start) });
    segments.push({ text: text.slice(m.start, m.end), href: m.href });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

export type AlertKind = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;

/** Recognises a GitHub alert marker (`[!NOTE]` etc) at the start of a blockquote's first line. */
export function detectAlert(firstLine: string): { kind: AlertKind; rest: string } | null {
  const match = ALERT_RE.exec(firstLine.trim());
  if (!match) return null;
  return { kind: match[1]!.toUpperCase() as AlertKind, rest: (match[2] ?? "").trim() };
}
