import type { OutlineKind } from "../../../shared/types";
import { indentWidth, isBlankLine, scanDeclarationEnd, type ScanOptions } from "./scan";
import { buildDeclaration, type Declaration } from "./types";

const SCAN_OPTS: ScanOptions = { lineComment: "//", blockComment: ["/*", "*/"], stringChars: ['"', "'", "`"] };

const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else", "do", "try"]);

const CLASS_RE = /^(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const INTERFACE_RE = /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const TYPE_RE = /^(export\s+)?type\s+([A-Za-z_$][\w$]*)(?:<[^=]*>)?\s*=/;
const ENUM_RE = /^(export\s+)?(const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const FUNCTION_RE = /^(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/;
const VAR_FN_RE = /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\(.*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/;

const METHOD_RE =
  /^((?:static\s+|public\s+|private\s+|protected\s+|readonly\s+|async\s+|get\s+|set\s+|override\s+)*)(\*\s*)?(#?[A-Za-z_$][\w$]*)\s*\(/;
const PROP_ARROW_RE =
  /^((?:static\s+|public\s+|private\s+|protected\s+|readonly\s+)*)(#?[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?\(.*\)\s*(?::[^=]*)?=>/;

interface TopMatch {
  kind: OutlineKind;
  name: string;
  exported: boolean;
  isClass: boolean;
}

/** TypeScript/JavaScript: top-level declarations, plus one level of class members. */
export function extractTypeScript(content: string): Declaration[] {
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
    const top = matchTopLevel(trimmed);
    if (!top) {
      i++;
      continue;
    }
    const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
    decls.push(
      buildDeclaration({ name: top.name, kind: top.kind, exported: top.exported, headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }),
    );
    if (top.isClass) decls.push(...extractMembers(lines, i, scan.endLineIdx, top.name, top.exported));
    i = scan.endLineIdx + 1;
  }
  return decls;
}

function matchTopLevel(trimmed: string): TopMatch | null {
  let m = CLASS_RE.exec(trimmed);
  if (m) return { kind: "class", name: m[4], exported: !!m[1] || !!m[2], isClass: true };

  m = INTERFACE_RE.exec(trimmed);
  if (m) return { kind: "interface", name: m[2], exported: !!m[1], isClass: false };

  m = TYPE_RE.exec(trimmed);
  if (m) return { kind: "type", name: m[2], exported: !!m[1], isClass: false };

  m = ENUM_RE.exec(trimmed);
  if (m) return { kind: "enum", name: m[3], exported: !!m[1], isClass: false };

  m = FUNCTION_RE.exec(trimmed);
  if (m) {
    const name = m[4] ?? (m[2] ? "default" : null);
    if (name) return { kind: "function", name, exported: !!m[1] || !!m[2], isClass: false };
  }

  const varM = VAR_FN_RE.exec(trimmed);
  if (varM) return { kind: "function", name: varM[2], exported: !!varM[1], isClass: false };

  return null;
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
    let name: string | null = null;
    let isPrivate = false;

    let m = METHOD_RE.exec(trimmed);
    if (m) {
      name = m[3];
      if (CONTROL_KEYWORDS.has(name)) {
        i++;
        continue;
      }
      isPrivate = m[1].includes("private") || name.startsWith("#");
    } else {
      m = PROP_ARROW_RE.exec(trimmed);
      if (m) {
        name = m[2];
        isPrivate = m[1].includes("private") || name.startsWith("#");
      }
    }

    if (!name) {
      i++;
      continue;
    }
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
