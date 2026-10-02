import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { agentChoicesRpc, precomputeStatusRpc, reposListRpc } from "../../shared/rpc";
import { prReviewSettings, PrReviewSettingsSchema, type DepthRule, type PrReviewSettings } from "../../shared/settings";
import { DETAIL_LEVELS, DETAIL_LEVEL_LABELS } from "../../shared/levels";
import { font, space, surfaces } from "../ui/tokens";

const PROVIDER_OPTIONS = [
  { label: "OpenRouter (System One · Jev)", value: "openrouter" as const },
  { label: "Cloudflare Workers AI (Clef)", value: "cloudflare" as const },
  { label: "TypeSafe Jev", value: "jev" as const },
  { label: "Custom endpoint", value: "custom" as const },
];

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

const DEPTH_LEVEL_OPTIONS = DETAIL_LEVELS.map((level) => ({ label: DETAIL_LEVEL_LABELS[level], value: level }));

/** Inserted by "Add starter rules" (only offered while the list is empty). */
const STARTER_DEPTH_RULES: DepthRule[] = [
  { when: "Touches authentication, authorization, payments, secrets, or data migrations", level: "code", enabled: true },
  { when: "Changes concurrency, caching, retries, or error handling in core logic", level: "code", enabled: true },
  { when: "Only adds or reshapes types, interfaces, or API signatures", level: "declarations", enabled: true },
  { when: "Only tests, fixtures, snapshots, generated code, or documentation", level: "files", enabled: true },
];

const AGENT_TASKS: { key: keyof PrReviewSettings["agents"]; label: string }[] = [
  { key: "summary", label: "Summary" },
  { key: "chat", label: "Chat" },
  { key: "explain", label: "Explain" },
  { key: "visual", label: "Visual overview" },
  { key: "describe", label: "Describe (rich HTML)" },
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
 * Ordered list of review-depth rules. Each row is fully controlled (not the usual `SettingsInput`
 * uncontrolled pattern) because reordering swaps content across rows by index — an uncontrolled
 * input would keep showing its own stale text after a move. `useSettingsCommitter`'s `bump()`
 * (see above) repaints this list right after every edit, so the controlled values never lag.
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
      <View style={{ gap: space.sm }}>
        <Text style={{ ...font.small, color: c.foregroundMuted }}>
          No rules yet — PR Review uses its built-in default for every module.
        </Text>
        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
          <Pressable accessibilityRole="button" onPress={onAdd} style={s.buttonQuiet}>
            <Text style={s.buttonQuietText}>Add rule</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onAddStarters} style={s.button}>
            <Text style={s.buttonText}>Add starter rules</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      <View style={s.card}>
        {rules.map((rule, index) => (
          <View key={index}>
            {index > 0 && <View style={{ ...s.hairline, marginVertical: space.sm }} />}
            <View style={{ gap: space.xs }}>
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
                style={{ ...s.input, minHeight: 60 }}
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <View style={{ flex: 1 }}>
                  <SettingsSelect
                    label="Opens at"
                    value={rule.level}
                    options={DEPTH_LEVEL_OPTIONS}
                    onValueChange={(level) => onChangeLevel(index, level)}
                  />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                  <Text style={{ ...font.small, color: c.foregroundMuted }}>Enabled</Text>
                  <Switch value={rule.enabled} onValueChange={(enabled) => onToggleEnabled(index, enabled)} />
                </View>
              </View>
            </View>
          </View>
        ))}
      </View>
      <Pressable accessibilityRole="button" onPress={onAdd} style={{ ...s.buttonQuiet, alignSelf: "flex-start" }}>
        <Text style={s.buttonQuietText}>Add rule</Text>
      </Pressable>
    </View>
  );
}

export function SettingsScreen(props: PluginSurfaceProps): ReactNode {
  const { theme } = props;
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
    content = <SettingsRow label="Loading settings…" />;
  } else if (settings.status === "error") {
    content = (
      <>
        <SettingsRow label="Could not load settings" hint={settings.error} />
        <SettingsAction label="Reload" hint="Try reading settings again." actionLabel="Reload" onPress={() => void settings.reload()} disabled={settings.saving} />
      </>
    );
  } else if (settings.status === "invalid") {
    content = (
      <>
        <SettingsRow label="Stored settings are invalid" hint={`${settings.error} · Reset to defaults to continue.`} />
        <SettingsAction label="Reset to defaults" hint="Discards the stored settings document." actionLabel="Reset" onPress={() => void settings.reset()} disabled={settings.saving} />
      </>
    );
  } else {
    const values = committer.working ?? settings.values;
    const repoList = repos.data?.repos ?? [];
    const errors = committer.errors;

    content = (
      <>
        <SettingsGroup title="Decision model" info="Used for validators, module assignment, risk/severity scoring, and attention ranking.">
          <SettingsSelect
            label="Provider"
            value={values.decision.provider}
            options={PROVIDER_OPTIONS}
            onValueChange={(provider) => committer.commit("decision.provider", (v) => ({ ...v, decision: { ...v.decision, provider } }))}
          />
          <SettingsInput
            label="Model"
            hint="Empty = provider default: typesafe/jev-1.13 (OpenRouter), clef-flash (Cloudflare), jev-latest (TypeSafe)."
            error={errors["decision.model"] ?? null}
            initialValue={values.decision.model}
            onChangeText={(model) => committer.schedule("decision.model", (v) => ({ ...v, decision: { ...v.decision, model } }), SAVE_DEBOUNCE_MS)}
          />
          <SettingsInput
            label="Endpoint URL override"
            hint="Overrides the URL for any provider: self-hosted Jev-compatible API, OpenRouter alpha decisions endpoint, or Cloudflare AI Gateway."
            error={errors["decision.endpointUrl"] ?? null}
            initialValue={values.decision.endpointUrl}
            onChangeText={(endpointUrl) =>
              committer.schedule("decision.endpointUrl", (v) => ({ ...v, decision: { ...v.decision, endpointUrl } }), SAVE_DEBOUNCE_MS)
            }
          />
          <SettingsInput
            label="Cloudflare account ID"
            error={errors["decision.cloudflareAccountId"] ?? null}
            initialValue={values.decision.cloudflareAccountId}
            onChangeText={(cloudflareAccountId) =>
              committer.schedule("decision.cloudflareAccountId", (v) => ({ ...v, decision: { ...v.decision, cloudflareAccountId } }), SAVE_DEBOUNCE_MS)
            }
          />
          <SettingsInput
            label="API key"
            hint="OpenRouter key by default. Or set daemon env vars: OPENROUTER_API_KEY, CLOUDFLARE_API_TOKEN, TYPESAFE_API_KEY, SYSTEMONE_API_KEY."
            error={errors["decision.apiKey"] ?? null}
            initialValue={values.decision.apiKey}
            onChangeText={(apiKey) => committer.schedule("decision.apiKey", (v) => ({ ...v, decision: { ...v.decision, apiKey } }), SAVE_DEBOUNCE_MS)}
            secureTextEntry
          />
          <NumberSettingsInput
            fieldKey="decision.concurrency"
            label="Concurrency"
            hint="1–32 concurrent decision requests."
            value={values.decision.concurrency}
            min={1}
            max={32}
            error={errors["decision.concurrency"] ?? null}
            onError={(message) => committer.setValidationError("decision.concurrency", message)}
            onValid={(concurrency) =>
              committer.schedule("decision.concurrency", (v) => ({ ...v, decision: { ...v.decision, concurrency } }), SAVE_DEBOUNCE_MS)
            }
          />
        </SettingsGroup>

        <SettingsGroup title="Repos sending code to the decision API" info="Off by default. When off for a repo, analysis falls back to heuristics only and validators are unavailable for it.">
          {repos.isPending && <SettingsRow label="Loading repos…" />}
          {repos.isError && <SettingsRow label="Could not load repos" />}
          {repoList.length === 0 && !repos.isPending && (
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
        </SettingsGroup>

        <SettingsGroup
          title="Review depth"
          info={
            "Each rule is a plain-language condition the decision model checks against every module. Matching " +
            "modules open at that depth; when several match, the deepest one wins. With no rules — or for repos " +
            "not opted in to the decision model above — PR Review falls back to its built-in default: noise " +
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
        </SettingsGroup>

        <SettingsGroup title="Agent defaults" info="Which agent profile or model each task uses by default.">
          {agentChoices.isPending && <SettingsRow label="Loading agent choices…" />}
          {AGENT_TASKS.map((task) => (
            <SettingsSelect
              key={task.key}
              label={task.label}
              value={values.agents[task.key]}
              options={agentOptions}
              onValueChange={(choiceId) => committer.commit(`agents.${task.key}`, (v) => ({ ...v, agents: { ...v.agents, [task.key]: choiceId } }))}
              disabled={agentChoices.isPending}
            />
          ))}
        </SettingsGroup>

        <SettingsGroup title="Precompute status" info="Read-only status from the background scheduler.">
          {precomputeStatus.isPending && <SettingsRow label="Loading status…" />}
          {precomputeStatus.isError && <SettingsRow label="Could not load precompute status" />}
          {precomputeStatus.data && (
            <>
              <SettingsRow label="Scheduler" hint={precomputeStatus.data.enabled ? "Enabled" : "Disabled"} />
              <SettingsRow label="Last run" hint={precomputeStatus.data.lastRunAt ?? "Never"} />
              <SettingsRow label="Queued PRs" hint={String(precomputeStatus.data.queued)} />
              <SettingsRow label="Agent jobs today" hint={`${precomputeStatus.data.agentJobsToday} / ${values.precompute.maxAgentJobsPerDay}`} />
              {precomputeStatus.data.lastError && <SettingsRow label="Last error" error={precomputeStatus.data.lastError} />}
            </>
          )}
        </SettingsGroup>

        <SettingsGroup title="Precompute" info="Background analysis for PRs that need your attention, so they open instantly.">
          <SettingsSwitch
            label="Enabled"
            value={values.precompute.enabled}
            onValueChange={(enabled) => committer.commit("precompute.enabled", (v) => ({ ...v, precompute: { ...v.precompute, enabled } }))}
          />
          <NumberSettingsInput
            fieldKey="precompute.intervalMinutes"
            label="Interval (minutes)"
            hint="2–240 minutes."
            value={values.precompute.intervalMinutes}
            min={2}
            max={240}
            error={errors["precompute.intervalMinutes"] ?? null}
            onError={(message) => committer.setValidationError("precompute.intervalMinutes", message)}
            onValid={(intervalMinutes) =>
              committer.schedule("precompute.intervalMinutes", (v) => ({ ...v, precompute: { ...v.precompute, intervalMinutes } }), SAVE_DEBOUNCE_MS)
            }
          />
          <SettingsSwitch
            label="Agent summaries during precompute"
            hint="Uses the daily agent job budget below."
            value={values.precompute.agentSummaries}
            onValueChange={(agentSummaries) =>
              committer.commit("precompute.agentSummaries", (v) => ({ ...v, precompute: { ...v.precompute, agentSummaries } }))
            }
          />
          <NumberSettingsInput
            fieldKey="precompute.maxAgentJobsPerDay"
            label="Max agent jobs per day"
            hint="0–200."
            value={values.precompute.maxAgentJobsPerDay}
            min={0}
            max={200}
            error={errors["precompute.maxAgentJobsPerDay"] ?? null}
            onError={(message) => committer.setValidationError("precompute.maxAgentJobsPerDay", message)}
            onValid={(maxAgentJobsPerDay) =>
              committer.schedule("precompute.maxAgentJobsPerDay", (v) => ({ ...v, precompute: { ...v.precompute, maxAgentJobsPerDay } }), SAVE_DEBOUNCE_MS)
            }
          />
          <SettingsSwitch
            label="Skip drafts"
            value={values.precompute.skipDrafts}
            onValueChange={(skipDrafts) => committer.commit("precompute.skipDrafts", (v) => ({ ...v, precompute: { ...v.precompute, skipDrafts } }))}
          />
          <NumberSettingsInput
            fieldKey="precompute.maxFiles"
            label="Max files"
            hint="Size cap (10–5000 files) above which precompute skips a PR."
            value={values.precompute.maxFiles}
            min={10}
            max={5000}
            error={errors["precompute.maxFiles"] ?? null}
            onError={(message) => committer.setValidationError("precompute.maxFiles", message)}
            onValid={(maxFiles) => committer.schedule("precompute.maxFiles", (v) => ({ ...v, precompute: { ...v.precompute, maxFiles } }), SAVE_DEBOUNCE_MS)}
          />
        </SettingsGroup>

        <SettingsGroup title="Reading and diff">
          <SettingsSelect
            label="Default reading order"
            value={values.readingOrder}
            options={READING_ORDER_OPTIONS}
            onValueChange={(readingOrder) => committer.commit("readingOrder", (v) => ({ ...v, readingOrder }))}
          />
          <SettingsSelect
            label="Default diff layout"
            value={values.diffLayout}
            options={DIFF_LAYOUT_OPTIONS}
            onValueChange={(diffLayout) => committer.commit("diffLayout", (v) => ({ ...v, diffLayout }))}
          />
          <SettingsSelect
            label="Diff density"
            value={values.diffDensity}
            options={DIFF_DENSITY_OPTIONS}
            onValueChange={(diffDensity) => committer.commit("diffDensity", (v) => ({ ...v, diffDensity }))}
          />
        </SettingsGroup>

        {settings.saveError && <SettingsRow label="Could not save settings" error={settings.saveError} />}

        <SettingsGroup title="About">
          <SettingsRow label="Documentation" hint="Decision model adapters, validators format, and the review experience." />
          <ExternalLink href="https://github.com/getpaseo/pr-review">pr-review on GitHub</ExternalLink>
          <SettingsAction label="Reset to defaults" actionLabel="Reset" onPress={() => void settings.reset()} disabled={settings.saving} />
        </SettingsGroup>
      </>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 16, gap: 12 }}>
      {content}
    </ScrollView>
  );
}
