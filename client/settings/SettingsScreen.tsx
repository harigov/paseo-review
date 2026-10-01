import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
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
import { prReviewSettings, PrReviewSettingsSchema, type PrReviewSettings } from "../../shared/settings";

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

export function SettingsScreen(_props: PluginSurfaceProps): ReactNode {
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

        <SettingsGroup title="Reading order">
          <SettingsSelect
            label="Default reading order"
            value={values.readingOrder}
            options={READING_ORDER_OPTIONS}
            onValueChange={(readingOrder) => committer.commit("readingOrder", (v) => ({ ...v, readingOrder }))}
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
