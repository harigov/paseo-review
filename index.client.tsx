import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { PrReviewApp } from "./client/app/App";
import { LocalValidatePanel } from "./client/local/LocalValidatePanel";
import { SettingsScreen } from "./client/settings/SettingsScreen";
import { localValidateRpc } from "./shared/rpc";
import * as hostUi from "@getpaseo/plugin/client/ui";

const SURFACE_ID = "pr-review";
const TITLE = "PR Review";

// Paseo 0.11 replaces addSurface/addSidebarItem with addScreen/addSidebarHeaderItem.
// Use the new API when the host has it; fall back to the 0.10 API otherwise.
interface ScreenApi {
  addScreen(input: { id: string; title: string; Component: ComponentType<PluginSurfaceProps> }): () => void;
  addSidebarHeaderItem(input: { id: string; title: string; Component: ComponentType<any> }): () => void;
}

function hasScreenApi(client: PluginClientContext): client is PluginClientContext & ScreenApi {
  const candidate = client as unknown as Partial<ScreenApi>;
  return typeof candidate.addScreen === "function" && typeof candidate.addSidebarHeaderItem === "function";
}

export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void> = [];

  if (hasScreenApi(client)) {
    cleanups.push(client.addScreen({ id: SURFACE_ID, title: TITLE, Component: PrReviewApp }));
    cleanups.push(client.addSidebarHeaderItem({ id: SURFACE_ID, title: TITLE, Component: makeSidebarRow() }));
  } else {
    cleanups.push(client.addSurface(SURFACE_ID, PrReviewApp));
    cleanups.push(client.addSidebarItem({ id: SURFACE_ID, title: TITLE, icon: "GitPullRequest", surface: SURFACE_ID }));
  }

  cleanups.push(client.addSettingsScreen({ id: SURFACE_ID, title: TITLE, icon: "GitPullRequest", Component: SettingsScreen }));

  cleanups.push(
    client.addWorkspacePanel({
      id: "validate",
      title: "Validators",
      icon: "ShieldCheck",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: LocalValidatePanel,
    }),
  );

  cleanups.push(
    client.addCommandCenterItem({
      id: "open",
      title: "Open PR Review",
      icon: "GitPullRequest",
      context: "global",
      onSelect: ({ openSurface }: { openSurface(id: string): void }) => openSurface(SURFACE_ID),
    } as never),
  );

  cleanups.push(
    client.addCommandCenterItem({
      id: "validate-workspace",
      title: "Run validators on this workspace",
      icon: "ShieldCheck",
      context: "workspace",
      onSelect: ({ openPanel, workspace }: { openPanel: PluginClientContext["openPanel"]; workspace: { id: string } }) =>
        openPanel("validate", { workspaceId: workspace.id }),
    } as never),
  );

  cleanups.push(
    client.addSlashCommand({
      name: "validate",
      description: "Run PR Review validators on this workspace's changes",
      argumentHint: "[base-ref]",
      context: "workspace",
      async onSubmit({ args, rpc, workspace, openPanel }: any) {
        await rpc(localValidateRpc, { cwd: workspace.directory, baseRef: args || undefined });
        openPanel("validate", { workspaceId: workspace.id });
      },
    } as never),
  );

  return () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        // host teardown continues
      }
    }
  };
}

function makeSidebarRow(): ComponentType<any> {
  // SidebarRow ships with 0.11 hosts; this path only runs when addScreen exists.
  const SidebarRow = (hostUi as unknown as { SidebarRow?: ComponentType<any> }).SidebarRow;
  return function PrReviewSidebarRow(props: { currentScreen?: { screenId?: string }; openScreen(input: { screenId: string }): void }) {
    if (!SidebarRow) return null;
    return (
      <SidebarRow
        icon="GitPullRequest"
        active={props.currentScreen?.screenId === SURFACE_ID}
        onPress={() => props.openScreen({ screenId: SURFACE_ID })}
      />
    );
  };
}
