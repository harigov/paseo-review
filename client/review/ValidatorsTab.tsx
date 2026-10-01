import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  validatorsDismissRpc,
  validatorsListRpc,
  validatorsSaveRpc,
  validatorsTestRpc,
  validatorsToggleRpc,
} from "../../shared/rpc";
import { ValidatorResultSchema, type ValidatorFinding, type ValidatorResult } from "../../shared/types";
import type { PrTabContext } from "../pr/tab-props";
import { useJobRunner } from "../data/hooks";
import { addDraft } from "./drafts";
import { ExplainAction, type ExplainResult } from "./Explain";
import { validatorScoreboard, ValidatorResultsList } from "./ValidatorResultsList";
import { Chip, riskColor } from "../ui/chips";
import { font, space, surfaces } from "../ui/tokens";
import { Skeleton } from "../ui/states";

const TEMPLATE = `---
title: New validator
severity: warning
unit: hunk
threshold: 0.8
violation: Describe the condition that should be flagged
compliant: Describe what a compliant change looks like
not_applicable: Describe when this validator does not apply
---
Ask a single, direct yes/no question about the change here.
`;

const TestJobResultSchema = z.object({ result: ValidatorResultSchema });

const SEVERITY_COLOR: Record<ValidatorResult["severity"], (c: Parameters<typeof riskColor>[1]) => string> = {
  blocking: (c) => c.statusDanger,
  warning: (c) => c.statusWarning,
  info: (c) => c.foregroundMuted,
};

function extractTitle(markdown: string): string {
  const match = markdown.split("\n").find((line) => /^title:\s*.+$/.test(line));
  return match ? match.replace(/^title:\s*/, "").trim().replace(/^"|"$/g, "") : "New validator";
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "validator";
}

export function ValidatorsTab(props: PrTabContext) {
  const { repo, number, theme, analysis, refresh, openTab } = props;
  const c = theme.colors;
  const s = surfaces(c);
  const toast = useToast();
  const queryClient = useQueryClient();

  const dismissRpc = useRpc(validatorsDismissRpc);
  const listRpc = useRpc(validatorsListRpc);
  const toggleRpc = useRpc(validatorsToggleRpc);
  const testRpc = useRpc(validatorsTestRpc);
  const saveRpc = useRpc(validatorsSaveRpc);
  const testJob = useJobRunner();

  const [explanations, setExplanations] = useState<Record<string, ExplainResult>>({});
  const [newValidatorOpen, setNewValidatorOpen] = useState(false);
  const [draftMarkdown, setDraftMarkdown] = useState(TEMPLATE);
  const [testResult, setTestResult] = useState<ValidatorResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const manageQuery = useQuery({
    queryKey: ["prr.validators", repo],
    queryFn: () => listRpc({ repo }),
  });

  async function toggle(validatorId: string, enabled: boolean) {
    queryClient.setQueryData(["prr.validators", repo], (old: Awaited<ReturnType<typeof listRpc>> | undefined) =>
      old ? { ...old, validators: old.validators.map((v) => (v.id === validatorId ? { ...v, enabled } : v)) } : old,
    );
    try {
      await toggleRpc({ repo, validatorId, enabled });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to toggle validator");
    } finally {
      // The server may recompute enabled-validator-derived state; refresh both the manage
      // list and the PR's analysis (scoreboard/findings) so neither goes stale.
      manageQuery.refetch();
      refresh();
    }
  }

  async function dismiss(result: ValidatorResult, finding: ValidatorFinding) {
    try {
      await dismissRpc({ repo, number, validatorId: result.validatorId, unitKey: finding.unitKey });
      toast.show("Dismissed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to dismiss");
    } finally {
      refresh();
      manageQuery.refetch();
    }
  }

  function draftComment(result: ValidatorResult, finding: ValidatorFinding) {
    if (!finding.path || finding.startLine === null) {
      toast.error("No line to comment on");
      return;
    }
    const explanation = explanations[`${result.validatorId}|${finding.unitKey}`]?.explanation;
    const body = `**${result.title}** (${Math.round(finding.probability * 100)}%)\n\n${finding.excerpt}${explanation ? `\n\n${explanation}` : ""}`;
    addDraft(repo, number, analysis?.headSha ?? "", { path: finding.path, line: finding.startLine, side: "RIGHT", body });
    toast.show("Draft comment added");
  }

  function openFile(finding: ValidatorFinding) {
    const moduleId = analysis?.files.find((file) => file.path === finding.path)?.moduleId;
    openTab(moduleId ? `module:${moduleId}` : "overview");
  }

  async function testValidator() {
    setTesting(true);
    try {
      const finished = await testJob.run(() => testRpc({ repo, number, markdown: draftMarkdown }));
      if (finished.status === "error") {
        toast.error(finished.error ?? "Test failed");
        return;
      }
      const parsed = TestJobResultSchema.safeParse(finished.result);
      if (!parsed.success) {
        toast.error("Test returned an unexpected result");
        return;
      }
      setTestResult(parsed.data.result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  async function saveValidator(target: "repo" | "personal") {
    setSaving(true);
    try {
      const title = extractTitle(draftMarkdown);
      await saveRpc({ repo, target, fileName: `${slugify(title)}.md`, markdown: draftMarkdown });
      toast.show(`Saved to ${target === "repo" ? "repo" : "your library"}`);
      setNewValidatorOpen(false);
      manageQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!analysis) return <Skeleton theme={theme} rows={5} />;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <View style={{ gap: space.xs }}>
        <Text style={{ ...font.body, color: c.foreground }}>{validatorScoreboard(analysis.validators)}</Text>
        {!analysis.decisionsEnabled ? (
          <Text style={{ ...font.caption, color: c.statusWarning }}>Decision model off for this repo.</Text>
        ) : null}
      </View>

      <ValidatorResultsList
        results={analysis.validators}
        theme={theme}
        renderFindingActions={(result, finding) => (
          <>
            <Pressable accessibilityRole="button" onPress={() => openFile(finding)}>
              <Text style={{ ...font.caption, color: c.accent }}>Open file</Text>
            </Pressable>
            <ExplainAction
              repo={repo}
              number={number}
              target={`validator:${result.validatorId}|${finding.unitKey}`}
              theme={theme}
              onExplained={(res) => setExplanations((prev) => ({ ...prev, [`${result.validatorId}|${finding.unitKey}`]: res }))}
            />
            <Pressable accessibilityRole="button" onPress={() => draftComment(result, finding)}>
              <Text style={{ ...font.caption, color: c.accent }}>Draft comment</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => dismiss(result, finding)}>
              <Text style={{ ...font.caption, color: c.foregroundMuted }}>Dismiss</Text>
            </Pressable>
          </>
        )}
      />

      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ ...font.title, color: c.foreground }}>Manage validators</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setDraftMarkdown(TEMPLATE);
              setTestResult(null);
              setNewValidatorOpen(true);
            }}
            style={{ flexDirection: "row", gap: space.xs, alignItems: "center" }}
          >
            <Icon name="Plus" size={13} color={c.accent} />
            <Text style={{ ...font.small, color: c.accent }}>New validator</Text>
          </Pressable>
        </View>
        {(manageQuery.data?.validators ?? []).length === 0 ? (
          <Text style={{ ...font.small, color: c.foregroundMuted }}>No validators found under .paseo/validators.</Text>
        ) : (
          <View style={s.card}>
            {(manageQuery.data?.validators ?? []).map((validator, index) => (
              <View key={validator.id}>
                {index > 0 ? <View style={{ ...s.hairline, marginBottom: space.sm }} /> : null}
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Switch value={validator.enabled} onValueChange={(value) => toggle(validator.id, value)} />
                  <Text style={{ ...font.small, color: c.foreground, flex: 1 }} numberOfLines={1}>
                    {validator.title}
                  </Text>
                  <Chip label={validator.severity} color={SEVERITY_COLOR[validator.severity](c)} />
                  <Chip label={validator.source} color={c.foregroundMuted} />
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      <Modal title="New validator" open={newValidatorOpen} onOpenChange={setNewValidatorOpen}>
        <Modal.Content>
          <View style={{ gap: space.md }}>
            <TextInput
              value={draftMarkdown}
              onChangeText={setDraftMarkdown}
              multiline
              style={{ ...s.input, minHeight: 220, fontFamily: "monospace" }}
            />
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              <Pressable accessibilityRole="button" disabled={testing} onPress={testValidator} style={s.buttonQuiet}>
                <Text style={s.buttonQuietText}>{testing ? `Testing… ${testJob.job?.stage ?? ""}` : "Test on this PR"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={saving} onPress={() => saveValidator("repo")} style={s.button}>
                <Text style={s.buttonText}>Save to repo</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={saving} onPress={() => saveValidator("personal")} style={s.buttonQuiet}>
                <Text style={s.buttonQuietText}>Save to my library</Text>
              </Pressable>
            </View>
            {testResult ? (
              <View style={{ gap: space.xs }}>
                <Text style={{ ...font.caption, color: c.foregroundMuted }}>Result: {testResult.status}</Text>
                {testResult.findings.map((finding, index) => (
                  <Text key={index} style={{ ...font.caption, color: c.foreground }}>
                    {finding.path ?? "pr"}:{finding.startLine ?? "-"} — {Math.round(finding.probability * 100)}%
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}
