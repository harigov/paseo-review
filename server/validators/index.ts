import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  localValidateRpc,
  validatorsDismissRpc,
  validatorsListRpc,
  validatorsSaveRpc,
  validatorsTestRpc,
  validatorsToggleRpc,
} from "../../shared/rpc";
import type { Validator, ValidatorFinding, ValidatorResult } from "../../shared/types";
import { run } from "../core/exec";
import { handle } from "../core/handle";
import { startJob } from "../core/jobs";
import { dataDir } from "../core/paths";
import { services, type ValidationUnit, type ValidatorService } from "../core/services";
import { parseValidatorMarkdown } from "./parse";
import { STARTER_VALIDATORS } from "./starter";
import { dismissFinding, readDismissals, readEnabledState, writeEnabledState } from "./store";

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadStarterValidators(): Validator[] {
  return STARTER_VALIDATORS.map((s) => parseValidatorMarkdown(s.markdown, "starter", `${s.name}.md`));
}

function loadPersonalValidators(): { validators: Validator[]; errors: string[] } {
  const dir = dataDir("validators");
  const validators: Validator[] = [];
  const errors: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return { validators, errors };
  }
  for (const name of names) {
    try {
      const markdown = readFileSync(path.join(dir, name), "utf8");
      validators.push(parseValidatorMarkdown(markdown, "personal", name));
    } catch (error) {
      errors.push(`personal validator ${name}: ${errMessage(error)}`);
    }
  }
  return { validators, errors };
}

async function loadRepoValidators(options?: { mirrorPath?: string; ref?: string; cwd?: string }): Promise<{
  validators: Validator[];
  errors: string[];
}> {
  const validators: Validator[] = [];
  const errors: string[] = [];
  if (!options) return { validators, errors };

  if (options.mirrorPath && options.ref) {
    try {
      const ls = await run(
        "git",
        ["-C", options.mirrorPath, "ls-tree", "--name-only", options.ref, ".paseo/validators/"],
        { allowFailure: true },
      );
      const paths = ls.stdout
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p.toLowerCase().endsWith(".md"));
      for (const p of paths) {
        try {
          const show = await run("git", ["-C", options.mirrorPath, "show", `${options.ref}:${p}`]);
          validators.push(parseValidatorMarkdown(show.stdout, "repo", p));
        } catch (error) {
          errors.push(`repo validator ${p}: ${errMessage(error)}`);
        }
      }
    } catch (error) {
      errors.push(`repo validators: ${errMessage(error)}`);
    }
    return { validators, errors };
  }

  if (options.cwd) {
    const dir = path.join(options.cwd, ".paseo", "validators");
    if (existsSync(dir)) {
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".md"));
      } catch (error) {
        errors.push(`repo validators: ${errMessage(error)}`);
      }
      for (const name of names) {
        try {
          const markdown = readFileSync(path.join(dir, name), "utf8");
          validators.push(parseValidatorMarkdown(markdown, "repo", `.paseo/validators/${name}`));
        } catch (error) {
          errors.push(`repo validator ${name}: ${errMessage(error)}`);
        }
      }
    }
  }
  return { validators, errors };
}

function groupByUnit(validators: Validator[]): Map<Validator["unit"], Validator[]> {
  const map = new Map<Validator["unit"], Validator[]>();
  for (const v of validators) {
    const list = map.get(v.unit) ?? [];
    list.push(v);
    map.set(v.unit, list);
  }
  return map;
}

// Latest local (working-directory) validate result, kept in memory for the UI poller.
const latestLocalResults = new Map<string, ValidatorResult[]>();

export function getLatestLocalResult(cwd: string): ValidatorResult[] | null {
  return latestLocalResults.get(cwd) ?? null;
}

export function createValidatorService(): ValidatorService {
  async function loadValidators(
    repo: string,
    options?: { mirrorPath?: string; ref?: string; cwd?: string },
  ): Promise<{ validators: Validator[]; errors: string[] }> {
    const errors: string[] = [];
    const starter = loadStarterValidators();
    const personal = loadPersonalValidators();
    errors.push(...personal.errors);
    const repoResult = await loadRepoValidators(options);
    errors.push(...repoResult.errors);

    const all = [...starter, ...personal.validators, ...repoResult.validators];
    const state = repo ? readEnabledState(repo) : {};
    for (const v of all) {
      if (v.id in state) v.enabled = state[v.id];
    }
    return { validators: all, errors };
  }

  function parseValidator(markdown: string, source: Validator["source"], filePath: string): Validator {
    return parseValidatorMarkdown(markdown, source, filePath);
  }

  async function evaluate(input: {
    validators: Validator[];
    units: ValidationUnit[];
    repo: string;
    number?: number;
  }): Promise<ValidatorResult[]> {
    const enabled = input.validators.filter((v) => v.enabled);
    if (enabled.length === 0) return [];

    const dismissed =
      input.repo && input.number !== undefined ? readDismissals(input.repo, input.number) : new Set<string>();

    const unitsByKind = new Map<Validator["unit"], ValidationUnit[]>();
    for (const unit of input.units) {
      const list = unitsByKind.get(unit.kind) ?? [];
      list.push(unit);
      unitsByKind.set(unit.kind, list);
    }

    interface Agg {
      validator: Validator;
      findings: ValidatorFinding[];
      unitsEvaluated: number;
      unitsApplicable: number;
      sawFail: boolean;
      sawUncertain: boolean;
      sawApplicable: boolean;
      error: string | null;
    }
    const aggs = new Map<string, Agg>();
    for (const v of enabled) {
      aggs.set(v.id, {
        validator: v,
        findings: [],
        unitsEvaluated: 0,
        unitsApplicable: 0,
        sawFail: false,
        sawUncertain: false,
        sawApplicable: false,
        error: null,
      });
    }

    for (const [kind, validatorsForKind] of groupByUnit(enabled)) {
      const kindUnits = unitsByKind.get(kind) ?? [];
      if (kindUnits.length === 0) continue;

      const requests = kindUnits.map((unit) => ({
        state: unit.state,
        questions: Object.fromEntries(
          validatorsForKind.map((v, idx) => [
            `v_${idx}`,
            {
              type: "choice" as const,
              instructions: `${v.body}\n\nDecide for the code in \`hunk\`/\`file_diff\`/\`body\` only.`,
              criteria: { violation: v.violation, compliant: v.compliant, not_applicable: v.notApplicable },
            },
          ]),
        ),
      }));

      // services.decide.evaluate chunks any request over 64 questions internally.
      const responses = await services.decide.evaluate(requests);

      for (let ui = 0; ui < kindUnits.length; ui++) {
        const unit = kindUnits[ui];
        const res = responses[ui];
        for (let vi = 0; vi < validatorsForKind.length; vi++) {
          const v = validatorsForKind[vi];
          const agg = aggs.get(v.id)!;
          agg.unitsEvaluated++;
          if ("error" in res) {
            agg.error = res.error;
            continue;
          }
          const answer = res.answers[`v_${vi}`];
          if (!answer || answer.type !== "choice") continue;
          const p = answer.probabilities.violation ?? 0;
          let status: "fail" | "uncertain" | "na" | "pass";
          if (answer.choice === "not_applicable") status = "na";
          else if (p >= v.threshold) status = "fail";
          else if (p >= 0.5) status = "uncertain";
          else status = "pass";

          if (status !== "na") {
            agg.unitsApplicable++;
            agg.sawApplicable = true;
          }
          if (status === "fail") agg.sawFail = true;
          if (status === "uncertain") agg.sawUncertain = true;
          if (status === "fail" || status === "uncertain") {
            const unitKey = unit.key;
            agg.findings.push({
              unitKey,
              path: unit.path,
              startLine: unit.startLine,
              endLine: unit.endLine,
              probability: p,
              status,
              dismissed: dismissed.has(`${v.id}::${unitKey}`),
              excerpt: unit.excerpt,
            });
          }
        }
      }
    }

    const results: ValidatorResult[] = [];
    for (const v of enabled) {
      const agg = aggs.get(v.id)!;
      if (agg.error) {
        results.push({
          validatorId: v.id,
          title: v.title,
          severity: v.severity,
          status: "error",
          unitsEvaluated: agg.unitsEvaluated,
          unitsApplicable: agg.unitsApplicable,
          findings: [],
          error: agg.error,
        });
        continue;
      }
      agg.findings.sort((a, b) => b.probability - a.probability);
      const status: ValidatorResult["status"] = agg.sawFail
        ? "fail"
        : agg.sawUncertain
          ? "uncertain"
          : agg.sawApplicable
            ? "pass"
            : "na";
      results.push({
        validatorId: v.id,
        title: v.title,
        severity: v.severity,
        status,
        unitsEvaluated: agg.unitsEvaluated,
        unitsApplicable: agg.unitsApplicable,
        findings: agg.findings,
        error: null,
      });
    }
    return results;
  }

  async function setEnabled(repo: string, validatorId: string, enabled: boolean): Promise<void> {
    const state = readEnabledState(repo);
    state[validatorId] = enabled;
    writeEnabledState(repo, state);
  }

  async function dismiss(repo: string, number: number, validatorId: string, unitKey: string): Promise<void> {
    dismissFinding(repo, number, validatorId, unitKey);
  }

  async function save(repo: string, target: "repo" | "personal", fileName: string, markdown: string): Promise<void> {
    const safeName = fileName.toLowerCase().endsWith(".md") ? fileName : `${fileName}.md`;
    if (target === "personal") {
      writeFileSync(path.join(dataDir("validators"), safeName), markdown, "utf8");
      return;
    }
    const repoInfo = await services.github.findRepo(repo);
    if (!repoInfo) throw new Error(`Unknown repo: ${repo}`);
    const dir = path.join(repoInfo.rootPath, ".paseo", "validators");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, safeName), markdown, "utf8");
  }

  return { loadValidators, parseValidator, evaluate, setEnabled, dismiss, save };
}

export function registerValidatorHandlers(server: PluginServerContext): void {
  handle(server, validatorsListRpc, async ({ repo }) => {
    const repoInfo = await services.github.findRepo(repo).catch(() => null);
    const { validators, errors } = await services.validators.loadValidators(
      repo,
      repoInfo ? { cwd: repoInfo.rootPath } : undefined,
    );
    return { validators, errors };
  });

  handle(server, validatorsToggleRpc, async ({ repo, validatorId, enabled }) => {
    await services.validators.setEnabled(repo, validatorId, enabled);
    return { ok: true, message: null };
  });

  handle(server, validatorsTestRpc, async ({ repo, number, markdown }) => {
    const validator = services.validators.parseValidator(markdown, "personal", "(draft)");
    const units = await services.analysis.buildPrUnits(repo, number);
    const results = await services.validators.evaluate({ validators: [validator], units, repo, number });
    const result: ValidatorResult = results[0] ?? {
      validatorId: validator.id,
      title: validator.title,
      severity: validator.severity,
      status: "na",
      unitsEvaluated: 0,
      unitsApplicable: 0,
      findings: [],
      error: null,
    };
    return { result };
  });

  handle(server, validatorsDismissRpc, async ({ repo, number, validatorId, unitKey }) => {
    await services.validators.dismiss(repo, number, validatorId, unitKey);
    return { ok: true, message: null };
  });

  handle(server, validatorsSaveRpc, async ({ repo, target, fileName, markdown }) => {
    try {
      await services.validators.save(repo, target, fileName, markdown);
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: errMessage(error) };
    }
  });

  handle(server, localValidateRpc, async ({ cwd, baseRef }) => {
    const jobId = startJob(
      "local-validate",
      async () => {
        const { validators } = await services.validators.loadValidators("", { cwd });
        const units = await services.analysis.buildLocalUnits(cwd, baseRef);
        const results = await services.validators.evaluate({ validators, units, repo: "" });
        latestLocalResults.set(cwd, results);
        return { results };
      },
      `local-validate:${cwd}`,
    );
    return { jobId };
  });
}
