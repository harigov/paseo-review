import type { OutlineKind } from "../../../shared/types";
import { buildDeclaration, type Declaration } from "./types";
import { indentWidth, isBlankLine } from "./scan";

const DEF_RE = /^(?:async\s+def|def)\s+([A-Za-z_]\w*)\s*\(/;
const CLASS_RE = /^class\s+([A-Za-z_]\w*)/;

interface Header {
  localName: string;
  kind: OutlineKind;
  indent: number;
  lineIdx: number;
}

/**
 * Python: `def`/`async def`/`class`, nested by indentation (methods under a class become
 * "Class.method"). A declaration ends at the line before the next declaration at the same or
 * lower indentation (anywhere in the file), trimmed of trailing blank lines — there's no brace
 * to balance, so this is the whole end-of-range rule.
 */
export function extractPython(content: string): Declaration[] {
  const lines = content.split("\n");
  const headers: Header[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankLine(line)) continue;
    const trimmed = line.trimStart();
    const indent = indentWidth(line);
    const defM = DEF_RE.exec(trimmed);
    if (defM) {
      headers.push({ localName: defM[1], kind: "function", indent, lineIdx: i });
      continue;
    }
    const classM = CLASS_RE.exec(trimmed);
    if (classM) headers.push({ localName: classM[1], kind: "class", indent, lineIdx: i });
  }

  const decls: Declaration[] = [];
  const stack: { indent: number; qualified: string; isClass: boolean }[] = [];
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h];
    while (stack.length && stack[stack.length - 1].indent >= header.indent) stack.pop();
    const container = stack[stack.length - 1];
    const qualified = container ? `${container.qualified}.${header.localName}` : header.localName;
    const kind: OutlineKind = header.kind === "function" && container?.isClass ? "method" : header.kind;
    const exported = !header.localName.startsWith("_");

    let endLineIdx = lines.length - 1;
    for (let h2 = h + 1; h2 < headers.length; h2++) {
      if (headers[h2].indent <= header.indent) {
        endLineIdx = headers[h2].lineIdx - 1;
        break;
      }
    }
    while (endLineIdx > header.lineIdx && isBlankLine(lines[endLineIdx])) endLineIdx--;

    decls.push(buildDeclaration({ name: qualified, kind, exported, headerLine: lines[header.lineIdx], startLineIdx: header.lineIdx, endLineIdx, lines }));
    stack.push({ indent: header.indent, qualified, isClass: header.kind === "class" });
  }
  return decls;
}
