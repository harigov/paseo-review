import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseValidatorMarkdown, unusableReason } from "../server/validators/parse";
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

  it("clamps an out-of-range threshold to [0,1] (D10)", () => {
    const tooHigh = parseValidatorMarkdown("---\ntitle: T\nthreshold: 1.5\n---\nbody\n", "personal", "t.md");
    expect(tooHigh.threshold).toBe(1);
    const tooLow = parseValidatorMarkdown("---\ntitle: T\nthreshold: -0.5\n---\nbody\n", "personal", "t.md");
    expect(tooLow.threshold).toBe(0);
    const inRange = parseValidatorMarkdown("---\ntitle: T\nthreshold: 0.6\n---\nbody\n", "personal", "t.md");
    expect(inRange.threshold).toBe(0.6);
  });
});

describe("unusableReason (D8)", () => {
  it("accepts a file with no frontmatter block as long as it has a body", () => {
    expect(unusableReason("no frontmatter here")).toBeNull();
  });

  it("accepts a file whose frontmatter parses fine, regardless of which fields are present", () => {
    expect(unusableReason("---\ntitle: Minimal\n---\nSome body\n")).toBeNull();
  });

  it("flags a frontmatter block that fails to parse as YAML", () => {
    const reason = unusableReason("---\ntitle: [unterminated flow seq\n---\nSome body\n");
    expect(reason).toMatch(/not valid YAML/);
  });

  it("flags a completely empty file", () => {
    expect(unusableReason("")).toMatch(/empty/);
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

  it("evaluate() always returns dismissed:false; dismissal is applied later by applyState (D3)", async () => {
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
    expect(result.status).toBe("fail");
    expect(result.findings[0].dismissed).toBe(false);
  });

  it("applyState flags dismissed findings and recomputes status so an all-dismissed validator no longer reads 'fail' (D3)", async () => {
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
    const raw = await service.evaluate({ validators: [validator], units, repo: "acme/widgets", number: 42 });
    const [result] = service.applyState("acme/widgets", 42, raw);
    expect(result.findings[0].dismissed).toBe(true);
    expect(result.status).toBe("pass");
  });

  it("applyState drops validators the user has since disabled, without re-evaluating (D3)", async () => {
    const validator = makeValidator("personal:rule", 0.8);
    await createValidatorService().setEnabled("acme/widgets", validator.id, false);
    const raw = [
      {
        validatorId: validator.id,
        title: validator.title,
        severity: validator.severity,
        status: "fail" as const,
        unitsEvaluated: 1,
        unitsApplicable: 1,
        findings: [],
        error: null,
      },
    ];
    const applied = createValidatorService().applyState("acme/widgets", 1, raw);
    expect(applied).toEqual([]);
  });

  it("reports status error only when every unit for that validator failed (D1)", async () => {
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

  it("keeps findings from units that succeeded even when another unit's request errors (D1)", async () => {
    const validator = makeValidator("personal:rule", 0.8);
    const units = [makeUnit("u1", "a.ts"), makeUnit("u2", "b.ts"), makeUnit("u3", "c.ts")];
    services.decide = {
      status: async () => ({ configured: true, reason: null, provider: "cloudflare", model: "clef-flash" }),
      evaluate: async (requests) =>
        requests.map((_req, i) => {
          if (i === 0)
            return {
              answers: { v_0: { type: "choice", choice: "violation", probabilities: { violation: 0.95, compliant: 0.05, not_applicable: 0 }, confidence: 0.95 } },
              inputTokens: 10,
            };
          if (i === 1)
            return {
              answers: { v_0: { type: "choice", choice: "violation", probabilities: { violation: 0.92, compliant: 0.08, not_applicable: 0 }, confidence: 0.92 } },
              inputTokens: 10,
            };
          return { error: "422 state too large" };
        }),
      classifyFiles: async () => [],
      prSeverity: async () => ({ severity: null, probabilities: null, changeType: null }),
      triageThreads: async () => [],
      substantiveChange: async () => [],
      attention: async () => [],
    };
    const service = createValidatorService();
    const [result] = await service.evaluate({ validators: [validator], units, repo: "acme/widgets", number: 1 });
    expect(result.status).toBe("fail");
    expect(result.findings.map((f) => f.unitKey).sort()).toEqual(["u1", "u2"]);
    expect(result.error).toMatch(/^partial: 1\/3 units failed/);
  });

  it("evaluates different unit kinds (hunk/file/pr) concurrently rather than one at a time (D6)", async () => {
    const hunkValidator = makeValidator("personal:hunk-rule", 0.8);
    const prValidator: Validator = { ...makeValidator("personal:pr-rule", 0.8), unit: "pr" };
    const hunkUnit = makeUnit("u1", "a.ts");
    const prUnit: ValidationUnit = { key: "pr1", kind: "pr", path: null, startLine: null, endLine: null, state: { title: "t" }, excerpt: "pr" };

    const callStarts: number[] = [];
    const start = Date.now();
    services.decide = {
      status: async () => ({ configured: true, reason: null, provider: "cloudflare", model: "clef-flash" }),
      evaluate: async (requests) => {
        callStarts.push(Date.now() - start);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return requests.map(() => ({
          answers: { v_0: { type: "choice", choice: "compliant", probabilities: { violation: 0.1, compliant: 0.8, not_applicable: 0.1 }, confidence: 0.8 } },
          inputTokens: 1,
        }));
      },
      classifyFiles: async () => [],
      prSeverity: async () => ({ severity: null, probabilities: null, changeType: null }),
      triageThreads: async () => [],
      substantiveChange: async () => [],
      attention: async () => [],
    };

    const service = createValidatorService();
    await service.evaluate({
      validators: [hunkValidator, prValidator],
      units: [hunkUnit, prUnit],
      repo: "acme/widgets",
      number: 1,
    });
    const elapsed = Date.now() - start;
    expect(callStarts).toHaveLength(2);
    // Parallel: both calls start close together and the whole thing takes ~100ms, not ~200ms.
    expect(Math.abs(callStarts[0] - callStarts[1])).toBeLessThan(50);
    expect(elapsed).toBeLessThan(180);
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

  it("excludes a repo validator with unparseable frontmatter and reports it in errors, instead of loading it as a generic always-on validator (D8)", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pr-review-repo-"));
    const validatorsDir = path.join(cwd, ".paseo", "validators");
    mkdirSync(validatorsDir, { recursive: true });
    writeFileSync(path.join(validatorsDir, "good.md"), "---\ntitle: Good\nviolation: v\ncompliant: c\n---\nIs this bad?\n");
    writeFileSync(path.join(validatorsDir, "broken.md"), "---\ntitle: [unterminated flow seq\n---\nSome body\n");

    const service = createValidatorService();
    const { validators, errors } = await service.loadValidators("acme/widgets", { cwd });
    const repoValidators = validators.filter((v) => v.source === "repo");
    expect(repoValidators.map((v) => v.id)).toEqual(["repo:good"]);
    expect(errors.some((e) => e.includes("broken.md") && e.includes("YAML"))).toBe(true);
  });
});

describe("ValidatorService.save path traversal defense (D2/D16)", () => {
  it("rejects a personal fileName that attempts to escape the validators directory via '..'", async () => {
    const service = createValidatorService();
    await expect(service.save("acme/widgets", "personal", "../../../../tmp/evil-pwned", "# evil")).rejects.toThrow();
  });

  it("rejects a repo fileName that attempts to escape the repo's .paseo/validators directory via '..'", async () => {
    const rootPath = mkdtempSync(path.join(tmpdir(), "pr-review-repo-root-"));
    services.github = {
      listRepos: async () => ({ repos: [], errors: [] }),
      findRepo: async () => ({
        slug: "acme/widgets",
        owner: "acme",
        name: "widgets",
        projectId: "p1",
        projectName: "widgets",
        rootPath,
        decisionsEnabled: true,
      }),
      getViewer: async () => "me",
      listInbox: async () => ({ viewer: "me", prs: [], fetchedAt: "", errors: [] }),
      getPr: async () => {
        throw new Error("not used");
      },
      setViewed: async () => "VIEWED",
    };
    const service = createValidatorService();
    await expect(
      service.save("acme/widgets", "repo", "../../../../../../etc/cron.d/evil", "# evil"),
    ).rejects.toThrow();
  });

  it("rejects a fileName containing a path separator even without '..'", async () => {
    const service = createValidatorService();
    await expect(service.save("acme/widgets", "personal", "sub/dir/evil", "# evil")).rejects.toThrow();
  });

  it("accepts a plain fileName and appends .md when missing", async () => {
    const service = createValidatorService();
    await expect(service.save("acme/widgets", "personal", "my-new-rule", "# fine")).resolves.toBeUndefined();
  });
});
