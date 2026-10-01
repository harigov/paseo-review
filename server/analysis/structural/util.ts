// Shared helpers for the structural-diff computations (JSON/YAML and lockfiles).

/** Entries beyond this count are dropped and `truncated` is set. */
export const STRUCTURAL_ENTRY_CAP = 2000;

/** A short, single-line reason string for a caught parse failure. */
export function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split("\n")[0]!.trim() || "parse failed";
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}
