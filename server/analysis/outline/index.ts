import type { Declaration, LanguageExtractor } from "./types";
import { extractGo } from "./go";
import { extractJava } from "./java";
import { extractKotlin } from "./kotlin";
import { extractPython } from "./python";
import { extractRuby } from "./ruby";
import { extractRust } from "./rust";
import { extractTypeScript } from "./typescript";

export type { Declaration } from "./types";

// One extractor per language id (see OUTLINE_LANGUAGE_BY_EXT in ../outline.ts), each regex-based
// and swappable for a tree-sitter implementation later without touching the orchestration code.
const EXTRACTORS: Record<string, LanguageExtractor> = {
  typescript: extractTypeScript,
  javascript: extractTypeScript,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  java: extractJava,
  kotlin: extractKotlin,
  ruby: extractRuby,
};

export function extractDeclarations(language: string, content: string): Declaration[] {
  const extractor = EXTRACTORS[language];
  return extractor ? extractor(content) : [];
}
