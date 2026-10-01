import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
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
import { agentChoicesRpc, reposListRpc } from "../../shared/rpc";
import { prReviewSettings, type PrReviewSettings } from "../../shared/settings";

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

export function SettingsScreen(_props: PluginSurfaceProps): ReactNode {
  const settings = useSettings(prReviewSettings);
  const reposRpc = useRpc(reposListRpc);
  const agentChoicesRpcFn = useRpc(agentChoicesRpc);
  const repos = useQuery({ queryKey: ["prr.settings.repos"], queryFn: () => reposRpc({}), staleTime: 60_000 });
  const agentChoices = useQuery({ queryKey: ["prr.settings.agentChoices"], queryFn: () => agentChoicesRpcFn({}), staleTime: 60_000 });

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
    const { values, revision } = settings;
    const apply = (next: PrReviewSettings) => void settings.save(next, revision);
    const repoList = repos.data?.repos ?? [];

    content = (
      <>
        <SettingsGroup title="Decision model" info="Used for validators, module assignment, risk/severity scoring, and attention ranking.">
          <SettingsSelect
            label="Provider"
            value={values.decision.provider}
            options={PROVIDER_OPTIONS}
            onValueChange={(provider) => apply({ ...values, decision: { ...values.decision, provider } })}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Model"
            hint="Empty = provider default: typesafe/jev-1.13 (OpenRouter), clef-flash (Cloudflare), jev-latest (TypeSafe)."
            initialValue={values.decision.model}
            onChangeText={(model) => apply({ ...values, decision: { ...values.decision, model } })}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Endpoint URL override"
            hint="Overrides the URL for any provider: self-hosted Jev-compatible API, OpenRouter alpha decisions endpoint, or Cloudflare AI Gateway."
            initialValue={values.decision.endpointUrl}
            onChangeText={(endpointUrl) => apply({ ...values, decision: { ...values.decision, endpointUrl } })}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Cloudflare account ID"
            initialValue={values.decision.cloudflareAccountId}
            onChangeText={(cloudflareAccountId) => apply({ ...values, decision: { ...values.decision, cloudflareAccountId } })}
            disabled={settings.saving}
          />
          <SettingsInput
            label="API key"
            hint="OpenRouter key by default. Or set daemon env vars: OPENROUTER_API_KEY, CLOUDFLARE_API_TOKEN, TYPESAFE_API_KEY, SYSTEMONE_API_KEY."
            initialValue={values.decision.apiKey}
            onChangeText={(apiKey) => apply({ ...values, decision: { ...values.decision, apiKey } })}
            secureTextEntry
            disabled={settings.saving}
          />
          <SettingsInput
            label="Concurrency"
            hint="1–32 concurrent decision requests."
            initialValue={String(values.decision.concurrency)}
            onChangeText={(text) => {
              const n = Math.round(Number(text));
              if (Number.isFinite(n) && n >= 1 && n <= 32) apply({ ...values, decision: { ...values.decision, concurrency: n } });
            }}
            disabled={settings.saving}
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
              onValueChange={(enabled) => {
                const decisionRepos = enabled
                  ? [...values.decisionRepos, repo.slug]
                  : values.decisionRepos.filter((slug) => slug !== repo.slug);
                apply({ ...values, decisionRepos });
              }}
              disabled={settings.saving}
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
              onValueChange={(choiceId) => apply({ ...values, agents: { ...values.agents, [task.key]: choiceId } })}
              disabled={settings.saving || agentChoices.isPending}
            />
          ))}
        </SettingsGroup>

        <SettingsGroup title="Precompute" info="Background analysis for PRs that need your attention, so they open instantly.">
          <SettingsSwitch
            label="Enabled"
            value={values.precompute.enabled}
            onValueChange={(enabled) => apply({ ...values, precompute: { ...values.precompute, enabled } })}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Interval (minutes)"
            hint="2–240 minutes."
            initialValue={String(values.precompute.intervalMinutes)}
            onChangeText={(text) => {
              const n = Math.round(Number(text));
              if (Number.isFinite(n) && n >= 2 && n <= 240) apply({ ...values, precompute: { ...values.precompute, intervalMinutes: n } });
            }}
            disabled={settings.saving}
          />
          <SettingsSwitch
            label="Agent summaries during precompute"
            hint="Uses the daily agent job budget below."
            value={values.precompute.agentSummaries}
            onValueChange={(agentSummaries) => apply({ ...values, precompute: { ...values.precompute, agentSummaries } })}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Max agent jobs per day"
            hint="0–200."
            initialValue={String(values.precompute.maxAgentJobsPerDay)}
            onChangeText={(text) => {
              const n = Math.round(Number(text));
              if (Number.isFinite(n) && n >= 0 && n <= 200) apply({ ...values, precompute: { ...values.precompute, maxAgentJobsPerDay: n } });
            }}
            disabled={settings.saving}
          />
          <SettingsSwitch
            label="Skip drafts"
            value={values.precompute.skipDrafts}
            onValueChange={(skipDrafts) => apply({ ...values, precompute: { ...values.precompute, skipDrafts } })}
            disabled={settings.saving}
          />
          <SettingsInput
            label="Max files"
            hint="Size cap (10–5000 files) above which precompute skips a PR."
            initialValue={String(values.precompute.maxFiles)}
            onChangeText={(text) => {
              const n = Math.round(Number(text));
              if (Number.isFinite(n) && n >= 10 && n <= 5000) apply({ ...values, precompute: { ...values.precompute, maxFiles: n } });
            }}
            disabled={settings.saving}
          />
        </SettingsGroup>

        <SettingsGroup title="Reading order">
          <SettingsSelect
            label="Default reading order"
            value={values.readingOrder}
            options={READING_ORDER_OPTIONS}
            onValueChange={(readingOrder) => apply({ ...values, readingOrder })}
            disabled={settings.saving}
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
