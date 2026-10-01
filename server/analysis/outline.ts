import type { OutlineEntry } from "../../shared/types";
import type { ParsedFile } from "./diff";
import { extractDeclarations, type Declaration } from "./outline/index";

// Declaration-level ("outline") diff: which functions, classes, types, etc. were added,
// removed, modified, had their signature changed, were renamed or moved. Deterministic regex
// extraction per language (tree-sitter can replace an extractor later behind the same
// interface — see server/analysis/outline/index.ts). Runs in the analysis pipeline for every
// supported file in the PR.

export type OutlineSide = "base" | "head";

/** Reads a file's full contents at the merge base ("base") or the PR head ("head"); null when absent. */
export type ReadFile = (side: OutlineSide, path: string) => Promise<string | null>;

export const OUTLINE_LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
};

/** Language id for the outline extractor, or null when the file type isn't supported. */
export function outlineLanguageOf(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return OUTLINE_LANGUAGE_BY_EXT[ext] ?? null;
}

/** Files above this many bytes on either side are skipped (outline = null). */
export const OUTLINE_MAX_BYTES = 200 * 1024;

/** Files are read in batches of this size — each `readFile` call spawns a `git show`. */
const READ_BATCH_SIZE = 8;

async function mapInBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const results = await Promise.all(batch.map(fn));
    for (let k = 0; k < results.length; k++) out[start + k] = results[k];
  }
  return out;
}

function byteLengthOf(s: string | null): number {
  return s === null ? 0 : Buffer.byteLength(s, "utf8");
}

interface PreparedFile {
  file: ParsedFile;
  baseDecls: Declaration[];
  headDecls: Declaration[];
}

type PrepareResult = { path: string; skip: true } | ({ path: string; skip: false } & PreparedFile);

/** Reads and extracts both sides of one file; decides the skip rules (binary/unsupported/too large/missing). */
async function prepareFile(file: ParsedFile, readFile: ReadFile): Promise<PrepareResult> {
  if (file.binary) return { path: file.path, skip: true };
  const language = outlineLanguageOf(file.path);
  if (!language) return { path: file.path, skip: true };

  const needsBase = file.status !== "added";
  const needsHead = file.status !== "deleted";
  const basePath = file.oldPath ?? file.path;

  const [baseContent, headContent] = await Promise.all([
    needsBase ? readFile("base", basePath) : Promise.resolve(null),
    needsHead ? readFile("head", file.path) : Promise.resolve(null),
  ]);

  if (needsBase && baseContent === null) return { path: file.path, skip: true };
  if (needsHead && headContent === null) return { path: file.path, skip: true };
  if (byteLengthOf(baseContent) > OUTLINE_MAX_BYTES || byteLengthOf(headContent) > OUTLINE_MAX_BYTES) return { path: file.path, skip: true };

  const baseDecls = baseContent !== null ? extractDeclarations(language, baseContent) : [];
  const headDecls = headContent !== null ? extractDeclarations(language, headContent) : [];
  return { path: file.path, skip: false, file, baseDecls, headDecls };
}

/** Matches old/new declarations within a file by qualified name; a repeated name matches by order. */
function matchWithinFile(oldDecls: Declaration[], newDecls: Declaration[]) {
  const oldByName = new Map<string, Declaration[]>();
  for (const d of oldDecls) {
    const list = oldByName.get(d.name);
    if (list) list.push(d);
    else oldByName.set(d.name, [d]);
  }
  const newByName = new Map<string, Declaration[]>();
  for (const d of newDecls) {
    const list = newByName.get(d.name);
    if (list) list.push(d);
    else newByName.set(d.name, [d]);
  }

  const matchedPairs: { oldD: Declaration; newD: Declaration }[] = [];
  const matchedOld = new Set<Declaration>();
  const matchedNew = new Set<Declaration>();
  for (const [name, newList] of newByName) {
    const oldList = oldByName.get(name);
    if (!oldList) continue;
    const n = Math.min(oldList.length, newList.length);
    for (let k = 0; k < n; k++) {
      matchedPairs.push({ oldD: oldList[k], newD: newList[k] });
      matchedOld.add(oldList[k]);
      matchedNew.add(newList[k]);
    }
  }

  return {
    matchedPairs,
    unmatchedOld: oldDecls.filter((d) => !matchedOld.has(d)),
    unmatchedNew: newDecls.filter((d) => !matchedNew.has(d)),
  };
}

/**
 * Counts add/del lines of the file's hunks that fall inside the entry's range: del lines (which
 * only carry `oldNo`) are tested against `[oldStart, oldEnd]`, add lines (`newNo`) against
 * `[newStart, newEnd]`. An entry missing one side of the range (e.g. an `added` entry has no old
 * range, a `removed` entry has no new range) only counts against the side it has.
 */
function countChangedLines(
  file: ParsedFile,
  oldStart: number | null,
  oldEnd: number | null,
  newStart: number | null,
  newEnd: number | null,
): number {
  let count = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && newStart !== null && newEnd !== null && line.newNo !== null && line.newNo >= newStart && line.newNo <= newEnd)
        count++;
      else if (line.kind === "del" && oldStart !== null && oldEnd !== null && line.oldNo !== null && line.oldNo >= oldStart && line.oldNo <= oldEnd)
        count++;
    }
  }
  return count;
}

function makeSignatureOrModifiedEntry(file: ParsedFile, oldD: Declaration, newD: Declaration): OutlineEntry | null {
  if (oldD.signature !== newD.signature) {
    return {
      name: newD.name,
      kind: newD.kind,
      change: "signature",
      exported: newD.exported,
      signature: newD.signature,
      oldSignature: oldD.signature,
      newStart: newD.startLine,
      newEnd: newD.endLine,
      oldStart: oldD.startLine,
      oldEnd: oldD.endLine,
      changedLines: countChangedLines(file, oldD.startLine, oldD.endLine, newD.startLine, newD.endLine),
      counterpart: null,
    };
  }
  if (oldD.bodyHash !== newD.bodyHash) {
    return {
      name: newD.name,
      kind: newD.kind,
      change: "modified",
      exported: newD.exported,
      signature: newD.signature,
      oldSignature: null,
      newStart: newD.startLine,
      newEnd: newD.endLine,
      oldStart: oldD.startLine,
      oldEnd: oldD.endLine,
      changedLines: countChangedLines(file, oldD.startLine, oldD.endLine, newD.startLine, newD.endLine),
      counterpart: null,
    };
  }
  return null; // unchanged
}

function makeAddedEntry(file: ParsedFile, d: Declaration): OutlineEntry {
  return {
    name: d.name,
    kind: d.kind,
    change: "added",
    exported: d.exported,
    signature: d.signature,
    oldSignature: null,
    newStart: d.startLine,
    newEnd: d.endLine,
    oldStart: null,
    oldEnd: null,
    changedLines: countChangedLines(file, null, null, d.startLine, d.endLine),
    counterpart: null,
  };
}

function makeRemovedEntry(file: ParsedFile, d: Declaration): OutlineEntry {
  return {
    name: d.name,
    kind: d.kind,
    change: "removed",
    exported: d.exported,
    signature: d.signature,
    oldSignature: null,
    newStart: null,
    newEnd: null,
    oldStart: d.startLine,
    oldEnd: d.endLine,
    changedLines: countChangedLines(file, d.startLine, d.endLine, null, null),
    counterpart: null,
  };
}

function makeRenamedEntry(file: ParsedFile, newD: Declaration, oldD: Declaration): OutlineEntry {
  return {
    name: newD.name,
    kind: newD.kind,
    change: "renamed",
    exported: newD.exported,
    signature: newD.signature,
    oldSignature: null,
    newStart: newD.startLine,
    newEnd: newD.endLine,
    oldStart: oldD.startLine,
    oldEnd: oldD.endLine,
    changedLines: countChangedLines(file, oldD.startLine, oldD.endLine, newD.startLine, newD.endLine),
    counterpart: { path: file.path, name: oldD.name },
  };
}

function makeMovedNewEntry(newFile: ParsedFile, newD: Declaration, oldFile: ParsedFile, oldD: Declaration): OutlineEntry {
  return {
    name: newD.name,
    kind: newD.kind,
    change: "moved",
    exported: newD.exported,
    signature: newD.signature,
    oldSignature: null,
    newStart: newD.startLine,
    newEnd: newD.endLine,
    oldStart: null,
    oldEnd: null,
    changedLines: countChangedLines(newFile, null, null, newD.startLine, newD.endLine),
    counterpart: { path: oldFile.path, name: oldD.name },
  };
}

function makeMovedOldEntry(oldFile: ParsedFile, oldD: Declaration, newFile: ParsedFile, newD: Declaration): OutlineEntry {
  return {
    name: oldD.name,
    kind: oldD.kind,
    change: "moved",
    exported: oldD.exported,
    signature: oldD.signature,
    oldSignature: null,
    newStart: null,
    newEnd: null,
    oldStart: oldD.startLine,
    oldEnd: oldD.endLine,
    changedLines: countChangedLines(oldFile, oldD.startLine, oldD.endLine, null, null),
    counterpart: { path: newFile.path, name: newD.name },
  };
}

function outlineSortKey(e: OutlineEntry): [number, number] {
  const primary = e.newStart ?? e.oldStart ?? Number.MAX_SAFE_INTEGER;
  const secondary = e.oldStart ?? Number.MAX_SAFE_INTEGER;
  return [primary, secondary];
}

/**
 * Declaration-level diff for every supported file in the PR. Returns path → entries; null for
 * files that were skipped (binary, unsupported language, too large, or missing content on a
 * side that should exist). Renames and moves are resolved across the whole set of files, so a
 * function that moved between files is reported as "moved" in both files rather than as a
 * removal plus an addition.
 */
export async function computeOutlines(files: ParsedFile[], readFile: ReadFile): Promise<Map<string, OutlineEntry[] | null>> {
  const result = new Map<string, OutlineEntry[] | null>();

  const prepared = await mapInBatches(files, READ_BATCH_SIZE, (file) => prepareFile(file, readFile));

  interface FileWork {
    file: ParsedFile;
    entries: OutlineEntry[];
    unmatchedOld: Declaration[];
    unmatchedNew: Declaration[];
  }
  const work: FileWork[] = [];
  for (const p of prepared) {
    if (p.skip) {
      result.set(p.path, null);
      continue;
    }
    const { matchedPairs, unmatchedOld, unmatchedNew } = matchWithinFile(p.baseDecls, p.headDecls);
    const entries: OutlineEntry[] = [];
    for (const { oldD, newD } of matchedPairs) {
      const entry = makeSignatureOrModifiedEntry(p.file, oldD, newD);
      if (entry) entries.push(entry);
    }
    work.push({ file: p.file, entries, unmatchedOld, unmatchedNew });
  }

  // Cross-file rename/move resolution. `oldPool` holds every unmatched old declaration in the
  // PR; a new declaration first looks for an unconsumed candidate in its own file (rename),
  // then anywhere else in the PR (moved), and only becomes "added" when neither is found.
  // `oldByKey` indexes the (substantial-bodied) entries of `oldPool` by `kind:bodyHash` so each
  // new declaration does a bucket lookup instead of a full scan of every unmatched old
  // declaration in the PR — same first-match-wins semantics (bucket order mirrors `oldPool`
  // insertion order: file-by-file, then declaration order within a file), just O(1) per lookup
  // instead of O(n).
  type OldCandidate = { fw: FileWork; decl: Declaration; consumed: boolean };
  const oldPool: OldCandidate[] = [];
  const oldByKey = new Map<string, OldCandidate[]>();
  for (const fw of work) {
    for (const decl of fw.unmatchedOld) {
      const candidate: OldCandidate = { fw, decl, consumed: false };
      oldPool.push(candidate);
      if (decl.bodySubstantial) {
        const key = `${decl.kind}:${decl.bodyHash}`;
        const bucket = oldByKey.get(key);
        if (bucket) bucket.push(candidate);
        else oldByKey.set(key, [candidate]);
      }
    }
  }

  for (const fw of work) {
    for (const newD of fw.unmatchedNew) {
      if (!newD.bodySubstantial) {
        fw.entries.push(makeAddedEntry(fw.file, newD));
        continue;
      }
      const bucket = oldByKey.get(`${newD.kind}:${newD.bodyHash}`);
      const sameFileMatch = bucket?.find((o) => !o.consumed && o.fw === fw);
      if (sameFileMatch) {
        sameFileMatch.consumed = true;
        fw.entries.push(makeRenamedEntry(fw.file, newD, sameFileMatch.decl));
        continue;
      }
      const crossFileMatch = bucket?.find((o) => !o.consumed && o.fw !== fw);
      if (crossFileMatch) {
        crossFileMatch.consumed = true;
        fw.entries.push(makeMovedNewEntry(fw.file, newD, crossFileMatch.fw.file, crossFileMatch.decl));
        crossFileMatch.fw.entries.push(makeMovedOldEntry(crossFileMatch.fw.file, crossFileMatch.decl, fw.file, newD));
        continue;
      }
      fw.entries.push(makeAddedEntry(fw.file, newD));
    }
  }

  for (const o of oldPool) if (!o.consumed) o.fw.entries.push(makeRemovedEntry(o.fw.file, o.decl));

  for (const fw of work) {
    fw.entries.sort((a, b) => {
      const ka = outlineSortKey(a);
      const kb = outlineSortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1];
    });
    result.set(fw.file.path, fw.entries);
  }

  return result;
}
