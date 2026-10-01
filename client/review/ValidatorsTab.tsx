import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  validatorsDismissRpc,
  validatorsListRpc,
  validatorsSaveRpc,
  validatorsTestRpc,
  validatorsToggleRpc,
} from "../../shared/rpc";
import type { ValidatorFinding, ValidatorResult } from "../../shared/types";
import type { PrTabContext } from "../pr/tab-props";
import { addDraft } from "./drafts";
import { ExplainAction, type ExplainResult } from "./Explain";
import { validatorScoreboard, ValidatorResultsList } from "./ValidatorResultsList";

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
  const toast = useToast();
  const queryClient = useQueryClient();

  const dismissRpc = useRpc(validatorsDismissRpc);
  const listRpc = useRpc(validatorsListRpc);
  const toggleRpc = useRpc(validatorsToggleRpc);
  const testRpc = useRpc(validatorsTestRpc);
  const saveRpc = useRpc(validatorsSaveRpc);

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
      manageQuery.refetch();
    }
  }

  async function dismiss(result: ValidatorResult, finding: ValidatorFinding) {
    try {
      await dismissRpc({ repo, number, validatorId: result.validatorId, unitKey: finding.unitKey });
      toast.show("Dismissed");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to dismiss");
    }
  }

  function draftComment(result: ValidatorResult, finding: ValidatorFinding) {
    if (!finding.path || finding.startLine === null) {
      toast.error("No line to comment on");
      return;
    }
    const explanation = explanations[`${result.validatorId}|${finding.unitKey}`]?.explanation;
    const body = `**${result.title}** (${Math.round(finding.probability * 100)}%)\n\n${finding.excerpt}${explanation ? `\n\n${explanation}` : ""}`;
    addDraft(repo, number, { path: finding.path, line: finding.startLine, side: "RIGHT", body });
    toast.show("Draft comment added");
  }

  function openFile(finding: ValidatorFinding) {
    const moduleId = analysis?.files.find((file) => file.path === finding.path)?.moduleId;
    openTab(moduleId ? `module:${moduleId}` : "overview");
  }

  async function testValidator() {
    setTesting(true);
    try {
      const { result } = await testRpc({ repo, number, markdown: draftMarkdown });
      setTestResult(result);
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

  if (!analysis) return <Text style={{ color: c.foregroundMuted, padding: 16 }}>Loading validators…</Text>;

  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: c.foreground, fontSize: 13 }}>{validatorScoreboard(analysis.validators)}</Text>
        {!analysis.decisionsEnabled ? (
          <Text style={{ color: c.statusWarning, fontSize: 11 }}>Decision model off for this repo.</Text>
        ) : null}
      </View>

      <ValidatorResultsList
        results={analysis.validators}
        theme={theme}
        renderFindingActions={(result, finding) => (
          <>
            <Pressable accessibilityRole="button" onPress={() => openFile(finding)}>
              <Text style={{ color: c.accent, fontSize: 11 }}>Open file</Text>
            </Pressable>
            <ExplainAction
              repo={repo}
              number={number}
              target={`validator:${result.validatorId}|${finding.unitKey}`}
              theme={theme}
              onExplained={(res) => setExplanations((prev) => ({ ...prev, [`${result.validatorId}|${finding.unitKey}`]: res }))}
            />
            <Pressable accessibilityRole="button" onPress={() => draftComment(result, finding)}>
              <Text style={{ color: c.accent, fontSize: 11 }}>Draft comment</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => dismiss(result, finding)}>
              <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>Dismiss</Text>
            </Pressable>
          </>
        )}
      />

      <View style={{ gap: 8, borderTopWidth: 1, borderColor: c.border, paddingTop: 12 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>Manage validators</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setDraftMarkdown(TEMPLATE);
              setTestResult(null);
              setNewValidatorOpen(true);
            }}
            style={{ flexDirection: "row", gap: 4, alignItems: "center" }}
          >
            <Icon name="Plus" size={13} color={c.accent} />
            <Text style={{ color: c.accent, fontSize: 12 }}>New validator</Text>
          </Pressable>
        </View>
        {(manageQuery.data?.validators ?? []).map((validator) => (
          <View
            key={validator.id}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}
          >
            <Switch value={validator.enabled} onValueChange={(value) => toggle(validator.id, value)} />
            <Text style={{ color: c.foreground, fontSize: 12, flex: 1 }} numberOfLines={1}>
              {validator.title}
            </Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{validator.severity}</Text>
            <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 4, paddingHorizontal: 5 }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{validator.source}</Text>
            </View>
          </View>
        ))}
      </View>

      <Modal title="New validator" open={newValidatorOpen} onOpenChange={setNewValidatorOpen}>
        <Modal.Content>
          <View style={{ gap: 10 }}>
            <TextInput
              value={draftMarkdown}
              onChangeText={setDraftMarkdown}
              multiline
              style={{
                minHeight: 220,
                color: c.foreground,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 6,
                padding: 8,
                fontSize: 12,
                fontFamily: "monospace",
              }}
            />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Pressable
                accessibilityRole="button"
                disabled={testing}
                onPress={testValidator}
                style={{ paddingVertical: 6, paddingHorizontal: 10, backgroundColor: c.surface2, borderRadius: 6 }}
              >
                <Text style={{ color: c.foreground, fontSize: 12 }}>{testing ? "Testing…" : "Test on this PR"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={saving}
                onPress={() => saveValidator("repo")}
                style={{ paddingVertical: 6, paddingHorizontal: 10, backgroundColor: c.accent, borderRadius: 6 }}
              >
                <Text style={{ color: c.accentForeground, fontSize: 12 }}>Save to repo</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={saving}
                onPress={() => saveValidator("personal")}
                style={{ paddingVertical: 6, paddingHorizontal: 10, backgroundColor: c.surface2, borderRadius: 6 }}
              >
                <Text style={{ color: c.foreground, fontSize: 12 }}>Save to my library</Text>
              </Pressable>
            </View>
            {testResult ? (
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>Result: {testResult.status}</Text>
                {testResult.findings.map((finding, index) => (
                  <Text key={index} style={{ color: c.foreground, fontSize: 11 }}>
                    {finding.path ?? "pr"}:{finding.startLine ?? "-"} — {Math.round(finding.probability * 100)}%
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
