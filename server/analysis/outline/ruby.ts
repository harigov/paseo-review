import type { OutlineKind } from "../../../shared/types";
import { buildDeclaration, type Declaration } from "./types";
import { indentWidth, isBlankLine } from "./scan";

const DEF_RE = /^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/;
const CLASS_RE = /^class\s+([A-Za-z_:]\w*)/;
const MODULE_RE = /^module\s+([A-Za-z_:]\w*)/;

interface Header {
  localName: string;
  kind: OutlineKind;
  indent: number;
  lineIdx: number;
}

/**
 * Ruby: `def`/`def self.`/`class`/`module`, nested by indentation (same end-of-range rule as
 * Python: ends at the line before the next declaration at the same or lower indentation,
 * trailing blank lines excluded). Ruby has no reliable regex-detectable access modifier, so
 * every declaration is reported as exported.
 */
export function extractRuby(content: string): Declaration[] {
  const lines = content.split("\n");
  const headers: Header[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankLine(line)) continue;
    const trimmed = line.trimStart();
    const indent = indentWidth(line);
    const defM = DEF_RE.exec(trimmed);
    if (defM) {
      headers.push({ localName: defM[1], kind: "method", indent, lineIdx: i });
      continue;
    }
    const classM = CLASS_RE.exec(trimmed);
    if (classM) {
      headers.push({ localName: classM[1], kind: "class", indent, lineIdx: i });
      continue;
    }
    const moduleM = MODULE_RE.exec(trimmed);
    if (moduleM) headers.push({ localName: moduleM[1], kind: "module", indent, lineIdx: i });
  }

  const decls: Declaration[] = [];
  const stack: { indent: number; qualified: string }[] = [];
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h];
    while (stack.length && stack[stack.length - 1].indent >= header.indent) stack.pop();
    const container = stack[stack.length - 1];
    const qualified = container ? `${container.qualified}.${header.localName}` : header.localName;

    let endLineIdx = lines.length - 1;
    for (let h2 = h + 1; h2 < headers.length; h2++) {
      if (headers[h2].indent <= header.indent) {
        endLineIdx = headers[h2].lineIdx - 1;
        break;
      }
    }
    while (endLineIdx > header.lineIdx && isBlankLine(lines[endLineIdx])) endLineIdx--;

    decls.push(buildDeclaration({ name: qualified, kind: header.kind, exported: true, headerLine: lines[header.lineIdx], startLineIdx: header.lineIdx, endLineIdx, lines }));
    stack.push({ indent: header.indent, qualified });
  }
  return decls;
}
