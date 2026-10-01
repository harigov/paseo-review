// Shared helpers for the structural-diff computations (JSON/YAML and lockfiles).

/** Entries beyond this count are dropped and `truncated` is set. */
export const STRUCTURAL_ENTRY_CAP = 2000;

/**
 * Either side strictly larger than this many bytes: skip parsing entirely (JSON and lockfiles).
 * The `prr.file.structural` RPC has a 30s budget; a file this large isn't worth a structural view.
 */
export const STRUCTURAL_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * YAML-specific ceiling, lower than `STRUCTURAL_MAX_BYTES`: the `yaml` package's parser (run with
 * a LineCounter so every node carries a line number) is roughly 10x slower than `JSON.parse`.
 */
export const YAML_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

/**
 * For `.json` files, either side strictly larger than this switches from the line-number-carrying
 * `yaml`-based parser to a direct `JSON.parse` (entries then report null lines on both sides).
 */
export const JSON_DIRECT_PARSE_BYTES = 300 * 1024; // 300 KB

/** Shared message for any of the size caps above tripping. */
export const STRUCTURAL_TOO_LARGE_MESSAGE = "File too large for a structural view (over 2 MB).";

/** A short, single-line reason string for a caught parse failure. */
export function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split("\n")[0]!.trim() || "parse failed";
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}
