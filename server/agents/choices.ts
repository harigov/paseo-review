import type { PaseoApi } from "../core/paseo";
import { getSettings } from "../core/settings";
import type { AgentChoice } from "../../shared/types";

// Agent choice discovery: the daemon's saved agent profiles (paseo.config.get()) plus the
// first couple of models per available provider (paseo.providers.snapshot()). Both calls are
// best-effort — a daemon that can't answer one of them still yields the other.

interface RawAgentProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

/** The exact location of `agentProfiles` on the config payload has moved before; check both. */
function extractProfiles(config: unknown): RawAgentProfile[] {
  if (!config || typeof config !== "object") return [];
  const top = config as Record<string, unknown>;
  if (Array.isArray(top.agentProfiles)) return top.agentProfiles as RawAgentProfile[];
  const daemon = top.daemon;
  if (daemon && typeof daemon === "object" && Array.isArray((daemon as Record<string, unknown>).agentProfiles)) {
    return (daemon as Record<string, unknown>).agentProfiles as RawAgentProfile[];
  }
  return [];
}

export async function listAgentChoices(paseo: PaseoApi): Promise<AgentChoice[]> {
  const choices: AgentChoice[] = [];

  try {
    const { config } = await paseo.config.get();
    for (const profile of extractProfiles(config)) {
      choices.push({
        id: `profile:${profile.id}`,
        label: profile.name,
        provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
        modeId: profile.modeId ?? null,
        thinkingOptionId: profile.thinkingOptionId ?? null,
        kind: "profile",
      });
    }
  } catch (error) {
    console.error("[pr-review] config.get() failed while listing agent choices:", error);
  }

  try {
    const snapshot = await paseo.providers.snapshot();
    for (const entry of snapshot.entries ?? []) {
      if (entry.status !== "ready" || entry.enabled === false) continue;
      for (const model of (entry.models ?? []).slice(0, 2)) {
        choices.push({
          id: `model:${entry.provider}/${model.id}`,
          label: `${entry.label ?? entry.provider} · ${model.label}`,
          provider: `${entry.provider}/${model.id}`,
          modeId: null,
          thinkingOptionId: model.defaultThinkingOptionId ?? null,
          kind: "model",
        });
      }
    }
  } catch (error) {
    console.error("[pr-review] providers.snapshot() failed while listing agent choices:", error);
  }

  return choices;
}

export type AgentTask = "summary" | "chat" | "explain" | "visual" | "describe";

/** Resolves the agent to use for a task: explicit choice, then the per-task setting, then the first profile, then the first model. */
export async function pickDefaultChoice(
  paseo: PaseoApi,
  task: AgentTask,
  explicitChoiceId?: string,
): Promise<AgentChoice | null> {
  const choices = await listAgentChoices(paseo);
  if (choices.length === 0) return null;

  if (explicitChoiceId) {
    const found = choices.find((choice) => choice.id === explicitChoiceId);
    if (found) return found;
  }

  const settings = await getSettings();
  const settingId = settings.agents[task];
  if (settingId) {
    const found = choices.find((choice) => choice.id === settingId);
    if (found) return found;
  }

  return choices.find((choice) => choice.kind === "profile") ?? choices[0];
}

const READ_ONLY_MODE_BY_PROVIDER: Record<string, string> = {
  claude: "plan",
  cursor: "ask",
  opencode: "plan",
  codex: "read-only",
};

/** Best-effort read-only mode per provider family. Callers should omit modeId when this returns null. */
export function readOnlyModeFor(provider: string): string | null {
  const family = provider.split("/")[0]?.toLowerCase() ?? "";
  return READ_ONLY_MODE_BY_PROVIDER[family] ?? null;
}
