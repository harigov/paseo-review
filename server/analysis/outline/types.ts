import type { OutlineKind } from "../../../shared/types";
import { isSubstantialBody, normalizeBody, sha256Hex, truncateSignature } from "./scan";

/** A single declaration extracted from one side (base or head) of a file. */
export interface Declaration {
  /** Qualified name, e.g. "UserService.create" or "parse". */
  name: string;
  kind: OutlineKind;
  exported: boolean;
  /** Trimmed, whitespace-collapsed header line (<=200 chars). */
  signature: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  bodyHash: string;
  /** Whether the normalised body is long enough to anchor a rename/move match. */
  bodySubstantial: boolean;
}

/** A per-language extraction function: full file content in, every declaration it finds out. */
export type LanguageExtractor = (content: string) => Declaration[];

/**
 * Builds a `Declaration` from a located header line and its computed end line. `endLineIdx` is
 * 0-based and inclusive; the body is everything strictly after the header line up to and
 * including it.
 */
export function buildDeclaration(opts: {
  name: string;
  kind: OutlineKind;
  exported: boolean;
  headerLine: string;
  startLineIdx: number;
  endLineIdx: number;
  lines: string[];
}): Declaration {
  const endLineIdx = Math.max(opts.startLineIdx, opts.endLineIdx);
  const bodyLines = opts.lines.slice(opts.startLineIdx + 1, endLineIdx + 1);
  const normalizedBody = normalizeBody(bodyLines);
  return {
    name: opts.name,
    kind: opts.kind,
    exported: opts.exported,
    signature: truncateSignature(opts.headerLine),
    startLine: opts.startLineIdx + 1,
    endLine: endLineIdx + 1,
    bodyHash: sha256Hex(normalizedBody),
    bodySubstantial: isSubstantialBody(normalizedBody),
  };
}
