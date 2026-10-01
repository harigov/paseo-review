import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { localValidateRpc } from "../../shared/rpc";
import { ValidatorResultSchema, type ValidatorResult } from "../../shared/types";
import { useJobRunner } from "../data/hooks";
import { ValidatorResultsList, validatorScoreboard } from "../review/ValidatorResultsList";

const LocalValidateResultSchema = z.object({
  results: z.array(ValidatorResultSchema).default([]),
  /** e.g. "Decision model off for this repo" when validators couldn't run. */
  notice: z.string().optional(),
});

function parseResults(raw: unknown): { results: ValidatorResult[]; notice: string | null } {
  const parsed = LocalValidateResultSchema.safeParse(raw);
  if (!parsed.success) return { results: [], notice: null };
  return { results: parsed.data.results, notice: parsed.data.notice ?? null };
}

export function LocalValidatePanel(props: PluginWorkspacePanelProps) {
  const { theme, workspaceId } = props;
  const c = theme.colors;
  const workspace = useWorkspace(workspaceId, (w) => ({ directory: w.directory, name: w.name }));
  const rpc = useRpc(localValidateRpc);
  const { run, job, running } = useJobRunner();
  const toast = useToast();
  const [baseRef, setBaseRef] = useState("");
  const [results, setResults] = useState<ValidatorResult[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onRun() {
    if (!workspace) return;
    setResults(null);
    setNotice(null);
    try {
      const finished = await run(() => rpc({ cwd: workspace.directory, baseRef: baseRef.trim() || undefined }));
      if (finished.status === "error") {
        toast.error(finished.error ?? "Validation failed");
        return;
      }
      const parsed = parseResults(finished.result);
      setResults(parsed.results);
      setNotice(parsed.notice);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Validation failed");
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "700" }}>Validators{workspace ? ` · ${workspace.name}` : ""}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        Runs this repo's validators against the diff between a base ref and your working tree.
      </Text>
      <View style={{ gap: 6 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>Base ref (default: auto-detect)</Text>
        <TextInput
          value={baseRef}
          onChangeText={setBaseRef}
          placeholder="main"
          style={{ color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 13 }}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={running || !workspace}
        onPress={onRun}
        style={{ alignSelf: "flex-start", paddingVertical: 7, paddingHorizontal: 14, backgroundColor: c.accent, borderRadius: 6, opacity: running ? 0.6 : 1 }}
      >
        <Text style={{ color: c.accentForeground, fontSize: 13 }}>{running ? `Running… ${job?.stage ?? ""}` : "Run validators"}</Text>
      </Pressable>

      {results !== null ? (
        results.length === 0 ? (
          <View style={{ gap: 4, padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {notice ??
                job?.error ??
                "No results. Validators need this repo opted in to send code to the decision API — turn that on in PR Review settings, or check that any validators are enabled."}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Text style={{ color: c.foreground, fontSize: 13 }}>{validatorScoreboard(results)}</Text>
            <ValidatorResultsList results={results} theme={theme} />
          </View>
        )
      ) : null}
    </View>
  );
}
