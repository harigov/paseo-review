import type { PluginSettings } from "@getpaseo/plugin/server";
import { DEFAULT_SETTINGS, PrReviewSettingsSchema, type PrReviewSettings } from "../../shared/settings";

let handle: PluginSettings<typeof PrReviewSettingsSchema> | null = null;

export function setSettingsHandle(next: PluginSettings<typeof PrReviewSettingsSchema>): void {
  handle = next;
}

/** Current settings; falls back to defaults when unset or invalid. */
export async function getSettings(): Promise<PrReviewSettings> {
  if (!handle) return DEFAULT_SETTINGS;
  try {
    const state = await handle.read();
    if (state.status === "ready") return PrReviewSettingsSchema.parse(state.values);
  } catch {
    // fall through to defaults
  }
  return DEFAULT_SETTINGS;
}
