import type { OutlineKind } from "../../../shared/types";
import { indentWidth, isBlankLine, scanDeclarationEnd, type ScanOptions } from "./scan";
import { buildDeclaration, type Declaration } from "./types";

const SCAN_OPTS: ScanOptions = { lineComment: "//", blockComment: ["/*", "*/"], stringChars: ['"', "`", "'"] };

const METHOD_RE = /^func\s*\(\s*[A-Za-z_]\w*\s+\*?([A-Za-z_]\w*)\s*\)\s+([A-Za-z_]\w*)\s*\(/;
const FUNC_RE = /^func\s+([A-Za-z_]\w*)\s*\(/;
const STRUCT_IFACE_RE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/;
const TYPE_ALIAS_RE = /^type\s+([A-Za-z_]\w*)\s+\S/;
const VAR_CONST_RE = /^(var|const)\s+([A-Za-z_]\w*)\s*(?:[=\s]|$)/;

function isExportedName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Go: top-level funcs (plain and methods via receiver), struct/interface/type decls, single var/const. */
export function extractGo(content: string): Declaration[] {
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
    let m = METHOD_RE.exec(trimmed);
    if (m) {
      const recv = m[1];
      const name = m[2];
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(
        buildDeclaration({ name: `${recv}.${name}`, kind: "method", exported: isExportedName(name), headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }),
      );
      i = scan.endLineIdx + 1;
      continue;
    }

    m = FUNC_RE.exec(trimmed);
    if (m) {
      const name = m[1];
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(
        buildDeclaration({ name, kind: "function", exported: isExportedName(name), headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }),
      );
      i = scan.endLineIdx + 1;
      continue;
    }

    m = STRUCT_IFACE_RE.exec(trimmed);
    if (m) {
      const name = m[1];
      const kind: OutlineKind = m[2] === "struct" ? "struct" : "interface";
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(buildDeclaration({ name, kind, exported: isExportedName(name), headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
      i = scan.endLineIdx + 1;
      continue;
    }

    m = TYPE_ALIAS_RE.exec(trimmed);
    if (m) {
      const name = m[1];
      decls.push(buildDeclaration({ name, kind: "type", exported: isExportedName(name), headerLine: line, startLineIdx: i, endLineIdx: i, lines }));
      i++;
      continue;
    }

    m = VAR_CONST_RE.exec(trimmed);
    if (m) {
      const name = m[2];
      const kind: OutlineKind = m[1] === "const" ? "constant" : "variable";
      decls.push(buildDeclaration({ name, kind, exported: isExportedName(name), headerLine: line, startLineIdx: i, endLineIdx: i, lines }));
      i++;
      continue;
    }

    i++;
  }
  return decls;
}
