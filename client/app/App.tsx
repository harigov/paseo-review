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
  // Seed from the persisted location synchronously when it is already hydrated (every visit after
  // the session's first), so a re-mount lands on the PR without first flashing the inbox.
  const [selected, setSelected] = useState<{ repo: string; number: number } | null>(() =>
    ready && lastLocation.kind === "pr" ? { repo: lastLocation.repo, number: lastLocation.number } : null,
  );
  // On the session's first visit hydration finishes after mount; apply the location exactly once then.
  const appliedInitialLocation = useRef(ready);

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
