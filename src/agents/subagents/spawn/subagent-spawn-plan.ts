/**
 * Subagent spawn planning helpers.
 *
 * Resolves model, thinking, and timeout choices before the sessions_spawn executor launches work.
 */
import type { Result } from "@openclaw/normalization-core/result";
import { formatThinkingLevels } from "../../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import { splitTrailingAuthProfile } from "../../model-ref-profile.js";
import type { ModelRef } from "../../model-ref-shared.js";
import {
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelInput,
} from "../../model-selection-config.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

/** Splits a provider/model ref while preserving model-only refs. */
export function splitModelRef(ref?: string) {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1
    ? { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
    : { provider: undefined, model: trimmed };
}

/** Resolves the effective subagent run timeout from per-call override or config default. */
export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

/** Resolves the subagent model plus thinking patch to apply to the spawned session. */
export async function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
  fastMode?: FastMode;
  resolveModel: (input: string) => Promise<Result<ModelRef, string>>;
}) {
  const rawModel = resolveSubagentSpawnModelInput({
    cfg: params.cfg,
    agentId: params.targetAgentId,
    modelOverride: params.modelOverride,
  });
  const { model: modelInput, profile: authProfileId } = splitTrailingAuthProfile(rawModel);

  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    requesterAgentConfig: params.requesterAgentConfig,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw,
    callerThinkingRaw: params.callerThinkingRaw,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model } = splitModelRef(modelInput);
    // The hint is provider/model-specific because valid thinking levels vary by backend.
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  const selected = await params.resolveModel(modelInput);
  if (!selected.ok) {
    return { status: "error" as const, error: selected.error };
  }
  const { provider, model } = selected.value;
  const resolvedModel = `${provider}/${model}`;
  const modelOverrideSource: "user" | "auto" = params.modelOverride?.trim() ? "user" : "auto";
  const hasConfiguredAutoModel =
    modelOverrideSource === "auto" &&
    Boolean(
      resolveSubagentConfiguredModelSelection({
        cfg: params.cfg,
        agentId: params.targetAgentId,
      }),
    );
  return {
    status: "ok" as const,
    resolvedModel,
    modelSelection: selected.value,
    modelApplied: true,
    thinkingOverride: thinkingPlan.thinkingOverride,
    initialSessionPatch: {
      modelProvider: provider,
      model,
      providerOverride: provider,
      modelOverride: model,
      modelOverrideSource,
      modelOverrideRouteResolution: "resolved" as const,
      ...(hasConfiguredAutoModel
        ? {
            // The admitted pair owns both the pin and its self-origin fallback provenance.
            modelOverrideFallbackOriginProvider: provider,
            modelOverrideFallbackOriginModel: model,
          }
        : {}),
      ...(authProfileId
        ? {
            authProfileOverride: authProfileId,
            authProfileOverrideSource: "user" as const,
          }
        : {}),
      ...thinkingPlan.initialSessionPatch,
      ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    },
  };
}
