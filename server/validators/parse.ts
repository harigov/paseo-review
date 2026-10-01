import YAML from "yaml";
import { ValidatorSeveritySchema, ValidatorUnitSchema, type Validator } from "../../shared/types";

function basenameNoExt(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.md$/i, "");
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) return { frontmatter: {}, body: markdown };
  try {
    const parsed = YAML.parse(match[1]);
    return { frontmatter: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}, body: match[2] };
  } catch {
    return { frontmatter: {}, body: match[2] };
  }
}

/**
 * Returns a human-readable reason this file can't be used as a validator, or null when it's
 * fine. A file with no frontmatter block at all is a *supported* authoring style (its body
 * alone becomes the instructions, title falls back to the file name) — that's not an error.
 * But a frontmatter block that fails to parse as YAML silently became an all-defaults, always-
 * enabled, meaningless validator before this check existed; callers should exclude the file and
 * surface this instead of loading it quietly.
 */
export function unusableReason(markdown: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (match) {
    try {
      YAML.parse(match[1]);
      return null;
    } catch (error) {
      return `frontmatter is not valid YAML (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  if (!markdown.trim()) return "the file is empty";
  return null;
}

/**
 * Parses one validator markdown file. Accepts our own format (title/severity/unit/threshold/
 * violation/compliant/not_applicable + markdown body) and degrades gracefully for
 * awesome-reviewers style files (title/description/label/language), deriving
 * violation/compliant/not_applicable generically from the description.
 */
export function parseValidatorMarkdown(markdown: string, source: Validator["source"], filePath: string): Validator {
  const { frontmatter: fm, body } = splitFrontmatter(markdown);

  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : basenameNoExt(filePath);
  const severity = ValidatorSeveritySchema.safeParse(fm.severity).success ? (fm.severity as Validator["severity"]) : "warning";
  const unit = ValidatorUnitSchema.safeParse(fm.unit).success ? (fm.unit as Validator["unit"]) : "hunk";
  const rawThreshold = typeof fm.threshold === "number" && Number.isFinite(fm.threshold) ? fm.threshold : 0.8;
  const threshold = Math.min(1, Math.max(0, rawThreshold));
  if (threshold !== rawThreshold) {
    console.warn(
      `[pr-review] validator ${filePath}: threshold ${rawThreshold} is outside [0,1]; clamped to ${threshold}.`,
    );
  }

  let violation = typeof fm.violation === "string" ? fm.violation : null;
  let compliant = typeof fm.compliant === "string" ? fm.compliant : null;
  let notApplicable = typeof fm.not_applicable === "string" ? fm.not_applicable : typeof fm.notApplicable === "string" ? fm.notApplicable : null;

  const description = typeof fm.description === "string" ? fm.description.trim() : null;
  if (description && (!violation || !compliant)) {
    violation = violation ?? `The change violates this rule: ${description}`;
    compliant = compliant ?? `The change follows this rule: ${description}`;
    notApplicable = notApplicable ?? "The rule does not apply to this change.";
  }

  violation = violation ?? "The change violates this validator's rule.";
  compliant = compliant ?? "The change follows this validator's rule.";
  notApplicable = notApplicable ?? "This validator does not apply to this change.";

  const bodyText = body.trim() || description || "";

  return {
    id: `${source}:${basenameNoExt(filePath)}`,
    title,
    severity,
    unit,
    threshold,
    violation,
    compliant,
    notApplicable,
    body: bodyText,
    source,
    path: filePath,
    enabled: true,
  };
}
