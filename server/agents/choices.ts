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

/** Modes exposed by each provider family, cached from the last `providers.snapshot()` call so
 * `readOnlyModeFor` doesn't need a second round trip for the common case. Best-effort only. */
const modesCache = new Map<string, Array<{ id: string; label: string }>>();

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
      if (entry.modes?.length) modesCache.set(entry.provider.toLowerCase(), entry.modes);
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

/** Candidate id/label fragments for a restricted, non-destructive mode, checked in order. */
const READ_ONLY_MODE_CANDIDATES = ["plan", "ask", "read-only", "readonly", "read only", "review"];

/** Picks the first mode (by id or label, case-insensitively) that looks read-only. Returns
 * null when the list is empty/unknown so callers omit `modeId` rather than guess. */
export function pickReadOnlyMode(modes: Array<{ id: string; label: string }> | null | undefined): string | null {
  if (!modes?.length) return null;
  for (const candidate of READ_ONLY_MODE_CANDIDATES) {
    const match = modes.find((m) => m.id.toLowerCase() === candidate || m.label.toLowerCase() === candidate);
    if (match) return match.id;
  }
  return null;
}

/**
 * Read-only mode id for a provider, derived from the provider's *actual* available modes
 * (from `providers.snapshot()`), not a hardcoded per-provider guess. Falls back to a fresh
 * snapshot call when the family isn't in `modesCache` yet. Callers should omit `modeId` when
 * this resolves to null rather than pass an unrecognized mode id.
 */
export async function readOnlyModeFor(paseo: PaseoApi, provider: string): Promise<string | null> {
  const family = provider.split("/")[0]?.toLowerCase() ?? "";
  if (!family) return null;
  let modes = modesCache.get(family);
  if (!modes) {
    try {
      const snapshot = await paseo.providers.snapshot();
      for (const entry of snapshot.entries ?? []) {
        if (entry.modes?.length) modesCache.set(entry.provider.toLowerCase(), entry.modes);
      }
      modes = modesCache.get(family);
    } catch (error) {
      console.error("[pr-review] providers.snapshot() failed while resolving a read-only mode:", error);
    }
  }
  return pickReadOnlyMode(modes);
}
