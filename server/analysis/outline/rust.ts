import type { OutlineKind } from "../../../shared/types";
import { indentWidth, isBlankLine, scanDeclarationEnd, type ScanOptions } from "./scan";
import { buildDeclaration, type Declaration } from "./types";

// Rust strings only track `"`, not `'` — a bare `'` almost always starts a lifetime
// (`&'a str`), not a char literal, and misreading it as an opening quote would desync the
// brace counter for the rest of the file.
const SCAN_OPTS: ScanOptions = { lineComment: "//", blockComment: ["/*", "*/"], stringChars: ['"'] };

const IMPL_RE = /^(pub(?:\([^)]*\))?\s+)?impl(?:<[^>]*>)?\s+([A-Za-z_][\w:]*)(?:<[^>]*>)?\s*(?:for\s+([A-Za-z_][\w:]*))?/;
const FN_RE = /^(pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)/;
const STRUCT_ENUM_TRAIT_RE = /^(pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)/;
const MOD_RE = /^(pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/;
const TYPE_RE = /^(pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/;

/** Rust: top-level fn/struct/enum/trait/type/mod, plus `fn` members inside one `impl` block. */
export function extractRust(content: string): Declaration[] {
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

    let m = IMPL_RE.exec(trimmed);
    if (m) {
      const target = m[2];
      const traitTarget = m[3];
      const name = traitTarget ? `${target} for ${traitTarget}` : target;
      const implName = traitTarget ?? target;
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(buildDeclaration({ name, kind: "impl", exported: !!m[1], headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
      decls.push(...extractImplMembers(lines, i, scan.endLineIdx, implName));
      i = scan.endLineIdx + 1;
      continue;
    }

    m = FN_RE.exec(trimmed);
    if (m) {
      const name = m[2];
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(buildDeclaration({ name, kind: "function", exported: !!m[1], headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
      i = scan.endLineIdx + 1;
      continue;
    }

    m = STRUCT_ENUM_TRAIT_RE.exec(trimmed);
    if (m) {
      const name = m[3];
      const kind = m[2] as OutlineKind; // "struct" | "enum" | "trait" are all valid OutlineKind values
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(buildDeclaration({ name, kind, exported: !!m[1], headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
      i = scan.endLineIdx + 1;
      continue;
    }

    m = MOD_RE.exec(trimmed);
    if (m) {
      const name = m[2];
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(buildDeclaration({ name, kind: "module", exported: !!m[1], headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
      i = scan.endLineIdx + 1;
      continue;
    }

    m = TYPE_RE.exec(trimmed);
    if (m) {
      const name = m[2];
      const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
      decls.push(buildDeclaration({ name, kind: "type", exported: !!m[1], headerLine: line, startLineIdx: i, endLineIdx: scan.endLineIdx, lines }));
      i = scan.endLineIdx + 1;
      continue;
    }

    i++;
  }
  return decls;
}

function extractImplMembers(lines: string[], startIdx: number, endIdx: number, implName: string): Declaration[] {
  const innerStart = startIdx + 1;
  const innerEnd = endIdx - 1;
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
    const m = FN_RE.exec(trimmed);
    if (!m) {
      i++;
      continue;
    }
    const scan = scanDeclarationEnd(lines, i, SCAN_OPTS);
    out.push(
      buildDeclaration({
        name: `${implName}.${m[2]}`,
        kind: "method",
        exported: !!m[1],
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
