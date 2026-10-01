import { services } from "../core/services";

// Shared guidance-file collection (plan §6.7): REVIEW.md / AGENTS.md / CLAUDE.md from the repo
// root, plus the same files from the nearest ancestor of each touched directory. Used by both
// the agent context pack (prompts.ts) and the `repo_guidance` MCP tool (mcp.ts) so the walk and
// the file list live in exactly one place.

export const GUIDANCE_FILE_NAMES = ["REVIEW.md", "AGENTS.md", "CLAUDE.md"];

function dirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}

function parentOf(dir: string): string | null {
  if (!dir) return null;
  const idx = dir.lastIndexOf("/");
  return idx === -1 ? "" : dir.slice(0, idx);
}

export interface GuidanceFile {
  path: string;
  content: string;
}

/**
 * Collects guidance files for the repo root and the nearest ancestor of each touched
 * directory. For each starting directory and file name, walks upward until it finds a hit (or
 * reaches the root), so a directory with its own `AGENTS.md` doesn't also drag in a redundant
 * root copy. Results are deduped by resolved path and capped.
 */
export async function collectGuidanceFiles(
  repoSlug: string,
  ref: string,
  touchedPaths: string[],
  options: { maxBytesPerFile?: number; maxFiles?: number } = {},
): Promise<GuidanceFile[]> {
  const maxBytes = options.maxBytesPerFile ?? 4000;
  const maxFiles = options.maxFiles ?? 20;

  const startDirs = new Set<string>(touchedPaths.map(dirOf));
  startDirs.add(""); // always consider the repo root

  const readCache = new Map<string, GuidanceFile | null>();
  async function readCandidate(candidate: string): Promise<GuidanceFile | null> {
    if (readCache.has(candidate)) return readCache.get(candidate) ?? null;
    let content: string | null = null;
    try {
      content = await services.analysis.readFileAtRef(repoSlug, ref, candidate);
    } catch {
      content = null;
    }
    const result = content ? { path: candidate, content: content.slice(0, maxBytes) } : null;
    readCache.set(candidate, result);
    return result;
  }

  const results: GuidanceFile[] = [];
  const addedPaths = new Set<string>();

  for (const startDir of startDirs) {
    for (const name of GUIDANCE_FILE_NAMES) {
      let dir: string | null = startDir;
      while (dir !== null) {
        const candidate = dir ? `${dir}/${name}` : name;
        const hit = await readCandidate(candidate);
        if (hit) {
          if (!addedPaths.has(hit.path)) {
            addedPaths.add(hit.path);
            results.push(hit);
          }
          break;
        }
        dir = parentOf(dir);
      }
      if (results.length >= maxFiles) return results;
    }
  }
  return results;
}
