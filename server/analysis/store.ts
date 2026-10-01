import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../core/paths";
import type { Analysis } from "../../shared/types";

function analysisFilePath(owner: string, name: string, number: number): string {
  return path.join(dataDir("analysis"), `${owner}__${name}__${number}.json`);
}

export function loadAnalysis(owner: string, name: string, number: number): Analysis | null {
  try {
    const raw = readFileSync(analysisFilePath(owner, name, number), "utf8");
    return JSON.parse(raw) as Analysis;
  } catch {
    return null;
  }
}

export function saveAnalysis(owner: string, name: string, number: number, analysis: Analysis): void {
  writeFileSync(analysisFilePath(owner, name, number), JSON.stringify(analysis));
}

function overridesFilePath(owner: string, name: string, number: number): string {
  return path.join(dataDir("overrides"), `${owner}__${name}__${number}.json`);
}

export function loadOverrides(owner: string, name: string, number: number): Record<string, string> {
  try {
    const raw = readFileSync(overridesFilePath(owner, name, number), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveOverride(owner: string, name: string, number: number, filePath: string, moduleId: string): void {
  const current = loadOverrides(owner, name, number);
  current[filePath] = moduleId;
  writeFileSync(overridesFilePath(owner, name, number), JSON.stringify(current));
}
