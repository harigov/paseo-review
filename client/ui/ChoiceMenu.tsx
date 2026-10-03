import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { font, radius, space, surfaces, weight } from "./tokens";

type ThemeColors = PluginSurfaceProps["theme"]["colors"];

/** A filter that opens its options, with the current one checked, instead of cycling on each press. */
export function ChoiceMenu<T extends string>({
  title,
  label,
  value,
  options,
  onChange,
  active,
  c,
}: {
  title: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
  /** Filled pill when the choice is narrower than the default. */
  active?: boolean;
  c: ThemeColors;
}) {
  const s = surfaces(c);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setOpen(true)} style={s.pill(!!active)}>
        <Text style={s.pillText(!!active)}>{label}</Text>
      </Pressable>
      <Modal title={title} open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <View style={{ gap: space.xs }}>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.sm,
                    paddingVertical: 10,
                    paddingHorizontal: space.sm,
                    borderRadius: radius.md,
                    backgroundColor: selected ? c.surface2 : "transparent",
                  }}
                >
                  <View style={{ width: 16, alignItems: "center" }}>
                    {selected ? <Icon name="Check" size={14} color={c.accent} /> : null}
                  </View>
                  <Text style={{ ...font.body, fontWeight: selected ? weight.semibold : weight.regular, color: c.foreground }}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
