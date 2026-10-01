import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ValidatorFinding, ValidatorResult } from "../../shared/types";
import { font, space, surfaces, weight } from "../ui/tokens";
import { EmptyState } from "../ui/states";

const SEVERITY_WEIGHT: Record<ValidatorResult["severity"], number> = { blocking: 0, warning: 1, info: 2 };

function statusGlyph(status: ValidatorResult["status"]): string {
  switch (status) {
    case "fail":
      return "✗";
    case "uncertain":
      return "?";
    case "pass":
      return "✓";
    case "na":
      return "—";
    default:
      return "!";
  }
}

/** Scoreboard line, e.g. "✓ 31 · ✗ 2 · ? 1 · — 9 n/a". */
export function validatorScoreboard(results: ValidatorResult[]): string {
  const counts = { pass: 0, fail: 0, uncertain: 0, na: 0, error: 0 };
  results.forEach((result) => {
    counts[result.status] += 1;
  });
  const parts = [`✓ ${counts.pass}`, `✗ ${counts.fail}`, `? ${counts.uncertain}`, `— ${counts.na} n/a`];
  if (counts.error > 0) parts.push(`! ${counts.error} error`);
  return parts.join(" · ");
}

function FindingRow({
  result,
  finding,
  theme,
  renderFindingActions,
  isFirst,
}: {
  result: ValidatorResult;
  finding: ValidatorFinding;
  theme: PluginSurfaceProps["theme"];
  renderFindingActions?: (result: ValidatorResult, finding: ValidatorFinding) => ReactNode;
  isFirst: boolean;
}) {
  const c = theme.colors;
  const s = surfaces(c);
  const location = finding.path ? `${finding.path}${finding.startLine ? `:${finding.startLine}` : ""}` : "(PR-level)";
  return (
    <View style={{ gap: space.xs, paddingTop: space.sm }}>
      {!isFirst ? <View style={{ ...s.hairline, marginBottom: space.sm }} /> : null}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ ...font.small, color: c.foreground }}>{location}</Text>
        <Text style={{ ...font.small, fontWeight: weight.semibold, color: finding.status === "fail" ? c.statusDanger : c.statusWarning }}>
          {Math.round(finding.probability * 100)}%
        </Text>
      </View>
      <Text style={{ ...font.caption, color: c.foregroundMuted, fontFamily: "monospace" }} numberOfLines={4}>
        {finding.excerpt}
      </Text>
      {finding.dismissed ? <Text style={{ ...font.caption, color: c.foregroundMuted }}>Dismissed</Text> : null}
      {renderFindingActions ? (
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: 2 }}>{renderFindingActions(result, finding)}</View>
      ) : null}
    </View>
  );
}

function ResultGroup({
  result,
  theme,
  defaultExpanded,
  renderFindingActions,
}: {
  result: ValidatorResult;
  theme: PluginSurfaceProps["theme"];
  defaultExpanded: boolean;
  renderFindingActions?: (result: ValidatorResult, finding: ValidatorFinding) => ReactNode;
}) {
  const c = theme.colors;
  const s = surfaces(c);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const color = result.status === "fail" ? c.statusDanger : result.status === "uncertain" ? c.statusWarning : c.foregroundMuted;
  return (
    <View style={s.card}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: 1 }}>
          <Text style={{ ...font.small, color }}>{statusGlyph(result.status)}</Text>
          <Text style={{ ...font.body, color: c.foreground, flex: 1 }} numberOfLines={1}>
            {result.title}
          </Text>
          <Text style={{ ...font.caption, color: c.foregroundMuted }}>{result.severity}</Text>
        </View>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
      </Pressable>
      {expanded ? (
        result.findings.length > 0 ? (
          <View>
            {result.findings.map((finding, index) => (
              <FindingRow
                key={`${finding.unitKey}-${index}`}
                result={result}
                finding={finding}
                theme={theme}
                renderFindingActions={renderFindingActions}
                isFirst={index === 0}
              />
            ))}
          </View>
        ) : (
          <Text style={{ ...font.caption, color: c.foregroundMuted, paddingTop: space.sm }}>
            {result.error ?? `${result.unitsApplicable} of ${result.unitsEvaluated} units applicable, no findings.`}
          </Text>
        )
      ) : null}
    </View>
  );
}

function CollapsedSection({ title, results, theme }: { title: string; results: ValidatorResult[]; theme: PluginSurfaceProps["theme"] }) {
  const c = theme.colors;
  const s = surfaces(c);
  const [expanded, setExpanded] = useState(false);
  if (results.length === 0) return null;
  return (
    <View style={s.card}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
      >
        <Text style={{ ...font.small, color: c.foregroundMuted }}>
          {title} ({results.length})
        </Text>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={13} color={c.foregroundMuted} />
      </Pressable>
      {expanded ? (
        <View style={{ marginTop: space.sm }}>
          {results.map((result, index) => (
            <View key={result.validatorId} style={{ paddingVertical: space.xs }}>
              {index > 0 ? <View style={{ ...s.hairline, marginBottom: space.xs }} /> : null}
              <Text style={{ ...font.caption, color: c.foregroundMuted }}>{result.title}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Shared results renderer for the Validators tab and the local-branch validate panel. */
export function ValidatorResultsList({
  results,
  theme,
  renderFindingActions,
}: {
  results: ValidatorResult[];
  theme: PluginSurfaceProps["theme"];
  renderFindingActions?: (result: ValidatorResult, finding: ValidatorFinding) => ReactNode;
}) {
  const fail = results
    .filter((result) => result.status === "fail")
    .sort((a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity]);
  const uncertain = results.filter((result) => result.status === "uncertain");
  const pass = results.filter((result) => result.status === "pass");
  const na = results.filter((result) => result.status === "na");
  const errored = results.filter((result) => result.status === "error");

  if (results.length === 0) {
    return (
      <EmptyState
        theme={theme}
        icon="ShieldCheck"
        title="No validators enabled"
        hint="Add or enable validators under .paseo/validators to see results here."
      />
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      {fail.map((result) => (
        <ResultGroup key={result.validatorId} result={result} theme={theme} defaultExpanded renderFindingActions={renderFindingActions} />
      ))}
      {uncertain.map((result) => (
        <ResultGroup key={result.validatorId} result={result} theme={theme} defaultExpanded renderFindingActions={renderFindingActions} />
      ))}
      <CollapsedSection title="Errored" results={errored} theme={theme} />
      <CollapsedSection title="Passed" results={pass} theme={theme} />
      <CollapsedSection title="Not applicable" results={na} theme={theme} />
    </View>
  );
}
