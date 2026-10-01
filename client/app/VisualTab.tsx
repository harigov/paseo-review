import { View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { PrTabContext } from "../pr/tab-props";
import { useJobRunner } from "../data/hooks";
import { HtmlView } from "../render/HtmlView";
import { agentTaskRpc } from "../../shared/rpc";
import { space } from "../ui/tokens";
import { EmptyState, InlineLoading } from "../ui/states";

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
      <View style={{ flex: 1, backgroundColor: c.surface0, padding: space.lg }}>
        <HtmlView html={analysis.visualOverviewHtml} theme={theme} height="flex" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0, justifyContent: "center" }}>
      {job.running ? (
        <InlineLoading theme={theme} label={`Generating… ${job.job?.stage ?? ""}`} />
      ) : (
        <EmptyState
          theme={theme}
          icon="Workflow"
          title="No visual overview yet"
          hint="Generate one with your configured agent to get a diagram of what changed and why."
          actionLabel="Generate visual overview"
          onAction={generate}
        />
      )}
    </View>
  );
}
