import { useEffect, useRef } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { NativeSyntheticEvent, TextInput as NativeTextInput, TextInputKeyPressEventData } from "react-native";
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
  targetKey,
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
  /** Identifies this composer's target (path/side/line/mode/draft-or-comment id). Used to decide
   * when to steal focus: only the first mount *for a given target* should do so. A virtualized
   * list cell can unmount and remount as it scrolls out of and back into the render window, so
   * that decision can't be made once at the call site during render (comparing against a ref
   * mutated in the parent's render body breaks under StrictMode's double-render — a throwaway
   * render would mutate the ref before the committed render ever reads it). Doing it here, in a
   * mount-time effect scoped to this component instance, means a remount (fresh instance, fresh
   * ref) still focuses once, while a same-instance re-render for an unrelated reason (the target
   * key unchanged) does not steal focus again. */
  targetKey: string;
}) {
  const c = theme.colors;
  const s = surfaces(c);
  const disabled = busy || !body.trim();
  const inputRef = useRef<NativeTextInput | null>(null);
  const focusedTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (focusedTargetRef.current === targetKey) return;
    focusedTargetRef.current = targetKey;
    inputRef.current?.focus();
  }, [targetKey]);

  function handleKeyPress(e: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    if (Platform.OS === "web" && e.nativeEvent.key === "Escape") onCancel();
  }

  return (
    <View style={{ padding: space.sm, paddingLeft: space.lg, backgroundColor: c.surface1, gap: space.sm }}>
      <TextInput
        ref={inputRef}
        value={body}
        onChangeText={onChangeBody}
        onKeyPress={handleKeyPress}
        placeholder="Leave a comment…"
        multiline
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
