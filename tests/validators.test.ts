import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseValidatorMarkdown } from "../server/validators/parse";
import { createValidatorService } from "../server/validators/index";
import { services, type ValidationUnit } from "../server/core/services";
import { dismissFinding } from "../server/validators/store";
import type { Validator } from "../shared/types";

beforeAll(() => {
  process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pr-review-validators-"));
});

describe("parseValidatorMarkdown", () => {
  it("parses our own frontmatter format", () => {
    const markdown = `---
title: Authorization is enforced
severity: blocking
unit: hunk
threshold: 0.8
violation: A handler mutates data without checking permissions
compliant: The handler checks permissions first
not_applicable: No handler touched
---
Does this change let a caller act on data without an authorization check?
`;
    const v = parseValidatorMarkdown(markdown, "starter", "authorization-enforced.md");
    expect(v.id).toBe("starter:authorization-enforced");
    expect(v.title).toBe("Authorization is enforced");
    expect(v.severity).toBe("blocking");
    expect(v.unit).toBe("hunk");
    expect(v.threshold).toBe(0.8);
    expect(v.violation).toContain("without checking permissions");
    expect(v.body.trim()).toBe("Does this change let a caller act on data without an authorization check?");
    expect(v.enabled).toBe(true);
  });

  it("applies defaults when frontmatter fields are missing", () => {
    const v = parseValidatorMarkdown("---\ntitle: Minimal\n---\nSome body\n", "personal", "minimal.md");
    expect(v.severity).toBe("warning");
    expect(v.unit).toBe("hunk");
    expect(v.threshold).toBe(0.8);
    expect(v.violation).toBeTruthy();
    expect(v.compliant).toBeTruthy();
    expect(v.notApplicable).toBeTruthy();
  });

  it("derives violation/compliant/not_applicable from an awesome-reviewers style file", () => {
    const markdown = `---
title: Use parameterized queries
description: Avoid building SQL by string concatenation; use parameterized queries instead
label: security
language: python
---
`;
    const v = parseValidatorMarkdown(markdown, "repo", "use-parameterized-queries.md");
    expect(v.title).toBe("Use parameterized queries");
    expect(v.violation).toMatch(/parameterized queries/);
    expect(v.compliant).toMatch(/parameterized queries/);
    expect(v.notApplicable).toBeTruthy();
    expect(v.body).toMatch(/parameterized queries/);
  });

  it("falls back to the file basename when title is missing", () => {
    const v = parseValidatorMarkdown("no frontmatter here", "personal", "my-rule.md");
    expect(v.title).toBe("my-rule");
    expect(v.id).toBe("personal:my-rule");
  });
});

function makeUnit(key: string, path_: string): ValidationUnit {
  return {
    key,
    kind: "hunk",
    path: path_,
    startLine: 1,
    endLine: 10,
    state: { hunk: "+ const x = 1;" },
    excerpt: "+ const x = 1;",
  };
}

function makeValidator(id: string, threshold = 0.8): Validator {
  return {
    id,
    title: "Test validator",
    severity: "warning",
    unit: "hunk",
    threshold,
    violation: "violates",
    compliant: "complies",
    notApplicable: "n/a",
    body: "Does this violate the rule?",
    source: "personal",
    path: "(draft)",
    enabled: true,
  };
}

describe("ValidatorService.evaluate", () => {
  beforeEach(() => {
    process.env.PASEO_HOME = mkdtempSync(path.join(tmpdir(), "pr-review-validators-eval-"));
  });

  it("aggregates fail/uncertain/pass/na across units and sorts findings by probability", async () => {
    const validator = makeValidator("personal:rule", 0.8);
    const units = [makeUnit("u1", "a.ts"), makeUnit("u2", "b.ts"), makeUnit("u3", "c.ts")];

    services.decide = {
      status: async () => ({ configured: true, reason: null, provider: "cloudflare", model: "clef-flash" }),
      evaluate: async (requests) =>
        requests.map((_req, i) => {
          if (i === 0) return { answers: { v_0: { type: "choice", choice: "violation", probabilities: { violation: 0.6, compliant: 0.3, not_applicable: 0.1 }, confidence: 0.6 } }, inputTokens: 10 };
          if (i === 1) return { answers: { v_0: { type: "choice", choice: "violation", probabilities: { violation: 0.95, compliant: 0.05, not_applicable: 0 }, confidence: 0.95 } }, inputTokens: 10 };
          return { answers: { v_0: { type: "choice", choice: "not_applicable", probabilities: { violation: 0.05, compliant: 0.05, not_applicable: 0.9 }, confidence: 0.9 } }, inputTokens: 10 };
        }),
      classifyFiles: async () => [],
      prSeverity: async () => ({ severity: null, probabilities: null, changeType: null }),
      triageThreads: async () => [],
      substantiveChange: async () => [],
      attention: async () => [],
    };

    const service = createValidatorService();
    const [result] = await service.evaluate({ validators: [validator], units, repo: "acme/widgets", number: 1 });

    expect(result.status).toBe("fail"); // unit u2 failed (p=0.95 >= threshold 0.8)
    expect(result.unitsEvaluated).toBe(3);
    expect(result.unitsApplicable).toBe(2); // u1 (uncertain) and u2 (fail) are applicable; u3 is n/a
    expect(result.findings).toHaveLength(2);
    // sorted by probability desc: u2 (0.95) before u1 (0.6)
    expect(result.findings[0].unitKey).toBe("u2");
    expect(result.findings[0].status).toBe("fail");
    expect(result.findings[1].unitKey).toBe("u1");
    expect(result.findings[1].status).toBe("uncertain");
  });

  it("marks a finding dismissed when recorded in the dismissal store", async () => {
    const validator = makeValidator("personal:rule", 0.8);
    const units = [makeUnit("u1", "a.ts")];
    dismissFinding("acme/widgets", 42, validator.id, "u1");

    services.decide = {
      status: async () => ({ configured: true, reason: null, provider: "cloudflare", model: "clef-flash" }),
      evaluate: async () => [
        { answers: { v_0: { type: "choice", choice: "violation", probabilities: { violation: 0.9, compliant: 0.1, not_applicable: 0 }, confidence: 0.9 } }, inputTokens: 5 },
      ],
      classifyFiles: async () => [],
      prSeverity: async () => ({ severity: null, probabilities: null, changeType: null }),
      triageThreads: async () => [],
      substantiveChange: async () => [],
      attention: async () => [],
    };

    const service = createValidatorService();
    const [result] = await service.evaluate({ validators: [validator], units, repo: "acme/widgets", number: 42 });
    expect(result.findings[0].dismissed).toBe(true);
  });

  it("reports status error when the decision call fails for a unit", async () => {
    const validator = makeValidator("personal:rule", 0.8);
    const units = [makeUnit("u1", "a.ts")];
    services.decide = {
      status: async () => ({ configured: false, reason: "not configured", provider: "cloudflare", model: "clef-flash" }),
      evaluate: async (requests) => requests.map(() => ({ error: "not configured" })),
      classifyFiles: async () => [],
      prSeverity: async () => ({ severity: null, probabilities: null, changeType: null }),
      triageThreads: async () => [],
      substantiveChange: async () => [],
      attention: async () => [],
    };
    const service = createValidatorService();
    const [result] = await service.evaluate({ validators: [validator], units, repo: "acme/widgets", number: 1 });
    expect(result.status).toBe("error");
    expect(result.error).toBe("not configured");
  });

  it("returns no results when every validator is disabled", async () => {
    const validator = { ...makeValidator("personal:rule"), enabled: false };
    const service = createValidatorService();
    const results = await service.evaluate({ validators: [validator], units: [makeUnit("u1", "a.ts")], repo: "acme/widgets", number: 1 });
    expect(results).toEqual([]);
  });
});

describe("loadValidators", () => {
  it("includes the starter pack and applies personal enable/disable overrides", async () => {
    const service = createValidatorService();
    const { validators } = await service.loadValidators("acme/widgets", {});
    const starterIds = validators.filter((v) => v.source === "starter").map((v) => v.id);
    expect(starterIds.length).toBeGreaterThanOrEqual(10);
    expect(starterIds).toContain("starter:authorization-enforced");
    expect(validators.every((v) => v.enabled)).toBe(true);

    await service.setEnabled("acme/widgets", "starter:authorization-enforced", false);
    const { validators: after } = await service.loadValidators("acme/widgets", {});
    const toggled = after.find((v) => v.id === "starter:authorization-enforced");
    expect(toggled?.enabled).toBe(false);
  });
});
