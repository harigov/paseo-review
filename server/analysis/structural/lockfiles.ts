import YAML from "yaml";
import type { StructuralDiff, StructuralEntry } from "../../../shared/types";
import { STRUCTURAL_ENTRY_CAP, shortReason } from "./util";

// Lockfile structural diffs: each format parses into `name -> set of versions present`, then we
// diff those maps. Lines are best-effort only (most formats don't carry them at all here).

type VersionMap = Map<string, Set<string>>;

function addVersion(map: VersionMap, name: string | null | undefined, version: string | null | undefined): void {
  if (!name || !version) return;
  const set = map.get(name);
  if (set) set.add(version);
  else map.set(name, new Set([version]));
}

// ---------- npm (package-lock.json, npm-shrinkwrap.json) ----------

function parseNpm(text: string): VersionMap {
  const data = JSON.parse(text) as Record<string, unknown>;
  const result: VersionMap = new Map();
  const packages = data.packages;
  if (packages && typeof packages === "object") {
    for (const [key, info] of Object.entries(packages as Record<string, unknown>)) {
      if (key === "") continue; // the root project itself
      const marker = "node_modules/";
      const idx = key.lastIndexOf(marker);
      const name = idx === -1 ? key : key.slice(idx + marker.length);
      const version = info && typeof info === "object" ? (info as Record<string, unknown>).version : undefined;
      addVersion(result, name, typeof version === "string" ? version : undefined);
    }
    return result;
  }
  const dependencies = data.dependencies;
  if (dependencies && typeof dependencies === "object") {
    const walk = (deps: Record<string, unknown>) => {
      for (const [name, info] of Object.entries(deps)) {
        if (!info || typeof info !== "object") continue;
        const version = (info as Record<string, unknown>).version;
        addVersion(result, name, typeof version === "string" ? version : undefined);
        const nested = (info as Record<string, unknown>).dependencies;
        if (nested && typeof nested === "object") walk(nested as Record<string, unknown>);
      }
    };
    walk(dependencies as Record<string, unknown>);
  }
  return result;
}

// ---------- pnpm (pnpm-lock.yaml) ----------

function parsePnpmKey(rawKey: string): { name: string; version: string } | null {
  const key = rawKey.startsWith("/") ? rawKey.slice(1) : rawKey;
  // v6+ encodes peers as a parenthesised suffix: react-dom@18.2.0(react@18.2.0).
  const parenIdx = key.indexOf("(");
  const noParen = parenIdx === -1 ? key : key.slice(0, parenIdx);
  // v5 encodes peers as an underscore suffix straight after the version, e.g.
  // /react-dom/18.2.0_react@18.2.0 or the "@"-separated /react-dom@18.2.0_react@18.2.0 variant.
  // Drop it before splitting name from version: the peer's own "@"/"/" characters would otherwise
  // be mistaken for the real name/version separator.
  const underscoreIdx = noParen.indexOf("_");
  const core = underscoreIdx === -1 ? noParen : noParen.slice(0, underscoreIdx);

  // "name@version" shape (v6+ without parens, or the v5.4+ "@"-separated variant). The "@" that
  // separates name from version is never the scope's own leading "@", so skip past "@scope/"
  // before searching for it.
  const scopeEnd = core.startsWith("@") ? Math.max(core.indexOf("/") + 1, 1) : 0;
  const atIdx = core.indexOf("@", scopeEnd);
  if (atIdx !== -1) {
    return { name: core.slice(0, atIdx), version: core.slice(atIdx + 1) };
  }
  // v5-style: /name/1.2.3 or /@scope/name/1.2.3 (version separated by "/", not "@version").
  const parts = core.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const version = parts[parts.length - 1]!;
  const name = parts.slice(0, -1).join("/");
  return { name, version };
}

function parsePnpm(text: string): VersionMap {
  const data = YAML.parse(text) as Record<string, unknown> | null;
  const result: VersionMap = new Map();
  const packages = data && typeof data === "object" ? (data as Record<string, unknown>).packages : null;
  if (packages && typeof packages === "object") {
    for (const key of Object.keys(packages as Record<string, unknown>)) {
      const parsed = parsePnpmKey(key);
      if (parsed) addVersion(result, parsed.name, parsed.version);
    }
  }
  return result;
}

// ---------- yarn (yarn.lock: v1 text, or Berry YAML) ----------

function yarnSelectorName(selector: string): string {
  const trimmed = selector.trim().replace(/^"|"$/g, "");
  const atIdx = trimmed.lastIndexOf("@");
  return atIdx > 0 ? trimmed.slice(0, atIdx) : trimmed;
}

function isYarnBerry(text: string): boolean {
  return /(^|\n)__metadata:/.test(text);
}

function parseYarnV1(text: string): VersionMap {
  const result: VersionMap = new Map();
  let currentName: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const header = line.trim().replace(/:$/, "");
      const firstSelector = header.split(",")[0] ?? "";
      currentName = yarnSelectorName(firstSelector);
      continue;
    }
    const m = /^\s+version\s+"([^"]+)"/.exec(line);
    if (m && currentName) addVersion(result, currentName, m[1]);
  }
  return result;
}

function parseYarnBerry(text: string): VersionMap {
  const data = YAML.parse(text) as Record<string, unknown> | null;
  const result: VersionMap = new Map();
  if (!data || typeof data !== "object") return result;
  for (const [key, info] of Object.entries(data as Record<string, unknown>)) {
    if (key === "__metadata") continue;
    const version = info && typeof info === "object" ? (info as Record<string, unknown>).version : undefined;
    if (typeof version !== "string") continue;
    const firstSelector = key.split(",")[0] ?? "";
    addVersion(result, yarnSelectorName(firstSelector), version);
  }
  return result;
}

function parseYarn(text: string): VersionMap {
  return isYarnBerry(text) ? parseYarnBerry(text) : parseYarnV1(text);
}

// ---------- cargo (Cargo.lock) and poetry (poetry.lock): simple [[package]] line scanner ----------

function parseTomlPackages(text: string): VersionMap {
  const result: VersionMap = new Map();
  let inPackage = false;
  let name: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "[[package]]") {
      inPackage = true;
      name = null;
      continue;
    }
    if (line.startsWith("[")) {
      if (line !== "[[package]]") inPackage = false;
      continue;
    }
    if (!inPackage) continue;
    const nameMatch = /^name\s*=\s*"([^"]*)"/.exec(line);
    if (nameMatch) {
      name = nameMatch[1]!;
      continue;
    }
    const versionMatch = /^version\s*=\s*"([^"]*)"/.exec(line);
    if (versionMatch && name) addVersion(result, name, versionMatch[1]);
  }
  return result;
}

// ---------- go (go.sum) ----------

function parseGoSum(text: string): VersionMap {
  const result: VersionMap = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const moduleName = parts[0]!;
    let version = parts[1]!;
    if (version.endsWith("/go.mod")) version = version.slice(0, -"/go.mod".length);
    addVersion(result, moduleName, version);
  }
  return result;
}

// ---------- bundler (Gemfile.lock) ----------

// GEM is the rubygems.org section; GIT and PATH are gems sourced from a git repo or a local path
// (each one block per source). All three lay out their gems the same way: a `  specs:` line
// followed by 4-space-indented `name (version)` entries, with deeper-indented lines being that
// gem's own dependencies (to be ignored, not re-parsed as top-level specs).
const DEP_SECTION_HEADERS = new Set(["GEM", "GIT", "PATH"]);

function parseGemfileLock(text: string): VersionMap {
  const result: VersionMap = new Map();
  let inDepSection = false;
  let inSpecs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inDepSection = DEP_SECTION_HEADERS.has(line.trim());
      inSpecs = false;
      continue;
    }
    if (!inDepSection) continue;
    if (/^ {2}specs:\s*$/.test(line)) {
      inSpecs = true;
      continue;
    }
    if (!inSpecs) continue;
    const m = /^ {4}(?! )(\S+) \(([^)]+)\)\s*$/.exec(line);
    if (m) addVersion(result, m[1], m[2]);
  }
  return result;
}

// ---------- composer (composer.lock) ----------

function parseComposerLock(text: string): VersionMap {
  const data = JSON.parse(text) as Record<string, unknown>;
  const result: VersionMap = new Map();
  const addAll = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const pkg of arr) {
      if (!pkg || typeof pkg !== "object") continue;
      const name = (pkg as Record<string, unknown>).name;
      const version = (pkg as Record<string, unknown>).version;
      if (typeof name === "string" && typeof version === "string") addVersion(result, name, version);
    }
  };
  addAll(data.packages);
  addAll(data["packages-dev"]);
  return result;
}

// ---------- pipenv (Pipfile.lock) ----------

function parsePipfileLock(text: string): VersionMap {
  const data = JSON.parse(text) as Record<string, unknown>;
  const result: VersionMap = new Map();
  const addSection = (section: unknown) => {
    if (!section || typeof section !== "object") return;
    for (const [name, info] of Object.entries(section as Record<string, unknown>)) {
      if (!info || typeof info !== "object") continue;
      const rawVersion = (info as Record<string, unknown>).version;
      if (typeof rawVersion !== "string") continue;
      const version = rawVersion.startsWith("==") ? rawVersion.slice(2) : rawVersion;
      addVersion(result, name, version);
    }
  };
  addSection(data.default);
  addSection(data.develop);
  return result;
}

function parseLockfilePackages(format: string, text: string): VersionMap {
  switch (format) {
    case "npm":
      return parseNpm(text);
    case "pnpm":
      return parsePnpm(text);
    case "yarn":
      return parseYarn(text);
    case "cargo":
    case "poetry":
      return parseTomlPackages(text);
    case "go":
      return parseGoSum(text);
    case "bundler":
      return parseGemfileLock(text);
    case "composer":
      return parseComposerLock(text);
    case "pipenv":
      return parsePipfileLock(text);
    default:
      throw new Error("Unsupported lockfile");
  }
}

function renderVersions(set: Set<string>): string {
  return Array.from(set)
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
}

function versionSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function diffLockfile(path: string, format: string | null, oldText: string | null, newText: string | null): StructuralDiff {
  const base = { path, kind: "lockfile" as const, format };
  try {
    if (!format) throw new Error("Unsupported lockfile");
    const oldMap = oldText === null ? new Map<string, Set<string>>() : parseLockfilePackages(format, oldText);
    const newMap = newText === null ? new Map<string, Set<string>>() : parseLockfilePackages(format, newText);
    const names = Array.from(new Set<string>([...oldMap.keys(), ...newMap.keys()])).sort((a, b) => a.localeCompare(b));
    const entries: StructuralEntry[] = [];
    let truncated = false;
    for (const name of names) {
      if (entries.length >= STRUCTURAL_ENTRY_CAP) {
        truncated = true;
        break;
      }
      const oldVersions = oldMap.get(name);
      const newVersions = newMap.get(name);
      if (oldVersions && newVersions) {
        if (versionSetsEqual(oldVersions, newVersions)) continue;
        entries.push({ path: name, change: "changed", oldValue: renderVersions(oldVersions), newValue: renderVersions(newVersions), oldLine: null, newLine: null });
      } else if (oldVersions) {
        entries.push({ path: name, change: "removed", oldValue: renderVersions(oldVersions), newValue: null, oldLine: null, newLine: null });
      } else if (newVersions) {
        entries.push({ path: name, change: "added", oldValue: null, newValue: renderVersions(newVersions), oldLine: null, newLine: null });
      }
    }
    return { ...base, entries, truncated, error: null };
  } catch (err) {
    return { ...base, entries: [], truncated: false, error: shortReason(err) };
  }
}
