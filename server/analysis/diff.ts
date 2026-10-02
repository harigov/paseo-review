import type { DiffLine, FileDiff, Hunk } from "../../shared/types";

const MAX_LINES_PER_FILE = 5000;

export interface ParsedFile {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  binary: boolean;
  truncated: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  movedLines: number;
  effectiveLines: number;
}

interface MutableLine extends DiffLine {}

/** Matches a C-quoted git path: `"` + (any char except `"`/`\`, or `\` + any char)* + `"`. */
const QUOTED_TOKEN = `"(?:[^"\\\\]|\\\\.)*"`;

/** Un-escapes a C-quoted git path (`\"`, `\\`, `\t`, `\n`, `\ooo` octal bytes); passes through unquoted text unchanged apart from stripping a trailing tab git appends for unquoted paths containing a space. */
function unquoteGitPath(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    const inner = t.slice(1, -1);
    let out = "";
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === "\\" && i + 1 < inner.length) {
        const n = inner[++i];
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === '"') out += '"';
        else if (n === "\\") out += "\\";
        else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(inner[i + 1] ?? "")) oct += inner[++i];
          out += String.fromCharCode(parseInt(oct, 8));
        } else out += n;
      } else out += c;
    }
    return out;
  }
  // Unquoted path: git still appends a trailing tab after `--- `/`+++ ` paths that contain a
  // space (no timestamp follows in our pinned diff config), which would otherwise corrupt
  // every downstream lookup keyed by path.
  return t.replace(/\t+$/, "");
}

/** Strips a leading `a/`/`b/` prefix added by our pinned diff config. */
function stripAbPrefix(token: string): string {
  return token.startsWith("a/") || token.startsWith("b/") ? token.slice(2) : token;
}

/**
 * Best-effort split of the ambiguous `diff --git <old> <new>` header line. When both paths are
 * quoted this is unambiguous; when unquoted, a path containing the literal substring " b/" can
 * still split wrong — callers must treat this as a fallback only, never as grounds to infer a
 * rename (that's decided solely by explicit `rename from/to` lines).
 */
function parseHeaderPaths(header: string): { oldPath: string | null; path: string | null } {
  const quoted = new RegExp(`^diff --git (${QUOTED_TOKEN}) (${QUOTED_TOKEN})$`).exec(header);
  if (quoted) {
    return { oldPath: stripAbPrefix(unquoteGitPath(quoted[1])), path: stripAbPrefix(unquoteGitPath(quoted[2])) };
  }
  const plain = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  if (!plain) return { oldPath: null, path: null };
  return { oldPath: plain[1], path: plain[2] };
}

function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1], 10),
    oldLines: m[2] !== undefined ? parseInt(m[2], 10) : 1,
    newStart: parseInt(m[3], 10),
    newLines: m[4] !== undefined ? parseInt(m[4], 10) : 1,
  };
}

/** Splits a `git diff` of possibly many files into per-file raw blocks starting at `diff --git`. */
function splitFileBlocks(raw: string): string[] {
  const lines = raw.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks.filter((b) => b.startsWith("diff --git "));
}

function parseFileBlock(block: string): ParsedFile {
  const lines = block.split("\n");
  const header = lines[0];
  // Fallback only: a binary file (or any file with no `---`/`+++` lines) has nothing more
  // reliable to go on. Never let this alone decide `status` — only explicit rename/copy
  // lines below do that, since an unquoted path containing " b/" can split this ambiguously.
  const headerPaths = parseHeaderPaths(header);
  let path = headerPaths.path ?? "unknown";
  let oldPath: string | null = headerPaths.oldPath;
  let status: ParsedFile["status"] = "modified";
  let binary = false;
  let similarity = 0;

  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("@@")) break;
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      binary = true;
    } else if (line.startsWith("new file mode")) {
      status = "added";
      oldPath = null;
    } else if (line.startsWith("deleted file mode")) {
      status = "deleted";
    } else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = unquoteGitPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      path = unquoteGitPath(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      status = "copied";
      oldPath = unquoteGitPath(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      path = unquoteGitPath(line.slice("copy to ".length));
    } else if (line.startsWith("similarity index")) {
      similarity = parseInt(line.replace(/[^\d]/g, ""), 10) || 0;
    } else if (line.startsWith("--- ")) {
      const m = new RegExp(`^--- (?:(${QUOTED_TOKEN})|a/(.+)|/dev/null)$`).exec(line);
      if (m?.[1]) oldPath = stripAbPrefix(unquoteGitPath(m[1]));
      else if (m?.[2]) oldPath = unquoteGitPath(m[2]);
    } else if (line.startsWith("+++ ")) {
      const m = new RegExp(`^\\+\\+\\+ (?:(${QUOTED_TOKEN})|b/(.+)|/dev/null)$`).exec(line);
      if (m?.[1]) path = stripAbPrefix(unquoteGitPath(m[1]));
      else if (m?.[2]) path = unquoteGitPath(m[2]);
    }
  }
  // Deliberately no "oldPath !== path => renamed" fallback here: with `-M`/`-C`, git always
  // emits explicit rename/copy from/to lines for a detected rename, which already set
  // `status` above. Inferring a rename from a path mismatch alone just re-triggers the
  // ambiguous-header-split bug for files with no `---`/`+++` lines (e.g. binary files).
  void similarity;

  const hunks: Hunk[] = [];
  let additions = 0;
  let deletions = 0;
  let totalLines = 0;
  let truncated = false;

  while (i < lines.length) {
    const headerLine = lines[i];
    const parsedHeader = parseHunkHeader(headerLine);
    if (!parsedHeader) {
      i++;
      continue;
    }
    i++;
    const hunkLines: MutableLine[] = [];
    let oldNo = parsedHeader.oldStart;
    let newNo = parsedHeader.newStart;
    let hunkAdditions = 0;
    let hunkDeletions = 0;
    let hunkChanged = 0;
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git")) {
      const raw = lines[i];
      if (raw === "" && i === lines.length - 1) {
        i++;
        continue;
      }
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === "+") {
        hunkLines.push({ kind: "add", oldNo: null, newNo, text, moved: false, whitespaceOnly: false });
        newNo++;
        hunkAdditions++;
        hunkChanged++;
      } else if (marker === "-") {
        hunkLines.push({ kind: "del", oldNo, newNo: null, text, moved: false, whitespaceOnly: false });
        oldNo++;
        hunkChanged++;
        hunkDeletions++;
      } else if (marker === " " || raw === "") {
        hunkLines.push({ kind: "context", oldNo, newNo, text, moved: false, whitespaceOnly: false });
        oldNo++;
        newNo++;
      } else if (raw.startsWith("\\ No newline")) {
        // ignore
      }
      i++;
    }
    // A11: the cap is cumulative per file (MAX_LINES_PER_FILE), but a dropped hunk's lines
    // must not still count toward `additions`/`deletions` (and therefore `effectiveLines`) —
    // otherwise file-level stats disagree with `hunks` (and with the ValidationUnits built
    // from it) by exactly the size of the truncated-away hunks.
    if (totalLines + hunkChanged <= MAX_LINES_PER_FILE) {
      totalLines += hunkChanged;
      additions += hunkAdditions;
      deletions += hunkDeletions;
      hunks.push({
        header: headerLine,
        oldStart: parsedHeader.oldStart,
        oldLines: parsedHeader.oldLines,
        newStart: parsedHeader.newStart,
        newLines: parsedHeader.newLines,
        lines: hunkLines,
        pureMove: false,
        whitespaceOnly: false,
      });
    } else {
      truncated = true;
    }
  }

  return {
    path,
    oldPath: oldPath === path ? null : oldPath,
    status,
    binary,
    truncated,
    additions,
    deletions,
    hunks,
    movedLines: 0,
    effectiveLines: additions + deletions,
  };
}

export function parseUnifiedDiff(raw: string): ParsedFile[] {
  if (!raw.trim()) return [];
  return splitFileBlocks(raw).map(parseFileBlock);
}

const PUNCTUATION_ONLY = /^[{}()\[\];,.]*$/;

function qualifies(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 8 && !PUNCTUATION_ONLY.test(trimmed);
}

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Marks contiguous runs of `true` in `matches` of length >= `minLen` as matched in `out` (indices not already set). */
function markRuns(matches: boolean[], minLen: number, out: boolean[]): void {
  let i = 0;
  while (i < matches.length) {
    if (!matches[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < matches.length && matches[j]) j++;
    if (j - i >= minLen) for (let k = i; k < j; k++) out[k] = true;
    i = j + 1;
  }
}

/**
 * Annotates moved and whitespace-only lines across every parsed file of a PR, in place, and
 * recomputes each file's `movedLines`/`effectiveLines`.
 *
 * Moved (A6): a run of >=3 consecutive same-kind (add or del) lines in one hunk whose trimmed
 * text each appears on the opposite side of the SAME file is treated as moved. A shorter match
 * is too easy to hit by coincidence (shared boilerplate, repeated log/assert lines) once we
 * widen the search to the whole PR, so cross-file matches require a longer run (>=6) as extra
 * evidence it's a genuine move and not two unrelated edits that happen to share some lines.
 * Whitespace-only (per hunk): the hunk's removed lines equal its added lines once all
 * whitespace is stripped.
 */
export function annotateMovesAndWhitespace(files: ParsedFile[]): void {
  const removedText = new Set<string>();
  const addedText = new Set<string>();
  const removedByFile = new Map<ParsedFile, Set<string>>();
  const addedByFile = new Map<ParsedFile, Set<string>>();
  for (const file of files) {
    const removedHere = new Set<string>();
    const addedHere = new Set<string>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "del" && qualifies(line.text)) {
          removedText.add(line.text.trim());
          removedHere.add(line.text.trim());
        } else if (line.kind === "add" && qualifies(line.text)) {
          addedText.add(line.text.trim());
          addedHere.add(line.text.trim());
        }
      }
    }
    removedByFile.set(file, removedHere);
    addedByFile.set(file, addedHere);
  }

  for (const file of files) {
    let movedLines = 0;
    const sameFileOpposite = {
      add: removedByFile.get(file) ?? new Set<string>(),
      del: addedByFile.get(file) ?? new Set<string>(),
    };
    const globalOpposite = { add: removedText, del: addedText };
    for (const hunk of file.hunks) {
      // Whitespace-only hunk check.
      const dels = hunk.lines.filter((l) => l.kind === "del").map((l) => stripWhitespace(l.text));
      const adds = hunk.lines.filter((l) => l.kind === "add").map((l) => stripWhitespace(l.text));
      const whitespaceOnly = dels.length > 0 && dels.length === adds.length && dels.every((d, idx) => d === adds[idx]);
      hunk.whitespaceOnly = whitespaceOnly;
      if (whitespaceOnly) {
        for (const line of hunk.lines) if (line.kind !== "context") line.whitespaceOnly = true;
      }

      // Moved-run detection: scan consecutive same-kind runs.
      let runStart = -1;
      let runKind: "add" | "del" | null = null;
      const flushRun = (end: number) => {
        if (runKind === null || runStart < 0) return;
        const runLines = hunk.lines.slice(runStart, end);
        const matchesSameFile = runLines.map((l) => qualifies(l.text) && sameFileOpposite[runKind!].has(l.text.trim()));
        const matchesGlobal = runLines.map((l) => qualifies(l.text) && globalOpposite[runKind!].has(l.text.trim()));
        const matched = new Array<boolean>(runLines.length).fill(false);
        markRuns(matchesSameFile, 3, matched);
        const remainingGlobal = matchesGlobal.map((v, idx) => v && !matched[idx]);
        markRuns(remainingGlobal, 6, matched);
        for (let k = 0; k < runLines.length; k++) {
          if (matched[k]) {
            hunk.lines[runStart + k].moved = true;
            movedLines++;
          }
        }
      };
      for (let idx = 0; idx < hunk.lines.length; idx++) {
        const line = hunk.lines[idx];
        const kind = line.kind === "add" || line.kind === "del" ? line.kind : null;
        if (kind !== runKind) {
          flushRun(idx);
          runKind = kind;
          runStart = kind ? idx : -1;
        }
      }
      flushRun(hunk.lines.length);

      const changed = hunk.lines.filter((l) => l.kind !== "context");
      hunk.pureMove = changed.length > 0 && changed.every((l) => l.moved);
    }
    file.movedLines = movedLines;
    // A5: count each changed line once even when it's flagged both moved AND whitespace-only
    // (e.g. a >=3-line pure-indentation hunk, whose del/add pairs are also trivially "moved"
    // matches of each other once whitespace is trimmed) — summing the two counts independently
    // over-subtracts and can zero out an unrelated, genuinely real hunk in the same file.
    let noiseLines = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "context" && (line.moved || line.whitespaceOnly)) noiseLines++;
      }
    }
    const total = file.additions + file.deletions;
    file.effectiveLines = Math.max(0, total - noiseLines);
  }
}

export function toFileDiff(file: ParsedFile, totalLines: number | null = null): FileDiff {
  return {
    path: file.path,
    oldPath: file.oldPath,
    binary: file.binary,
    truncated: file.truncated,
    hunks: file.hunks,
    totalLines,
  };
}

/** Line count of file content as git shows it (a trailing newline does not start an extra line). */
export function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Parses numstat output (`additions\tdeletions\tpath` or rename `old => new`). */
export function parseNumstat(raw: string): Array<{ path: string; oldPath: string | null; additions: number; deletions: number; binary: boolean }> {
  const out: Array<{ path: string; oldPath: string | null; additions: number; deletions: number; binary: boolean }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === "-" || m[2] === "-";
    const additions = binary ? 0 : parseInt(m[1], 10);
    const deletions = binary ? 0 : parseInt(m[2], 10);
    let pathField = m[3];
    let oldPath: string | null = null;
    let path = pathField;
    const braceMatch = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(pathField);
    const arrowMatch = /^(.*) => (.*)$/.exec(pathField);
    if (braceMatch) {
      oldPath = `${braceMatch[1]}${braceMatch[2]}${braceMatch[4]}`;
      path = `${braceMatch[1]}${braceMatch[3]}${braceMatch[4]}`;
    } else if (arrowMatch && !pathField.includes("{")) {
      oldPath = arrowMatch[1];
      path = arrowMatch[2];
    }
    out.push({ path, oldPath: oldPath === path ? null : oldPath, additions, deletions, binary });
  }
  return out;
}
