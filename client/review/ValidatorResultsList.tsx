import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ValidatorFinding, ValidatorResult } from "../../shared/types";

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
}: {
  result: ValidatorResult;
  finding: ValidatorFinding;
  theme: PluginSurfaceProps["theme"];
  renderFindingActions?: (result: ValidatorResult, finding: ValidatorFinding) => ReactNode;
}) {
  const c = theme.colors;
  const location = finding.path ? `${finding.path}${finding.startLine ? `:${finding.startLine}` : ""}` : "(PR-level)";
  return (
    <View style={{ gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderTopWidth: 1, borderColor: c.border }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: c.foreground, fontSize: 12 }}>{location}</Text>
        <Text style={{ color: finding.status === "fail" ? c.statusDanger : c.statusWarning, fontSize: 12, fontWeight: "600" }}>
          {Math.round(finding.probability * 100)}%
        </Text>
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace" }} numberOfLines={4}>
        {finding.excerpt}
      </Text>
      {finding.dismissed ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>Dismissed</Text> : null}
      {renderFindingActions ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>{renderFindingActions(result, finding)}</View>
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
  const [expanded, setExpanded] = useState(defaultExpanded);
  const color = result.status === "fail" ? c.statusDanger : result.status === "uncertain" ? c.statusWarning : c.foregroundMuted;
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 6, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 10, backgroundColor: c.surface1 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
          <Text style={{ color, fontSize: 13 }}>{statusGlyph(result.status)}</Text>
          <Text style={{ color: c.foreground, fontSize: 13, flex: 1 }} numberOfLines={1}>
            {result.title}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{result.severity}</Text>
        </View>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
      </Pressable>
      {expanded ? (
        result.findings.length > 0 ? (
          result.findings.map((finding, index) => (
            <FindingRow key={`${finding.unitKey}-${index}`} result={result} finding={finding} theme={theme} renderFindingActions={renderFindingActions} />
          ))
        ) : (
          <Text style={{ color: c.foregroundMuted, fontSize: 11, padding: 10 }}>
            {result.error ?? `${result.unitsApplicable} of ${result.unitsEvaluated} units applicable, no findings.`}
          </Text>
        )
      ) : null}
    </View>
  );
}

function CollapsedSection({ title, results, theme }: { title: string; results: ValidatorResult[]; theme: PluginSurfaceProps["theme"] }) {
  const c = theme.colors;
  const [expanded, setExpanded] = useState(false);
  if (results.length === 0) return null;
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 6, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 8, backgroundColor: c.surface1 }}
      >
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {title} ({results.length})
        </Text>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={13} color={c.foregroundMuted} />
      </Pressable>
      {expanded
        ? results.map((result) => (
            <Text key={result.validatorId} style={{ color: c.foregroundMuted, fontSize: 11, padding: 8, borderTopWidth: 1, borderColor: c.border }}>
              {result.title}
            </Text>
          ))
        : null}
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

  return (
    <View style={{ gap: 8 }}>
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
