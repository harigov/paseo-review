import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Inbox } from "./Inbox";
import { PrScreen } from "./PrScreen";
import { recordRecentPr, rememberLocation, useLastLocation, useUiStateHydration } from "./ui-state";

/** The whole PR Review surface. 0.10 surfaces get no route params, so navigation is internal state. */
export function PrReviewApp(props: PluginSurfaceProps) {
  const { ready } = useUiStateHydration();
  const lastLocation = useLastLocation();
  const [selected, setSelected] = useState<{ repo: string; number: number } | null>(null);
  // Applies the persisted last location to `selected` exactly once per mount, as soon as
  // hydration is ready (it may already be ready on mount, if this isn't the session's first visit).
  const appliedInitialLocation = useRef(false);

  useEffect(() => {
    if (!ready || appliedInitialLocation.current) return;
    appliedInitialLocation.current = true;
    if (lastLocation.kind === "pr") {
      setSelected({ repo: lastLocation.repo, number: lastLocation.number });
    }
    // Only the first `ready` transition after mount should seed `selected`; later `lastLocation`
    // changes flow through `onOpenPr`/`onBack` instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!ready) {
    // Avoid flashing the inbox while the persisted location/recents are still loading.
    return <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }} />;
  }

  function openPr(ref: { repo: string; number: number; title?: string }) {
    setSelected({ repo: ref.repo, number: ref.number });
    rememberLocation({ kind: "pr", repo: ref.repo, number: ref.number, tab: null });
    recordRecentPr({ repo: ref.repo, number: ref.number, title: ref.title ?? `#${ref.number}` });
  }

  function backToInbox() {
    setSelected(null);
    rememberLocation({ kind: "inbox" });
  }

  return (
    <View style={{ flex: 1 }}>
      {selected ? (
        <PrScreen {...props} repo={selected.repo} number={selected.number} onBack={backToInbox} />
      ) : (
        <Inbox theme={props.theme} layout={props.layout} onOpenPr={openPr} />
      )}
    </View>
  );
}
