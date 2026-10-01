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
import { getSettings } from "../core/settings";
import { services, type ValidationUnit, type ValidatorService } from "../core/services";
import { parseGithubSlug } from "../github/gh";
import { parseValidatorMarkdown, unusableReason } from "./parse";
import { STARTER_VALIDATORS } from "./starter";
import { dismissFinding, readDismissals, readEnabledState, writeEnabledState } from "./store";

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadStarterValidators(): { validators: Validator[]; errors: string[] } {
  const validators: Validator[] = [];
  const errors: string[] = [];
  for (const s of STARTER_VALIDATORS) {
    const name = `${s.name}.md`;
    const reason = unusableReason(s.markdown);
    if (reason) {
      errors.push(`starter validator ${name}: ${reason}`);
      continue;
    }
    validators.push(parseValidatorMarkdown(s.markdown, "starter", name));
  }
  return { validators, errors };
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
      const reason = unusableReason(markdown);
      if (reason) {
        errors.push(`personal validator ${name}: ${reason}`);
        continue;
      }
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
          const reason = unusableReason(show.stdout);
          if (reason) {
            errors.push(`repo validator ${p}: ${reason}`);
            continue;
          }
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
          const reason = unusableReason(markdown);
          if (reason) {
            errors.push(`repo validator ${name}: ${reason}`);
            continue;
          }
          validators.push(parseValidatorMarkdown(markdown, "repo", `.paseo/validators/${name}`));
        } catch (error) {
          errors.push(`repo validator ${name}: ${errMessage(error)}`);
        }
      }
    }
  }
  return { validators, errors };
}

/**
 * Resolves a local working directory to a registered repo slug, for `localValidateRpc` (which
 * only receives a `cwd`, not a repo). Tries an exact/ancestor match against Paseo projects'
 * `rootPath` first, then falls back to parsing the directory's own `origin` remote. Returns
 * null when neither resolves to a known repo.
 */
async function resolveRepoForCwd(cwd: string): Promise<string | null> {
  const normalizedCwd = path.resolve(cwd);
  try {
    const { repos } = await services.github.listRepos();
    const match = repos.find((r) => {
      const root = path.resolve(r.rootPath);
      return normalizedCwd === root || normalizedCwd.startsWith(root + path.sep);
    });
    if (match) return match.slug;
  } catch {
    // fall through to a direct git-remote lookup
  }
  try {
    const result = await run("git", ["-C", cwd, "remote", "get-url", "origin"], {
      timeoutMs: 5_000,
      allowFailure: true,
    });
    if (result.code === 0 && result.stdout.trim()) {
      const slug = parseGithubSlug(result.stdout.trim());
      if (slug) {
        const fullSlug = `${slug.owner}/${slug.name}`;
        const repoInfo = await services.github.findRepo(fullSlug);
        if (repoInfo) return repoInfo.slug;
      }
    }
  } catch {
    // unresolved
  }
  return null;
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
    errors.push(...starter.errors);
    const personal = loadPersonalValidators();
    errors.push(...personal.errors);
    const repoResult = await loadRepoValidators(options);
    errors.push(...repoResult.errors);

    const all = [...starter.validators, ...personal.validators, ...repoResult.validators];
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

    // Dismissed/disabled state is applied uniformly by `applyState` on every read (fresh here,
    // or from a cached Analysis) -- this function only produces the raw, as-evaluated result.

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
      /** Count of units whose request failed outright (network/timeout/4xx/5xx/size limits). */
      erroredUnits: number;
      lastError: string | null;
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
        erroredUnits: 0,
        lastError: null,
      });
    }

    // Different unit kinds (hunk/file/pr) are independent requests sharing nothing, so they run
    // concurrently rather than being awaited one kind at a time.
    const kindGroups = [...groupByUnit(enabled)].filter(([kind]) => (unitsByKind.get(kind) ?? []).length > 0);
    await Promise.all(
      kindGroups.map(async ([kind, validatorsForKind]) => {
        const kindUnits = unitsByKind.get(kind) ?? [];

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
              agg.erroredUnits++;
              agg.lastError = res.error;
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
                dismissed: false,
                excerpt: unit.excerpt,
              });
            }
          }
        }
      }),
    );

    const results: ValidatorResult[] = [];
    for (const v of enabled) {
      const agg = aggs.get(v.id)!;
      const succeededUnits = agg.unitsEvaluated - agg.erroredUnits;
      // Only report the validator itself as "error" when NOTHING succeeded -- a handful of
      // failed units (an oversized hunk, a transient timeout) among many healthy ones must not
      // discard real findings the other units already found.
      if (agg.erroredUnits > 0 && succeededUnits === 0) {
        results.push({
          validatorId: v.id,
          title: v.title,
          severity: v.severity,
          status: "error",
          unitsEvaluated: agg.unitsEvaluated,
          unitsApplicable: agg.unitsApplicable,
          findings: [],
          error: agg.lastError,
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
      const error =
        agg.erroredUnits > 0 ? `partial: ${agg.erroredUnits}/${agg.unitsEvaluated} units failed: ${agg.lastError}` : null;
      results.push({
        validatorId: v.id,
        title: v.title,
        severity: v.severity,
        status,
        unitsEvaluated: agg.unitsEvaluated,
        unitsApplicable: agg.unitsApplicable,
        findings: agg.findings,
        error,
      });
    }
    return results;
  }

  /**
   * Re-applies the current enabled/dismissed state to already-evaluated results, without
   * calling the decision API again: drops validators the user has since disabled, flags
   * findings the user has dismissed, and recomputes each validator's status from only its
   * non-dismissed findings (so a validator whose every failing finding is dismissed reads as
   * "pass"/"na" again instead of permanently "fail").
   */
  function applyState(repo: string, number: number, results: ValidatorResult[]): ValidatorResult[] {
    const enabledOverrides = repo ? readEnabledState(repo) : {};
    const dismissed = repo ? readDismissals(repo, number) : new Set<string>();

    const applied: ValidatorResult[] = [];
    for (const r of results) {
      if (enabledOverrides[r.validatorId] === false) continue;
      if (r.status === "error") {
        applied.push(r);
        continue;
      }

      let sawFail = false;
      let sawUncertain = false;
      const findings = r.findings.map((f) => {
        const isDismissed = dismissed.has(`${r.validatorId}::${f.unitKey}`);
        if (!isDismissed) {
          if (f.status === "fail") sawFail = true;
          else if (f.status === "uncertain") sawUncertain = true;
        }
        return f.dismissed === isDismissed ? f : { ...f, dismissed: isDismissed };
      });
      const sawApplicable = r.unitsApplicable > 0;
      const status: ValidatorResult["status"] = sawFail ? "fail" : sawUncertain ? "uncertain" : sawApplicable ? "pass" : "na";
      applied.push(status === r.status ? { ...r, findings } : { ...r, findings, status });
    }
    return applied;
  }

  async function setEnabled(repo: string, validatorId: string, enabled: boolean): Promise<void> {
    const state = readEnabledState(repo);
    state[validatorId] = enabled;
    writeEnabledState(repo, state);
  }

  async function dismiss(repo: string, number: number, validatorId: string, unitKey: string): Promise<void> {
    dismissFinding(repo, number, validatorId, unitKey);
  }

  /**
   * Resolves `dir`/`fileName` and throws unless the result is a direct child of `dir` with no
   * directory components. `shared/rpc.ts` already restricts `fileName` to a safe bare-name
   * pattern at the RPC boundary; this is defense in depth for any other caller (tests, future
   * internal callers) that invokes `save` directly.
   */
  function resolveValidatorPath(dir: string, fileName: string): string {
    const base = path.basename(fileName);
    if (!base || base !== fileName || base.startsWith(".")) {
      throw new Error(`Invalid validator file name: ${fileName}`);
    }
    const safeName = base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
    const resolvedDir = path.resolve(dir);
    const dest = path.resolve(dir, safeName);
    if (path.dirname(dest) !== resolvedDir) {
      throw new Error(`Invalid validator file name: ${fileName}`);
    }
    return dest;
  }

  async function save(repo: string, target: "repo" | "personal", fileName: string, markdown: string): Promise<void> {
    if (target === "personal") {
      const dest = resolveValidatorPath(dataDir("validators"), fileName);
      writeFileSync(dest, markdown, "utf8");
      return;
    }
    const repoInfo = await services.github.findRepo(repo);
    if (!repoInfo) throw new Error(`Unknown repo: ${repo}`);
    const dir = path.join(repoInfo.rootPath, ".paseo", "validators");
    mkdirSync(dir, { recursive: true });
    const dest = resolveValidatorPath(dir, fileName);
    writeFileSync(dest, markdown, "utf8");
  }

  return { loadValidators, parseValidator, evaluate, applyState, setEnabled, dismiss, save };
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
    const jobId = startJob(
      "validator-test",
      async () => {
        const settings = await getSettings();
        if (!settings.decisionRepos.includes(repo)) {
          throw new Error(
            `Decision API is off for ${repo}. Enable it in Settings → PR Review before testing validators.`,
          );
        }
        const validator = services.validators.parseValidator(markdown, "personal", "(draft)");
        const units = await services.analysis.buildPrUnits(repo, number);
        const raw = await services.validators.evaluate({ validators: [validator], units, repo, number });
        const applied = services.validators.applyState(repo, number, raw);
        const result: ValidatorResult = applied[0] ?? {
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
      },
      `validator-test:${repo}#${number}`,
    );
    return { jobId };
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
        const repo = await resolveRepoForCwd(cwd);
        const settings = await getSettings();
        if (!repo || !settings.decisionRepos.includes(repo)) {
          const results: ValidatorResult[] = [];
          latestLocalResults.set(cwd, results);
          return {
            results,
            notice: repo
              ? `Decision API is off for ${repo}. Enable it in Settings → PR Review.`
              : `Could not determine which registered repo ${cwd} belongs to, so the decision API was not used.`,
          };
        }
        const { validators } = await services.validators.loadValidators(repo, { cwd });
        const units = await services.analysis.buildLocalUnits(cwd, baseRef);
        const results = await services.validators.evaluate({ validators, units, repo });
        latestLocalResults.set(cwd, results);
        return { results };
      },
      `local-validate:${cwd}`,
    );
    return { jobId };
  });
}
