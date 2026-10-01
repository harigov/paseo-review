import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { z } from "zod";
import { agentTaskRpc } from "../../shared/rpc";
import { useJobRunner } from "../data/hooks";

export interface ExplainResult {
  explanation: string;
  suggestedFix: string | null;
}

const ExplainResultSchema = z.object({
  explanation: z.string(),
  suggestedFix: z.string().nullable().optional(),
});

function parseExplainResult(raw: unknown): ExplainResult | null {
  const parsed = ExplainResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { explanation: parsed.data.explanation, suggestedFix: parsed.data.suggestedFix ?? null };
}

/** "Explain" button: runs a read-only agent task and shows the result in a modal. */
export function ExplainAction({
  repo,
  number,
  target,
  theme,
  onExplained,
}: {
  repo: string;
  number: number;
  target: string;
  theme: PluginSurfaceProps["theme"];
  onExplained?: (result: ExplainResult) => void;
}) {
  const c = theme.colors;
  const rpc = useRpc(agentTaskRpc);
  const { run, running } = useJobRunner();
  const toast = useToast();
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [open, setOpen] = useState(false);

  async function onPress() {
    try {
      const job = await run(() => rpc({ repo, number, task: "explain", target }));
      if (job.status === "error") {
        toast.error(job.error ?? "Explain failed");
        return;
      }
      const parsed = parseExplainResult(job.result);
      if (!parsed) {
        toast.error("Explain returned no result");
        return;
      }
      setResult(parsed);
      onExplained?.(parsed);
      setOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Explain failed");
    }
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        disabled={running}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 4,
          backgroundColor: pressed ? c.surface2 : "transparent",
        })}
      >
        <Icon name="Sparkles" size={13} color={c.foregroundMuted} />
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{running ? "Explaining…" : "Explain"}</Text>
      </Pressable>
      <Modal title="Explanation" open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>{result?.explanation ?? ""}</Text>
          {result?.suggestedFix ? (
            <View style={{ marginTop: 12, gap: 4 }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, textTransform: "uppercase" }}>Suggested fix</Text>
              <Text style={{ color: c.foreground, fontSize: 12, fontFamily: "monospace" }}>{result.suggestedFix}</Text>
            </View>
          ) : null}
        </Modal.Content>
      </Modal>
    </>
  );
}
