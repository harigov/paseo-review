import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Analysis, PrDetail, ReadingOrder } from "../../shared/types";

/** Props every PR tab receives from the PR screen shell (client/app). */
export interface PrTabContext {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  navigation: PluginSurfaceProps["navigation"];
  repo: string;
  number: number;
  detail: PrDetail | null;
  analysis: Analysis | null;
  readingOrder: ReadingOrder;
  /** Filter to files changed since the viewer's last review. */
  sinceLastReview: boolean;
  /** Re-fetch PR detail + analysis (e.g. after toggling viewed). */
  refresh(): void;
  /** Force a fresh analysis run (e.g. after submitting a review, so "since my last review" moves). */
  reanalyze(): void;
  /** Start or reopen the PR chat; `seed` pre-fills context for the agent. */
  openChat(seed?: string): void;
  /** Switch the PR screen to another tab ("overview", "module:<id>", "validators", "conversations", "visual"). */
  openTab(tabId: string): void;
}

export interface ModuleTabProps extends PrTabContext {
  moduleId: string;
}
