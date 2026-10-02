import { Platform, Pressable, Text, View } from "react-native";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ComposerMode } from "./rows";
import { font, space, surfaces } from "../ui/tokens";

type Theme = PluginSurfaceProps["theme"];

/** Composer row rendered directly under its target line. Only one is ever mounted at a time
 * (`ModuleTab` holds a single composer target); opening another replaces this one. */
export function InlineComposer({
  theme,
  mode,
  body,
  onChangeBody,
  busy,
  onCancel,
  onAddToReview,
  onCommentNow,
  onSave,
  autoFocus = true,
}: {
  theme: Theme;
  mode: ComposerMode;
  body: string;
  onChangeBody: (text: string) => void;
  busy: boolean;
  onCancel: () => void;
  onAddToReview: () => void;
  onCommentNow: () => void;
  onSave: () => void;
  /** Only the composer's first mount (for a given target) should steal focus — a virtualized
   * list cell can unmount and remount as it scrolls out of and back into the render window, and
   * re-focusing on every one of those remounts would steal focus/scroll out from under the user. */
  autoFocus?: boolean;
}) {
  const c = theme.colors;
  const s = surfaces(c);
  const disabled = busy || !body.trim();

  function handleKeyPress(e: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    if (Platform.OS === "web" && e.nativeEvent.key === "Escape") onCancel();
  }

  return (
    <View style={{ padding: space.sm, paddingLeft: space.lg, backgroundColor: c.surface1, gap: space.sm }}>
      <TextInput
        value={body}
        onChangeText={onChangeBody}
        onKeyPress={handleKeyPress}
        placeholder="Leave a comment…"
        multiline
        autoFocus={autoFocus}
        style={{ ...s.input, minHeight: 90 }}
      />
      <Text style={{ ...font.caption, color: c.foregroundMuted }}>Markdown supported</Text>
      <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
        <Pressable accessibilityRole="button" onPress={onCancel} style={s.buttonQuiet}>
          <Text style={s.buttonQuietText}>Cancel</Text>
        </Pressable>
        {mode === "new" ? (
          <>
            <Pressable accessibilityRole="button" disabled={disabled} onPress={onAddToReview} style={[s.buttonQuiet, disabled ? { opacity: 0.5 } : null]}>
              <Text style={s.buttonQuietText}>Add to review</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={disabled} onPress={onCommentNow} style={[s.button, disabled ? { opacity: 0.5 } : null]}>
              <Text style={s.buttonText}>Comment now</Text>
            </Pressable>
          </>
        ) : (
          <Pressable accessibilityRole="button" disabled={disabled} onPress={onSave} style={[s.button, disabled ? { opacity: 0.5 } : null]}>
            <Text style={s.buttonText}>Save</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
