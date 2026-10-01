import { Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { PrTabContext } from "../pr/tab-props";
import { useJobRunner } from "../data/hooks";
import { HtmlView } from "../render/HtmlView";
import { agentTaskRpc } from "../../shared/rpc";

export function VisualTab(props: PrTabContext) {
  const { theme, repo, number, analysis, refresh } = props;
  const c = theme.colors;
  const toast = useToast();
  const agentTask = useRpc(agentTaskRpc);
  const job = useJobRunner();

  async function generate() {
    try {
      const result = await job.run(() => agentTask({ repo, number, task: "visual" }));
      if (result.status === "error") toast.error(result.error ?? "Could not generate the visual overview.");
      refresh();
    } catch {
      toast.error("Could not generate the visual overview.");
    }
  }

  if (analysis?.visualOverviewHtml) {
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0, padding: 16 }}>
        <HtmlView html={analysis.visualOverviewHtml} theme={theme} height="flex" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: c.surface0 }}>
      <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>
        No visual overview yet. Generate one with your configured agent to get a diagram of what changed and why.
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={job.running}
        onPress={generate}
        style={{ alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 6, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}
      >
        <Text style={{ color: c.foreground, fontSize: 13 }}>{job.running ? `Generating… ${job.job?.stage ?? ""}` : "Generate visual overview"}</Text>
      </Pressable>
    </View>
  );
}
