import { useState } from "react";
import { View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Inbox } from "./Inbox";
import { PrScreen } from "./PrScreen";

/** The whole PR Review surface. 0.10 surfaces get no route params, so navigation is internal state. */
export function PrReviewApp(props: PluginSurfaceProps) {
  const [selected, setSelected] = useState<{ repo: string; number: number } | null>(null);

  return (
    <View style={{ flex: 1 }}>
      {selected ? (
        <PrScreen {...props} repo={selected.repo} number={selected.number} onBack={() => setSelected(null)} />
      ) : (
        <Inbox theme={props.theme} layout={props.layout} onOpenPr={setSelected} />
      )}
    </View>
  );
}
