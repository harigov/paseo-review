import { fileSize, logNameStatusReverse, showFile } from "./git";

export interface OrderableFile {
  path: string;
  moduleId: string;
  risk: number | null;
  complexity: number | null;
  effectiveLines: number;
  binary: boolean;
}

const MAX_IMPORT_FILE_BYTES = 200 * 1024;
const IMPORT_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs|rb)$/;
const IMPORT_CONCURRENCY = 8;

const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+(?:[\s\S]*?)\sfrom\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bfrom\s+([\w.]+)\s+import\b/g,
  /^\s*import\s+([\w.]+)/gm,
  /\buse\s+crate::([\w:]+)/g,
];

function extractSpecifiers(content: string): string[] {
  const specs: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      if (m[1]) specs.push(m[1]);
    }
  }
  return specs;
}

function resolveSpecifier(fromPath: string, spec: string, allPaths: Set<string>): string | null {
  if (spec.startsWith(".")) {
    const dir = fromPath.split("/").slice(0, -1);
    const parts = spec.split("/");
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") dir.pop();
      else dir.push(part);
    }
    const base = dir.join("/");
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
    ];
    for (const c of candidates) if (allPaths.has(c)) return c;
    return null;
  }
  // Go/Java/Rust/Python module-ish specifiers: match by path suffix.
  const dotted = spec.replace(/::/g, "/").replace(/\./g, "/");
  for (const p of allPaths) {
    if (p.endsWith(`${dotted}.go`) || p.endsWith(`${dotted}.py`) || p.endsWith(`${dotted}.java`) || p.endsWith(`${dotted}.kt`) || p.endsWith(`${dotted}.rs`)) {
      return p;
    }
  }
  return null;
}

/** Builds a best-effort import graph (edges: importer -> imported) for PR files, bounded. */
export async function buildImportGraph(mirror: string, headSha: string, paths: string[]): Promise<Map<string, Set<string>>> {
  const graph = new Map<string, Set<string>>();
  const allPaths = new Set(paths);
  const candidates = paths.filter((p) => IMPORT_EXTENSIONS.test(p));
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const p = candidates[cursor++];
      try {
        const size = await fileSize(mirror, headSha, p);
        if (size === null || size > MAX_IMPORT_FILE_BYTES) continue;
        const content = await showFile(mirror, headSha, p);
        if (!content) continue;
        const deps = new Set<string>();
        for (const spec of extractSpecifiers(content)) {
          const resolved = resolveSpecifier(p, spec, allPaths);
          if (resolved && resolved !== p) deps.add(resolved);
        }
        graph.set(p, deps);
      } catch {
        // ignore unreadable files
      }
    }
  }
  await Promise.all(Array.from({ length: IMPORT_CONCURRENCY }, () => worker()));
  return graph;
}

/** Topo-sorts files within a module: definitions (depended-on files) before their users. */
function topoSortModule(paths: string[], graph: Map<string, Set<string>>): string[] {
  const set = new Set(paths);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: string[] = [];
  function visit(p: string) {
    if (visited.has(p) || visiting.has(p)) return;
    visiting.add(p);
    const deps = graph.get(p);
    if (deps) {
      for (const d of deps) {
        if (set.has(d)) visit(d);
      }
    }
    visiting.delete(p);
    visited.add(p);
    out.push(p);
  }
  for (const p of [...paths].sort()) visit(p);
  return out;
}

export function computeFoundationsOrder(files: OrderableFile[], taxonomy: Array<{ id: string; rank: number }>, graph: Map<string, Set<string>>): string[] {
  const rankOf = new Map(taxonomy.map((m) => [m.id, m.rank]));
  const byModule = new Map<string, OrderableFile[]>();
  for (const f of files) {
    const list = byModule.get(f.moduleId) ?? [];
    list.push(f);
    byModule.set(f.moduleId, list);
  }
  const moduleIds = [...byModule.keys()].sort((a, b) => (rankOf.get(a) ?? 999) - (rankOf.get(b) ?? 999));
  const order: string[] = [];
  for (const moduleId of moduleIds) {
    const list = byModule.get(moduleId) ?? [];
    const sorted = topoSortModule(list.map((f) => f.path), graph);
    order.push(...sorted);
  }
  return order;
}

export function computeRiskOrder(files: OrderableFile[]): string[] {
  return [...files]
    .sort((a, b) => {
      const riskDiff = (b.risk ?? -1) - (a.risk ?? -1);
      if (riskDiff !== 0) return riskDiff;
      const complexityDiff = (b.complexity ?? -1) - (a.complexity ?? -1);
      if (complexityDiff !== 0) return complexityDiff;
      return b.effectiveLines - a.effectiveLines;
    })
    .map((f) => f.path);
}

export async function computeChronoOrder(mirror: string, baseRef: string, headRef: string, paths: string[]): Promise<string[]> {
  const commits = await logNameStatusReverse(mirror, baseRef, headRef);
  const firstSeen = new Map<string, number>();
  commits.forEach((files, idx) => {
    for (const f of files) if (!firstSeen.has(f)) firstSeen.set(f, idx);
  });
  return [...paths].sort((a, b) => {
    const ai = firstSeen.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = firstSeen.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

export function toPositionMap(order: string[]): Map<string, number> {
  const map = new Map<string, number>();
  order.forEach((p, idx) => map.set(p, idx));
  return map;
}
