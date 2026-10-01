import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { StructuralDiff, StructuralEntry, StructuralKind } from "../../../shared/types";
import { STRUCTURAL_ENTRY_CAP, shortReason } from "./util";

// JSON / YAML structural diff. Both are parsed with the `yaml` package so every node carries a
// 1-based line number; a .json file whose content the YAML parser can't handle falls back to
// `JSON.parse` with lines left null. See docs/plan-round2.md section B for the full spec.

type MapEntry = { key: string; value: TNode; line: number | null };

type TNode =
  | { kind: "scalar"; value: unknown; line: number | null }
  | { kind: "map"; entries: MapEntry[]; line: number | null }
  | { kind: "seq"; items: TNode[]; line: number | null };

/** A node plus the line of *this occurrence* of it (the key for a map pair, the node itself for a seq item). */
type Child = { node: TNode; line: number | null };

type Budget = { truncated: boolean };

// ---------- Parsing ----------

function nodeLine(node: unknown, lineCounter: LineCounter): number | null {
  const range = (node as { range?: [number, number, number] | null } | null | undefined)?.range;
  if (!range) return null;
  return lineCounter.linePos(range[0]).line;
}

function keyToString(key: unknown): string {
  if (isScalar(key)) return String((key as { value: unknown }).value);
  if (key === null || key === undefined) return "";
  return String(key);
}

function fromYamlNode(node: unknown, lineCounter: LineCounter): TNode {
  if (node === null || node === undefined) return { kind: "scalar", value: null, line: null };
  if (isMap(node)) {
    const entries: MapEntry[] = node.items.map((pair) => ({
      key: keyToString(pair.key),
      value: fromYamlNode(pair.value, lineCounter),
      line: nodeLine(pair.key, lineCounter),
    }));
    return { kind: "map", entries, line: nodeLine(node, lineCounter) };
  }
  if (isSeq(node)) {
    const items = node.items.map((item) => fromYamlNode(item, lineCounter));
    return { kind: "seq", items, line: nodeLine(node, lineCounter) };
  }
  if (isScalar(node)) {
    return { kind: "scalar", value: (node as { value: unknown }).value, line: nodeLine(node, lineCounter) };
  }
  // Alias or another node kind we don't special-case: best-effort scalar.
  return { kind: "scalar", value: null, line: null };
}

function fromJson(value: unknown): TNode {
  if (value === null || typeof value !== "object") return { kind: "scalar", value, line: null };
  if (Array.isArray(value)) return { kind: "seq", items: value.map(fromJson), line: null };
  const entries: MapEntry[] = Object.keys(value as Record<string, unknown>).map((key) => ({
    key,
    value: fromJson((value as Record<string, unknown>)[key]),
    line: null,
  }));
  return { kind: "map", entries, line: null };
}

function parseSide(text: string, kind: StructuralKind): TNode {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  // Diffing only the first document of a multi-document YAML stream is acceptable for v1; the
  // `MULTIPLE_DOCS` note isn't a real parse failure, so don't let it trigger the fallback/error path.
  const realErrors = doc.errors.filter((e) => e.code !== "MULTIPLE_DOCS");
  if (realErrors.length > 0) {
    if (kind === "json") return fromJson(JSON.parse(text));
    throw new Error(realErrors[0]!.message || "YAML parse error");
  }
  return fromYamlNode(doc.contents, lineCounter);
}

// ---------- Rendering ----------

function renderScalar(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function renderValue(node: TNode): string {
  if (node.kind === "map") return `{${node.entries.length} keys}`;
  if (node.kind === "seq") return `[${node.items.length} items]`;
  return renderScalar(node.value);
}

function scalarEqual(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

// ---------- Path formatting ----------

const KEY_NEEDS_QUOTE = /[.[\s]/;

function formatMapKey(prefix: string, key: string): string {
  const quote = key.length === 0 || KEY_NEEDS_QUOTE.test(key);
  const segment = quote ? `[${JSON.stringify(key)}]` : key;
  if (!prefix) return segment;
  return quote ? `${prefix}${segment}` : `${prefix}.${segment}`;
}

function formatSeqIndex(prefix: string, index: number): string {
  return `${prefix}[${index}]`;
}

// ---------- Key-order merge ----------

/**
 * New-side document order, with keys only present on the old side inserted right after the
 * nearest preceding key that survives into the new side (or at the very start, if none do).
 */
function mergeOrder(oldKeys: string[], newKeys: string[]): string[] {
  const newSet = new Set(newKeys);
  const removedAfter = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const key of oldKeys) {
    if (newSet.has(key)) {
      anchor = key;
    } else {
      const list = removedAfter.get(anchor);
      if (list) list.push(key);
      else removedAfter.set(anchor, [key]);
    }
  }
  const merged: string[] = [];
  const emitRemovedAfter = (a: string | null) => {
    const list = removedAfter.get(a);
    if (list) merged.push(...list);
  };
  emitRemovedAfter(null);
  for (const key of newKeys) {
    merged.push(key);
    emitRemovedAfter(key);
  }
  return merged;
}

// ---------- Diffing ----------

function pushEntry(out: StructuralEntry[], budget: Budget, entry: StructuralEntry): boolean {
  if (out.length >= STRUCTURAL_ENTRY_CAP) {
    budget.truncated = true;
    return false;
  }
  out.push(entry);
  return true;
}

function diffPair(oldChild: Child | undefined, newChild: Child | undefined, path: string, out: StructuralEntry[], budget: Budget): void {
  if (budget.truncated) return;
  if (!oldChild && !newChild) return;
  if (!oldChild) {
    pushEntry(out, budget, { path, change: "added", oldValue: null, newValue: renderValue(newChild!.node), oldLine: null, newLine: newChild!.line });
    return;
  }
  if (!newChild) {
    pushEntry(out, budget, { path, change: "removed", oldValue: renderValue(oldChild.node), newValue: null, oldLine: oldChild.line, newLine: null });
    return;
  }
  const a = oldChild.node;
  const b = newChild.node;
  if (a.kind !== "scalar" && b.kind !== "scalar" && a.kind === b.kind) {
    if (a.kind === "map") diffMap(a, b as typeof a, path, out, budget);
    else diffSeq(a as Extract<TNode, { kind: "seq" }>, b as Extract<TNode, { kind: "seq" }>, path, out, budget);
    return;
  }
  if (a.kind === "scalar" && b.kind === "scalar") {
    if (scalarEqual(a.value, b.value)) return;
    pushEntry(out, budget, { path, change: "changed", oldValue: renderValue(a), newValue: renderValue(b), oldLine: oldChild.line, newLine: newChild.line });
    return;
  }
  // One side is a container and the other a scalar, or the container kinds differ (map vs seq):
  // report as changed with container summaries, no recursion.
  pushEntry(out, budget, { path, change: "changed", oldValue: renderValue(a), newValue: renderValue(b), oldLine: oldChild.line, newLine: newChild.line });
}

function diffMap(oldNode: Extract<TNode, { kind: "map" }>, newNode: Extract<TNode, { kind: "map" }>, prefix: string, out: StructuralEntry[], budget: Budget): void {
  const oldByKey = new Map(oldNode.entries.map((e) => [e.key, e] as const));
  const newByKey = new Map(newNode.entries.map((e) => [e.key, e] as const));
  const order = mergeOrder(
    oldNode.entries.map((e) => e.key),
    newNode.entries.map((e) => e.key),
  );
  for (const key of order) {
    if (budget.truncated) return;
    const oldEntry = oldByKey.get(key);
    const newEntry = newByKey.get(key);
    diffPair(
      oldEntry ? { node: oldEntry.value, line: oldEntry.line } : undefined,
      newEntry ? { node: newEntry.value, line: newEntry.line } : undefined,
      formatMapKey(prefix, key),
      out,
      budget,
    );
  }
}

function diffSeq(oldNode: Extract<TNode, { kind: "seq" }>, newNode: Extract<TNode, { kind: "seq" }>, prefix: string, out: StructuralEntry[], budget: Budget): void {
  const max = Math.max(oldNode.items.length, newNode.items.length);
  for (let i = 0; i < max; i++) {
    if (budget.truncated) return;
    const oldItem = oldNode.items[i];
    const newItem = newNode.items[i];
    diffPair(
      oldItem ? { node: oldItem, line: oldItem.line } : undefined,
      newItem ? { node: newItem, line: newItem.line } : undefined,
      formatSeqIndex(prefix, i),
      out,
      budget,
    );
  }
}

function topLevelChildren(node: TNode): Array<{ path: string; child: Child }> {
  if (node.kind === "map") {
    return node.entries.map((e) => ({ path: formatMapKey("", e.key), child: { node: e.value, line: e.line } }));
  }
  if (node.kind === "seq") {
    return node.items.map((item, i) => ({ path: formatSeqIndex("", i), child: { node: item, line: item.line } }));
  }
  return [{ path: "", child: { node, line: node.line } }];
}

export function diffJsonYaml(path: string, kind: StructuralKind, oldText: string | null, newText: string | null): StructuralDiff {
  const base = { path, kind, format: null as string | null };
  try {
    const oldRoot = oldText === null ? null : parseSide(oldText, kind);
    const newRoot = newText === null ? null : parseSide(newText, kind);
    const out: StructuralEntry[] = [];
    const budget: Budget = { truncated: false };

    if (oldRoot === null && newRoot === null) {
      return { ...base, entries: [], truncated: false, error: null };
    }
    if (oldRoot === null) {
      for (const { path: childPath, child } of topLevelChildren(newRoot!)) {
        if (!pushEntry(out, budget, { path: childPath, change: "added", oldValue: null, newValue: renderValue(child.node), oldLine: null, newLine: child.line })) break;
      }
    } else if (newRoot === null) {
      for (const { path: childPath, child } of topLevelChildren(oldRoot)) {
        if (!pushEntry(out, budget, { path: childPath, change: "removed", oldValue: renderValue(child.node), newValue: null, oldLine: child.line, newLine: null })) break;
      }
    } else {
      diffPair({ node: oldRoot, line: oldRoot.line }, { node: newRoot, line: newRoot.line }, "", out, budget);
    }
    return { ...base, entries: out, truncated: budget.truncated, error: null };
  } catch (err) {
    return { ...base, entries: [], truncated: false, error: shortReason(err) };
  }
}
