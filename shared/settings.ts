import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DecisionProviderSchema = z.enum(["openrouter", "cloudflare", "jev", "custom"]);

export const PrReviewSettingsSchema = z.object({
  decision: z
    .object({
      /** openrouter = OpenRouter System One API (Jev); cloudflare = Workers AI Clef; jev = TypeSafe; custom = any System One compatible endpoint. */
      provider: DecisionProviderSchema.default("openrouter"),
      /** Empty = provider default (openrouter: typesafe/jev-1.13, cloudflare: clef-flash, jev: jev-latest). */
      model: z.string().default(""),
      /** Overrides the endpoint URL for any provider (self-hosted Jev/Clef-compatible API, AI Gateway). */
      endpointUrl: z.string().default(""),
      cloudflareAccountId: z.string().default(""),
      /** API key / token. Prefer daemon env vars: OPENROUTER_API_KEY, CLOUDFLARE_API_TOKEN, TYPESAFE_API_KEY, SYSTEMONE_API_KEY. */
      apiKey: z.string().default(""),
      concurrency: z.number().int().min(1).max(32).default(8),
    })
    .default({
      provider: "openrouter",
      model: "",
      endpointUrl: "",
      cloudflareAccountId: "",
      apiKey: "",
      concurrency: 8,
    }),
  /** Repos ("owner/name") opted in to sending code to the decision API. Off by default. */
  decisionRepos: z.array(z.string()).default([]),
  agents: z
    .object({
      /** AgentChoice ids ("profile:<id>" or "model:<provider/model>"); "" = first available. */
      summary: z.string().default(""),
      chat: z.string().default(""),
      explain: z.string().default(""),
      visual: z.string().default(""),
      describe: z.string().default(""),
    })
    .default({ summary: "", chat: "", explain: "", visual: "", describe: "" }),
  precompute: z
    .object({
      enabled: z.boolean().default(true),
      intervalMinutes: z.number().int().min(2).max(240).default(10),
      agentSummaries: z.boolean().default(false),
      maxAgentJobsPerDay: z.number().int().min(0).max(200).default(10),
      skipDrafts: z.boolean().default(true),
      maxFiles: z.number().int().min(10).max(5000).default(1500),
    })
    .default({
      enabled: true,
      intervalMinutes: 10,
      agentSummaries: false,
      maxAgentJobsPerDay: 10,
      skipDrafts: true,
      maxFiles: 1500,
    }),
  readingOrder: z.enum(["foundations", "risk", "chrono"]).default("foundations"),
});

export type PrReviewSettings = z.infer<typeof PrReviewSettingsSchema>;

export const prReviewSettings = defineSettings({
  id: "pr-review",
  scope: "host",
  version: 1,
  schema: PrReviewSettingsSchema,
});

export const DEFAULT_SETTINGS: PrReviewSettings = PrReviewSettingsSchema.parse({});
