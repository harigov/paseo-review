import type { OutlineKind } from "../../../shared/types";
import { indentWidth, isBlankLine, scanDeclarationEnd, type ScanOptions } from "./scan";
import { buildDeclaration, type Declaration } from "./types";

const SCAN_OPTS: ScanOptions = { lineComment: "//", blockComment: ["/*", "*/"], stringChars: ['"'] };

const CONTAINER_RE = /^((?:data\s+|sealed\s+|abstract\s+|open\s+|enum\s+|private\s+|internal\s+|public\s+)*)(class|object|interface)\s+([A-Za-z_]\w*)/;
const FUN_RE = /^((?:private\s+|internal\s+|public\s+|override\s+|open\s+|protected\s+|abstract\s+|suspend\s+)*)fun\s+([A-Za-z_]\w*)/;

function isNotExported(modifiers: string): boolean {
  return /\b(private|internal)\b/.test(modifiers);
}

/** Kotlin: class/object/interface declarations, top-level `fun`s, plus one level of `fun` members. */
export function extractKotlin(content: string): Declaration[] {
  const lines = content.split("\n");
  const decls: Declaration[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line) || indentWidth(line) !== 0) {
      i++;
      continue;
    }
    const trimmed = line.trimStart();

    let m = CONTAINER_RE.exec(trimmed);
    if (m) {
      const name = m[3];
      const kind: OutlineKind = m[2] === "interface" ? "interface" : "class"; // "object" -> class
      const exported = !isNotExported(m[1]);
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(buildDeclaration({ name, kind, exported, headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
      decls.push(...extractMembers(lines, i, scan.endLineIdx, name, exported));
      i = scan.endLineIdx + 1;
      continue;
    }

    m = FUN_RE.exec(trimmed);
    if (m) {
      const name = m[2];
      const exported = !isNotExported(m[1]);
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(buildDeclaration({ name, kind: "function", exported, headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
      i = scan.endLineIdx + 1;
      continue;
    }

    i++;
  }
  return decls;
}

function extractMembers(lines: string[], containerStartIdx: number, containerEndIdx: number, containerName: string, containerExported: boolean): Declaration[] {
  const innerStart = containerStartIdx + 1;
  const innerEnd = containerEndIdx - 1;
  if (innerStart > innerEnd) return [];
  let memberIndent: number | null = null;
  for (let k = innerStart; k <= innerEnd; k++) {
    if (!isBlankLine(lines[k])) {
      memberIndent = indentWidth(lines[k]);
      break;
    }
  }
  if (memberIndent === null) return [];

  const out: Declaration[] = [];
  let i = innerStart;
  while (i <= innerEnd) {
    const line = lines[i];
    if (isBlankLine(line) || indentWidth(line) !== memberIndent) {
      i++;
      continue;
    }
    const trimmed = line.trimStart();
    const m = FUN_RE.exec(trimmed);
    if (!m) {
      i++;
      continue;
    }
    const isPrivate = isNotExported(m[1]);
    const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
    out.push(
      buildDeclaration({
        name: `${containerName}.${m[2]}`,
        kind: "method",
        exported: containerExported && !isPrivate,
        headerLine: line,
        startLineIdx: i,
        endLineIdx: scan.endLineIdx,
        lines,
      }),
    );
    i = scan.endLineIdx + 1;
  }
  return out;
}
