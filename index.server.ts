import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAgentService, registerAgentHandlers, startBackground } from "./server/agents";
import { createAnalysisService, registerAnalysisHandlers } from "./server/analysis";
import { rememberPaseo } from "./server/core/paseo";
import { services } from "./server/core/services";
import { setSettingsHandle } from "./server/core/settings";
import { createDecisionService } from "./server/decide";
import { createGitHubService, registerGitHubHandlers } from "./server/github";
import { registerCommentHandlers } from "./server/github/comments";
import { createValidatorService, registerValidatorHandlers } from "./server/validators";
import { registerUiStateHandlers } from "./server/ui-state";
import { prReviewSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  setSettingsHandle(server.registerSettings(prReviewSettings));

  services.github = createGitHubService();
  services.decide = createDecisionService();
  services.validators = createValidatorService();
  services.analysis = createAnalysisService();
  services.agents = createAgentService();

  registerGitHubHandlers(server);
  registerCommentHandlers(server);
  registerAnalysisHandlers(server);
  registerValidatorHandlers(server);
  registerAgentHandlers(server);
  registerUiStateHandlers(server);

  // Capture the daemon API from lifecycle events too, so precompute can start without a UI visit.
  const stopHook = server.on("agent.turn_ended", (_event, context) => rememberPaseo(context.paseo));
  const stopBackground = startBackground();

  return async () => {
    stopHook();
    await stopBackground();
  };
}
