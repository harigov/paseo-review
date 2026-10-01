import type { OutlineKind } from "../../../shared/types";
import { indentWidth, isBlankLine, scanDeclarationEnd, type ScanOptions } from "./scan";
import { buildDeclaration, type Declaration } from "./types";

const SCAN_OPTS: ScanOptions = { lineComment: "//", blockComment: ["/*", "*/"], stringChars: ['"', "'"] };

const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else", "do", "try"]);

const CONTAINER_RE = /^((?:public\s+|private\s+|protected\s+|final\s+|abstract\s+|static\s+)*)(class|interface|enum|record)\s+([A-Za-z_]\w*)/;
// "(modifiers)* ReturnType name(" — requires two separate tokens before the parens so a bare
// control-flow keyword like `if (x) {` (one token) never matches.
const MEMBER_RE = /^((?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+|default\s+)*)([\w<>[\],.?]+)\s+([A-Za-z_]\w*)\s*\(/;

/** Java: class/interface/enum/record declarations, plus one level of method members. */
export function extractJava(content: string): Declaration[] {
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
    const m = CONTAINER_RE.exec(trimmed);
    if (!m) {
      i++;
      continue;
    }
    const name = m[3];
    const kind: OutlineKind = m[2] === "interface" ? "interface" : m[2] === "enum" ? "enum" : "class"; // "record" -> class
    const exported = !m[1].includes("private");
    const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
    decls.push(buildDeclaration({ name, kind, exported, headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
    decls.push(...extractMembers(lines, i, scan.endLineIdx, name, exported));
    i = scan.endLineIdx + 1;
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
    const m = MEMBER_RE.exec(trimmed);
    if (!m) {
      i++;
      continue;
    }
    const returnType = m[2];
    const name = m[3];
    if (CONTROL_KEYWORDS.has(returnType) || CONTROL_KEYWORDS.has(name)) {
      i++;
      continue;
    }
    const isPrivate = m[1].includes("private");
    const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
    out.push(
      buildDeclaration({
        name: `${containerName}.${name}`,
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
