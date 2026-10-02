import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { agentChoicesRpc, precomputeStatusRpc, reposListRpc } from "../../shared/rpc";
import {
  DEFAULT_DECISION_MODELS,
  prReviewSettings,
  PrReviewSettingsSchema,
  type DecisionProvider,
  type DepthRule,
  type PrReviewSettings,
} from "../../shared/settings";
import { DETAIL_LEVELS, DETAIL_LEVEL_LABELS } from "../../shared/levels";
import { agoLabel } from "../ui/time";
import { font, space, surfaces } from "../ui/tokens";

const PROVIDER_OPTIONS = [
  { label: "OpenRouter (System One · Jev)", value: "openrouter" as const },
  { label: "Cloudflare Workers AI (Clef)", value: "cloudflare" as const },
  { label: "TypeSafe Jev", value: "jev" as const },
  { label: "Custom endpoint", value: "custom" as const },
];

const API_KEY_HINTS: Record<DecisionProvider, string> = {
  openrouter: "Your OpenRouter key. Or set OPENROUTER_API_KEY on the daemon host.",
  cloudflare: "A Cloudflare API token. Or set CLOUDFLARE_API_TOKEN on the daemon host.",
  jev: "Your TypeSafe key. Or set TYPESAFE_API_KEY on the daemon host.",
  custom: "Optional for self-hosted endpoints. Or set SYSTEMONE_API_KEY on the daemon host.",
};

const READING_ORDER_OPTIONS = [
  { label: "Foundations first", value: "foundations" as const },
  { label: "Riskiest first", value: "risk" as const },
  { label: "Chronological", value: "chrono" as const },
];

const DIFF_LAYOUT_OPTIONS = [
  { label: "Inline", value: "inline" as const },
  { label: "Split (side by side)", value: "split" as const },
];

const DIFF_DENSITY_OPTIONS = [
  { label: "Comfortable", value: "comfortable" as const },
  { label: "Compact", value: "compact" as const },
];

/** Inserted by "Add starter rules" (only offered while the list is empty). */
const STARTER_DEPTH_RULES: DepthRule[] = [
  { when: "Touches authentication, authorization, payments, secrets, or data migrations", level: "code", enabled: true },
  { when: "Changes concurrency, caching, retries, or error handling in core logic", level: "code", enabled: true },
  { when: "Only adds or reshapes types, interfaces, or API signatures", level: "declarations", enabled: true },
  { when: "Only tests, fixtures, snapshots, generated code, or documentation", level: "files", enabled: true },
];

const AGENT_TASKS: { key: keyof PrReviewSettings["agents"]; label: string; hint: string }[] = [
  { key: "summary", label: "Summary", hint: "PR and module summaries on Overview." },
  { key: "chat", label: "Chat", hint: "The chat side panel." },
  { key: "explain", label: "Explain", hint: "The Explain button on findings and conversations." },
  { key: "visual", label: "Visual overview", hint: "The diagram on the Visual tab." },
  { key: "describe", label: "PR description", hint: "Describe PR (rich HTML) on Overview." },
];

// Text inputs save on a pause in typing, not on every keystroke.
const SAVE_DEBOUNCE_MS = 500;

/**
 * Buffers edits locally and commits them against the freshest known revision, instead of the
 * revision captured by whichever render created the `onChangeText`/`onValueChange` closure.
 *
 * `SettingsInput` is uncontrolled (`initialValue` + `onChangeText`, no `value` prop) precisely
 * so callers can do this: accumulate edits in `stateRef` (a ref, always current) and send them
 * debounced + serialized through one promise chain, so two saves never race on the same stale
 * revision. A save rejected for a stale revision (`save` returns `false` and never throws) is
 * retried once after a `reload()`; if that also fails, the field shows an error instead of
 * silently losing the edit.
 */
function useSettingsCommitter(settings: SettingsState<typeof PrReviewSettingsSchema>) {
  // True while a local edit hasn't been confirmed saved yet — gates re-syncing `stateRef` from
  // the hook's own `values`/`revision`, so an in-flight edit is never clobbered by a render that
  // just hasn't caught up yet.
  const pendingRef = useRef(false);
  const stateRef = useRef<{ values: PrReviewSettings; revision: string } | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  // `stateRef` is mutated directly (see `schedule`) so two edits never fight over a stale
  // closure, but a ref write alone doesn't re-render. Most fields don't care (SettingsInput is
  // uncontrolled, so it keeps its own buffer regardless) — but the review-depth rule rows are
  // controlled, so the row showing rule N must repaint with rule N's current text right after a
  // reorder. This tick forces that repaint after every `schedule()` call.
  const [, bump] = useReducer((n: number) => n + 1, 0);

  if (settings.status === "ready" && !pendingRef.current) {
    stateRef.current = { values: settings.values, revision: settings.revision };
  }

  useEffect(
    () => () => {
      for (const timer of Object.values(timersRef.current)) clearTimeout(timer);
    },
    [],
  );

  async function sendNow(key: string) {
    const snapshot = stateRef.current;
    if (!snapshot) {
      pendingRef.current = false;
      return;
    }
    let ok = await settings.save(snapshot.values, snapshot.revision);
    if (!ok) {
      // Stale revision (e.g. a concurrent edit elsewhere landed first). Reload to learn the
      // real one, then retry exactly once with our still-buffered edit layered on top.
      pendingRef.current = false;
      await settings.reload();
      await Promise.resolve();
      const fresh = stateRef.current;
      ok = fresh ? await settings.save(fresh.values, fresh.revision) : false;
    }
    pendingRef.current = false;
    setErrors((prev) => ({ ...prev, [key]: ok ? null : "Could not save this change. Try again." }));
  }

  function enqueue(key: string) {
    // Serialize: never start a save before the previous one (any field) has settled.
    chainRef.current = chainRef.current.then(() => sendNow(key));
  }

  /** Applies `mutate` to the working copy immediately; sends after `debounceMs` of inactivity. */
  function schedule(key: string, mutate: (values: PrReviewSettings) => PrReviewSettings, debounceMs: number) {
    if (!stateRef.current) return;
    pendingRef.current = true;
    stateRef.current = { ...stateRef.current, values: mutate(stateRef.current.values) };
    setErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev));
    bump();
    clearTimeout(timersRef.current[key]);
    timersRef.current[key] = setTimeout(() => enqueue(key), debounceMs);
  }

  /** Applies + sends right away (still serialized/retried like everything else) — switches, selects. */
  function commit(key: string, mutate: (values: PrReviewSettings) => PrReviewSettings) {
    schedule(key, mutate, 0);
  }

  function setValidationError(key: string, message: string | null) {
    setErrors((prev) => ({ ...prev, [key]: message }));
  }

  return { schedule, commit, setValidationError, errors, working: stateRef.current?.values ?? null };
}

/** A numeric `SettingsInput` that validates on every keystroke and only commits valid values. */
function NumberSettingsInput({
  fieldKey,
  label,
  hint,
  value,
  min,
  max,
  error,
  disabled,
  onValid,
  onError,
}: {
  fieldKey: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  error: string | null;
  disabled?: boolean;
  onValid(n: number): void;
  onError(message: string | null): void;
}) {
  return (
    <SettingsInput
      key={fieldKey}
      label={label}
      hint={hint}
      error={error}
      initialValue={String(value)}
      onChangeText={(text) => {
        const n = Math.round(Number(text));
        if (!Number.isFinite(n) || n < min || n > max) {
          onError(`Enter a whole number between ${min} and ${max}.`);
          return;
        }
        onError(null);
        onValid(n);
      }}
      disabled={disabled}
    />
  );
}

/**
 * Ordered list of review-depth rules, one card row per rule. Each row is fully controlled (not the
 * usual `SettingsInput` uncontrolled pattern) because reordering swaps content across rows by
 * index — an uncontrolled input would keep showing its own stale text after a move.
 * `useSettingsCommitter`'s `bump()` (see above) repaints this list right after every edit, so the
 * controlled values never lag.
 */
function ReviewDepthRules({
  theme,
  rules,
  onChangeWhen,
  onChangeLevel,
  onToggleEnabled,
  onMove,
  onDelete,
  onAdd,
  onAddStarters,
}: {
  theme: PluginSurfaceProps["theme"];
  rules: DepthRule[];
  onChangeWhen(index: number, when: string): void;
  onChangeLevel(index: number, level: DepthRule["level"]): void;
  onToggleEnabled(index: number, enabled: boolean): void;
  onMove(index: number, direction: -1 | 1): void;
  onDelete(index: number): void;
  onAdd(): void;
  onAddStarters(): void;
}) {
  const c = theme.colors;
  const s = surfaces(c);

  if (rules.length === 0) {
    return (
      <SettingsCard>
        <SettingsRow label="No rules yet" hint="Every module opens at the built-in default depth. Start from a few examples, or write your own.">
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Pressable accessibilityRole="button" onPress={onAdd} style={s.buttonQuiet}>
              <Text style={s.buttonQuietText}>Add rule</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onAddStarters} style={s.button}>
              <Text style={s.buttonText}>Add starter rules</Text>
            </Pressable>
          </View>
        </SettingsRow>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard>
      {rules.map((rule, index) => (
        <View key={index} style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Text style={{ ...font.caption, color: c.foregroundMuted, flex: 1 }}>Rule {index + 1}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Move rule up"
              disabled={index === 0}
              onPress={() => onMove(index, -1)}
              style={{ opacity: index === 0 ? 0.35 : 1, padding: 4 }}
            >
              <Icon name="ArrowUp" size={14} color={c.foregroundMuted} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Move rule down"
              disabled={index === rules.length - 1}
              onPress={() => onMove(index, 1)}
              style={{ opacity: index === rules.length - 1 ? 0.35 : 1, padding: 4 }}
            >
              <Icon name="ArrowDown" size={14} color={c.foregroundMuted} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Delete rule" onPress={() => onDelete(index)} style={{ padding: 4 }}>
              <Icon name="Trash2" size={14} color={c.statusDanger} />
            </Pressable>
          </View>
          <TextInput
            value={rule.when}
            onChangeText={(when) => onChangeWhen(index, when)}
            multiline
            placeholder="e.g. Touches authentication, authorization, payments, secrets, or data migrations"
            style={{ ...s.input, minHeight: 60, opacity: rule.enabled ? 1 : 0.6 }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xs, opacity: rule.enabled ? 1 : 0.6 }}>
              <Text style={{ ...font.small, color: c.foregroundMuted, marginRight: space.xs }}>Opens at</Text>
              {DETAIL_LEVELS.map((level) => {
                const active = rule.level === level;
                return (
                  <Pressable
                    key={level}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    onPress={() => onChangeLevel(index, level)}
                    style={s.pill(active)}
                  >
                    <Text style={s.pillText(active)}>{DETAIL_LEVEL_LABELS[level]}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <Text style={{ ...font.small, color: c.foregroundMuted }}>Enabled</Text>
              <Switch value={rule.enabled} onValueChange={(enabled) => onToggleEnabled(index, enabled)} />
            </View>
          </View>
        </View>
      ))}
      <View key="add" style={{ paddingHorizontal: space.lg, paddingVertical: space.md, alignItems: "flex-start" }}>
        <Pressable accessibilityRole="button" onPress={onAdd} style={s.buttonQuiet}>
          <Text style={s.buttonQuietText}>Add rule</Text>
        </Pressable>
      </View>
    </SettingsCard>
  );
}

export function SettingsScreen(props: PluginSurfaceProps): ReactNode {
  const { theme } = props;
  const c = theme.colors;
  const settings = useSettings(prReviewSettings);
  const reposRpc = useRpc(reposListRpc);
  const agentChoicesRpcFn = useRpc(agentChoicesRpc);
  const precomputeStatusRpcFn = useRpc(precomputeStatusRpc);
  const repos = useQuery({ queryKey: ["prr.settings.repos"], queryFn: () => reposRpc({}), staleTime: 60_000 });
  const agentChoices = useQuery({ queryKey: ["prr.settings.agentChoices"], queryFn: () => agentChoicesRpcFn({}), staleTime: 60_000 });
  const precomputeStatus = useQuery({
    queryKey: ["prr.settings.precomputeStatus"],
    queryFn: () => precomputeStatusRpcFn({}),
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
  const committer = useSettingsCommitter(settings);

  const agentOptions = useMemo(() => {
    const choices = agentChoices.data?.choices ?? [];
    return [{ label: "First available", value: "" }, ...choices.map((choice) => ({ label: choice.label, value: choice.id }))];
  }, [agentChoices.data]);

  let content: ReactNode;

  if (settings.status === "loading") {
    content = (
      <SettingsCard>
        <SettingsRow label="Loading settings…" />
      </SettingsCard>
    );
  } else if (settings.status === "error") {
    content = (
      <SettingsCard>
        <SettingsAction
          label="Could not load settings"
          error={settings.error}
          actionLabel="Reload"
          onPress={() => void settings.reload()}
          disabled={settings.saving}
        />
      </SettingsCard>
    );
  } else if (settings.status === "invalid") {
    content = (
      <SettingsCard>
        <SettingsAction
          label="Stored settings are invalid"
          hint="Reset to defaults to continue. This discards the stored settings document."
          error={settings.error}
          actionLabel="Reset"
          onPress={() => void settings.reset()}
          disabled={settings.saving}
        />
      </SettingsCard>
    );
  } else {
    const values = committer.working ?? settings.values;
    const repoList = repos.data?.repos ?? [];
    const errors = committer.errors;
    const provider = values.decision.provider;
    const background = values.precompute;
    const rulesWithoutRepos = values.reviewDepth.rules.some((rule) => rule.enabled) && values.decisionRepos.length === 0;

    let backgroundStatus = "Loading…";
    if (precomputeStatus.isError) backgroundStatus = "Could not load status.";
    if (precomputeStatus.data) {
      const status = precomputeStatus.data;
      const parts = [status.lastRunAt ? `Last run ${agoLabel(status.lastRunAt)}` : "Not run yet", `${status.queued} queued`];
      if (background.agentSummaries) parts.push(`${status.agentJobsToday} of ${background.maxAgentJobsPerDay} agent summaries today`);
      backgroundStatus = parts.join(" · ");
    }

    content = (
      <>
        {settings.saveError && (
          <View style={{ marginBottom: space.xl }}>
            <SettingsCard>
              <SettingsRow label="Could not save settings" error={settings.saveError} />
            </SettingsCard>
          </View>
        )}

        <SettingsGroup title="Reviewing" info="Defaults for every PR. Reading order and diff layout can also be switched from the PR screen.">
          <SettingsCard>
            <SettingsSelect
              label="Reading order"
              hint="How files are ordered within each module."
              value={values.readingOrder}
              options={READING_ORDER_OPTIONS}
              onValueChange={(readingOrder) => committer.commit("readingOrder", (v) => ({ ...v, readingOrder }))}
            />
            <SettingsSelect
              label="Diff layout"
              value={values.diffLayout}
              options={DIFF_LAYOUT_OPTIONS}
              onValueChange={(diffLayout) => committer.commit("diffLayout", (v) => ({ ...v, diffLayout }))}
            />
            <SettingsSelect
              label="Code density"
              hint="Text size and row height in diffs."
              value={values.diffDensity}
              options={DIFF_DENSITY_OPTIONS}
              onValueChange={(diffDensity) => committer.commit("diffDensity", (v) => ({ ...v, diffDensity }))}
            />
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup
          title="Review depth"
          info={
            "Each rule is a plain-language condition the decision model checks against every module. Matching " +
            "modules open at that depth; when several match, the deepest one wins. With no rules — or for repos " +
            "not allowed to send code under Decision model — PR Review falls back to its built-in default: noise " +
            "modules open at Files, high-risk modules at Code, large modules with declaration outlines at " +
            "Declarations, and everything else at Code."
          }
        >
          <ReviewDepthRules
            theme={theme}
            rules={values.reviewDepth.rules}
            onChangeWhen={(index, when) =>
              committer.schedule(
                `reviewDepth.rules.${index}.when`,
                (v) => ({ ...v, reviewDepth: { rules: v.reviewDepth.rules.map((r, i) => (i === index ? { ...r, when } : r)) } }),
                SAVE_DEBOUNCE_MS,
              )
            }
            onChangeLevel={(index, level) =>
              committer.commit("reviewDepth.rules", (v) => ({
                ...v,
                reviewDepth: { rules: v.reviewDepth.rules.map((r, i) => (i === index ? { ...r, level } : r)) },
              }))
            }
            onToggleEnabled={(index, enabled) =>
              committer.commit("reviewDepth.rules", (v) => ({
                ...v,
                reviewDepth: { rules: v.reviewDepth.rules.map((r, i) => (i === index ? { ...r, enabled } : r)) },
              }))
            }
            onMove={(index, direction) =>
              committer.commit("reviewDepth.rules", (v) => {
                const rules = [...v.reviewDepth.rules];
                const target = index + direction;
                if (target < 0 || target >= rules.length) return v;
                [rules[index], rules[target]] = [rules[target], rules[index]];
                return { ...v, reviewDepth: { rules } };
              })
            }
            onDelete={(index) =>
              committer.commit("reviewDepth.rules", (v) => ({
                ...v,
                reviewDepth: { rules: v.reviewDepth.rules.filter((_, i) => i !== index) },
              }))
            }
            onAdd={() =>
              committer.commit("reviewDepth.rules", (v) => ({
                ...v,
                reviewDepth: { rules: [...v.reviewDepth.rules, { when: "", level: "code" as const, enabled: true }] },
              }))
            }
            onAddStarters={() =>
              committer.commit("reviewDepth.rules", (v) => ({ ...v, reviewDepth: { rules: STARTER_DEPTH_RULES } }))
            }
          />
          {rulesWithoutRepos && (
            <Text style={{ ...font.small, color: c.foregroundMuted, marginTop: space.sm, marginLeft: space.xs }}>
              Rules only apply to repos allowed to send code under Decision model, and none are allowed yet.
            </Text>
          )}
        </SettingsGroup>

        <SettingsGroup
          title="Decision model"
          info="Answers typed questions for validators, module assignment, risk and severity scoring, attention ranking, and review depth. Code is only sent for the repos you allow."
        >
          <SettingsSection title="Connection">
            <SettingsCard>
              <SettingsSelect
                key="provider"
                label="Provider"
                value={provider}
                options={PROVIDER_OPTIONS}
                onValueChange={(next) => committer.commit("decision.provider", (v) => ({ ...v, decision: { ...v.decision, provider: next } }))}
              />
              <SettingsInput
                key="apiKey"
                label={provider === "cloudflare" ? "API token" : "API key"}
                hint={API_KEY_HINTS[provider]}
                error={errors["decision.apiKey"] ?? null}
                initialValue={values.decision.apiKey}
                onChangeText={(apiKey) => committer.schedule("decision.apiKey", (v) => ({ ...v, decision: { ...v.decision, apiKey } }), SAVE_DEBOUNCE_MS)}
                secureTextEntry
              />
              <SettingsInput
                key="model"
                label="Model"
                hint={`Leave empty to use ${DEFAULT_DECISION_MODELS[provider]}.`}
                error={errors["decision.model"] ?? null}
                initialValue={values.decision.model}
                onChangeText={(model) => committer.schedule("decision.model", (v) => ({ ...v, decision: { ...v.decision, model } }), SAVE_DEBOUNCE_MS)}
              />
              {provider === "cloudflare" && (
                <SettingsInput
                  key="cloudflareAccountId"
                  label="Cloudflare account ID"
                  hint="Or set CLOUDFLARE_ACCOUNT_ID on the daemon host. Not needed with an endpoint URL override."
                  error={errors["decision.cloudflareAccountId"] ?? null}
                  initialValue={values.decision.cloudflareAccountId}
                  onChangeText={(cloudflareAccountId) =>
                    committer.schedule("decision.cloudflareAccountId", (v) => ({ ...v, decision: { ...v.decision, cloudflareAccountId } }), SAVE_DEBOUNCE_MS)
                  }
                />
              )}
              {provider === "custom" && (
                <SettingsInput
                  key="endpointUrl"
                  label="Endpoint URL"
                  hint="Any System One–compatible decision API."
                  error={errors["decision.endpointUrl"] ?? null}
                  initialValue={values.decision.endpointUrl}
                  onChangeText={(endpointUrl) =>
                    committer.schedule("decision.endpointUrl", (v) => ({ ...v, decision: { ...v.decision, endpointUrl } }), SAVE_DEBOUNCE_MS)
                  }
                />
              )}
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            title="Repos allowed to send code"
            info="Off by default. For repos left off, analysis uses heuristics only, review-depth rules don't apply, and validators are unavailable."
          >
            <SettingsCard>
              {repos.isPending && <SettingsRow label="Loading repos…" />}
              {repos.isError && <SettingsRow label="Could not load repos" />}
              {repos.isSuccess && repoList.length === 0 && (
                <SettingsRow label="No repos yet" hint="Add a repo as a Paseo project with a github.com remote to see it here." />
              )}
              {repoList.map((repo) => (
                <SettingsSwitch
                  key={repo.slug}
                  label={repo.slug}
                  value={values.decisionRepos.includes(repo.slug)}
                  onValueChange={(enabled) =>
                    committer.commit(`decisionRepos.${repo.slug}`, (v) => ({
                      ...v,
                      decisionRepos: enabled ? [...v.decisionRepos, repo.slug] : v.decisionRepos.filter((slug) => slug !== repo.slug),
                    }))
                  }
                />
              ))}
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Advanced">
            <SettingsCard>
              {provider !== "custom" && (
                <SettingsInput
                  key="endpointUrl"
                  label="Endpoint URL override"
                  hint="Replaces the provider's URL, e.g. a self-hosted Jev-compatible API or a Cloudflare AI Gateway."
                  error={errors["decision.endpointUrl"] ?? null}
                  initialValue={values.decision.endpointUrl}
                  onChangeText={(endpointUrl) =>
                    committer.schedule("decision.endpointUrl", (v) => ({ ...v, decision: { ...v.decision, endpointUrl } }), SAVE_DEBOUNCE_MS)
                  }
                />
              )}
              <NumberSettingsInput
                key="concurrency"
                fieldKey="decision.concurrency"
                label="Parallel requests"
                hint="How many decision requests run at once (1–32)."
                value={values.decision.concurrency}
                min={1}
                max={32}
                error={errors["decision.concurrency"] ?? null}
                onError={(message) => committer.setValidationError("decision.concurrency", message)}
                onValid={(concurrency) =>
                  committer.schedule("decision.concurrency", (v) => ({ ...v, decision: { ...v.decision, concurrency } }), SAVE_DEBOUNCE_MS)
                }
              />
            </SettingsCard>
          </SettingsSection>
        </SettingsGroup>

        <SettingsGroup
          title="Agents"
          info="Which agent profile or model each task uses. First available = your first saved agent profile, otherwise the first ready model."
        >
          <SettingsCard>
            {agentChoices.isPending && <SettingsRow label="Loading agents…" />}
            {agentChoices.isError && <SettingsRow label="Could not load agents" hint="Only First available can be chosen until they load." />}
            {AGENT_TASKS.map((task) => (
              <SettingsSelect
                key={task.key}
                label={task.label}
                hint={task.hint}
                value={values.agents[task.key]}
                options={agentOptions}
                onValueChange={(choiceId) => committer.commit(`agents.${task.key}`, (v) => ({ ...v, agents: { ...v.agents, [task.key]: choiceId } }))}
                disabled={agentChoices.isPending}
              />
            ))}
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup title="Background analysis" info="Analyzes PRs that need your attention ahead of time, so they open instantly.">
          <SettingsCard>
            <SettingsSwitch
              key="enabled"
              label="Analyze PRs in the background"
              value={background.enabled}
              onValueChange={(enabled) => {
                if (!enabled) {
                  // The fields below unmount; don't leave their validation errors behind.
                  for (const key of ["precompute.intervalMinutes", "precompute.maxFiles", "precompute.maxAgentJobsPerDay"]) {
                    committer.setValidationError(key, null);
                  }
                }
                committer.commit("precompute.enabled", (v) => ({ ...v, precompute: { ...v.precompute, enabled } }));
              }}
            />
            {background.enabled && <SettingsRow key="status" label="Status" hint={backgroundStatus} error={precomputeStatus.data?.lastError ?? null} />}
            {background.enabled && (
              <NumberSettingsInput
                key="intervalMinutes"
                fieldKey="precompute.intervalMinutes"
                label="Check every (minutes)"
                hint="2–240 minutes."
                value={background.intervalMinutes}
                min={2}
                max={240}
                error={errors["precompute.intervalMinutes"] ?? null}
                onError={(message) => committer.setValidationError("precompute.intervalMinutes", message)}
                onValid={(intervalMinutes) =>
                  committer.schedule("precompute.intervalMinutes", (v) => ({ ...v, precompute: { ...v.precompute, intervalMinutes } }), SAVE_DEBOUNCE_MS)
                }
              />
            )}
            {background.enabled && (
              <SettingsSwitch
                key="skipDrafts"
                label="Skip draft PRs"
                value={background.skipDrafts}
                onValueChange={(skipDrafts) => committer.commit("precompute.skipDrafts", (v) => ({ ...v, precompute: { ...v.precompute, skipDrafts } }))}
              />
            )}
            {background.enabled && (
              <NumberSettingsInput
                key="maxFiles"
                fieldKey="precompute.maxFiles"
                label="Skip PRs with more files than"
                hint="10–5000 files."
                value={background.maxFiles}
                min={10}
                max={5000}
                error={errors["precompute.maxFiles"] ?? null}
                onError={(message) => committer.setValidationError("precompute.maxFiles", message)}
                onValid={(maxFiles) => committer.schedule("precompute.maxFiles", (v) => ({ ...v, precompute: { ...v.precompute, maxFiles } }), SAVE_DEBOUNCE_MS)}
              />
            )}
            {background.enabled && (
              <SettingsSwitch
                key="agentSummaries"
                label="Write agent summaries"
                hint="Also generates each PR's Overview summary with the Summary agent, up to a daily limit."
                value={background.agentSummaries}
                onValueChange={(agentSummaries) => {
                  if (!agentSummaries) committer.setValidationError("precompute.maxAgentJobsPerDay", null);
                  committer.commit("precompute.agentSummaries", (v) => ({ ...v, precompute: { ...v.precompute, agentSummaries } }));
                }}
              />
            )}
            {background.enabled && background.agentSummaries && (
              <NumberSettingsInput
                key="maxAgentJobsPerDay"
                fieldKey="precompute.maxAgentJobsPerDay"
                label="Agent summaries per day"
                hint="0–200."
                value={background.maxAgentJobsPerDay}
                min={0}
                max={200}
                error={errors["precompute.maxAgentJobsPerDay"] ?? null}
                onError={(message) => committer.setValidationError("precompute.maxAgentJobsPerDay", message)}
                onValid={(maxAgentJobsPerDay) =>
                  committer.schedule("precompute.maxAgentJobsPerDay", (v) => ({ ...v, precompute: { ...v.precompute, maxAgentJobsPerDay } }), SAVE_DEBOUNCE_MS)
                }
              />
            )}
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup title="About">
          <SettingsCard>
            <SettingsRow label="Documentation" hint="Decision model setup, the validator format, and the review experience.">
              <ExternalLink href="https://github.com/getpaseo/pr-review">pr-review on GitHub</ExternalLink>
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>

        <SettingsCard>
          <SettingsAction
            label="Reset all settings"
            hint="Restores every PR Review setting to its default, including review-depth rules, allowed repos, and the API key."
            actionLabel="Reset"
            onPress={() => void settings.reset()}
            disabled={settings.saving}
          />
        </SettingsCard>
      </>
    );
  }

  return <ScrollView contentContainerStyle={{ paddingVertical: space.lg, paddingHorizontal: space.lg }}>{content}</ScrollView>;
}
