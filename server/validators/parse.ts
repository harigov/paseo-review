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
  const threshold = typeof fm.threshold === "number" && Number.isFinite(fm.threshold) ? fm.threshold : 0.8;

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
