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
  const headerMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  let path = headerMatch ? headerMatch[2] : "unknown";
  let oldPath: string | null = headerMatch ? headerMatch[1] : null;
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
      oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      path = line.slice("rename to ".length);
    } else if (line.startsWith("copy from ")) {
      status = "copied";
      oldPath = line.slice("copy from ".length);
    } else if (line.startsWith("copy to ")) {
      path = line.slice("copy to ".length);
    } else if (line.startsWith("similarity index")) {
      similarity = parseInt(line.replace(/[^\d]/g, ""), 10) || 0;
    } else if (line.startsWith("--- ")) {
      const m = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line);
      if (m?.[1]) oldPath = m[1];
    } else if (line.startsWith("+++ ")) {
      const m = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line);
      if (m?.[1]) path = m[1];
    }
  }
  if (status === "modified" && oldPath && oldPath !== path) status = "renamed";
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
        additions++;
        totalLines++;
      } else if (marker === "-") {
        hunkLines.push({ kind: "del", oldNo, newNo: null, text, moved: false, whitespaceOnly: false });
        oldNo++;
        totalLines++;
        deletions++;
      } else if (marker === " " || raw === "") {
        hunkLines.push({ kind: "context", oldNo, newNo, text, moved: false, whitespaceOnly: false });
        oldNo++;
        newNo++;
      } else if (raw.startsWith("\\ No newline")) {
        // ignore
      }
      i++;
    }
    if (totalLines <= MAX_LINES_PER_FILE) {
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

/**
 * Annotates moved and whitespace-only lines across every parsed file of a PR, in place, and
 * recomputes each file's `movedLines`/`effectiveLines`.
 *
 * Moved: a run of >=3 consecutive same-kind (add or del) lines in one hunk whose trimmed text
 * each appears on the opposite side anywhere in the PR.
 * Whitespace-only (per hunk): the hunk's removed lines equal its added lines once all
 * whitespace is stripped.
 */
export function annotateMovesAndWhitespace(files: ParsedFile[]): void {
  const removedText = new Set<string>();
  const addedText = new Set<string>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "del" && qualifies(line.text)) removedText.add(line.text.trim());
        else if (line.kind === "add" && qualifies(line.text)) addedText.add(line.text.trim());
      }
    }
  }

  for (const file of files) {
    let movedLines = 0;
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
        const opposite = runKind === "add" ? removedText : addedText;
        const matches = hunk.lines.slice(runStart, end).map((l) => qualifies(l.text) && opposite.has(l.text.trim()));
        let i = 0;
        while (i < matches.length) {
          if (!matches[i]) {
            i++;
            continue;
          }
          let j = i;
          while (j < matches.length && matches[j]) j++;
          if (j - i >= 3) {
            for (let k = i; k < j; k++) {
              hunk.lines[runStart + k].moved = true;
              movedLines++;
            }
          }
          i = j + 1;
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
    const whitespaceLines = file.hunks.reduce(
      (sum, hunk) => sum + hunk.lines.filter((l) => l.kind !== "context" && l.whitespaceOnly).length,
      0,
    );
    const total = file.additions + file.deletions;
    file.effectiveLines = Math.max(0, total - movedLines - whitespaceLines);
  }
}

export function toFileDiff(file: ParsedFile): FileDiff {
  return {
    path: file.path,
    oldPath: file.oldPath,
    binary: file.binary,
    truncated: file.truncated,
    hunks: file.hunks,
  };
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
