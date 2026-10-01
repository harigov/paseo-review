import { Component, type ReactNode } from "react";
import { Text, View } from "react-native";

/**
 * Keeps one failing panel (e.g. the chat panel on a host without the daemon-API context) from
 * unmounting the whole PR screen. Shows a short message in place of the failed subtree.
 */
export class ErrorBoundary extends Component<
  { fallbackTitle: string; color: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[pr-review] panel failed:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <View style={{ padding: 12, gap: 4 }}>
          <Text style={{ color: this.props.color, fontSize: 12, fontWeight: "600" }}>{this.props.fallbackTitle}</Text>
          <Text style={{ color: this.props.color, fontSize: 11 }}>{this.state.error.message}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}
