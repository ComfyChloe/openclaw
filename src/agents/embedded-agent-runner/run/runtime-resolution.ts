import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../defaults.js";
import { normalizeModelRef, normalizeProviderId } from "../../model-ref-shared.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../model-selection.js";
import { resolveThinkingDefault } from "../../model-thinking-default.js";
import { OPENAI_PROVIDER_ID } from "../../openai-routing.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export const CODEX_HARNESS_ID = "codex";
const OPENAI_RESPONSES_API = "openai-responses";
const OPENAI_CODEX_RESPONSES_API = "openai-chatgpt-responses";

function normalizeRuntimeId(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function resolveAttemptTrajectoryAttribution(params: {
  model: { api?: string; provider?: string };
  modelId: string;
  provider: string;
  runtimePlan: {
    auth?: Pick<AgentRuntimePlan["auth"], "authProfileProviderForAuth">;
    observability?: Pick<AgentRuntimePlan["observability"], "harnessId">;
  };
}): { modelApi?: string; modelId: string; provider: string } {
  const authProfileProvider = normalizeRuntimeId(
    params.runtimePlan.auth?.authProfileProviderForAuth,
  );
  const harnessId = normalizeRuntimeId(params.runtimePlan.observability?.harnessId);
  if (
    harnessId === CODEX_HARNESS_ID &&
    authProfileProvider !== OPENAI_PROVIDER_ID &&
    normalizeRuntimeId(params.model.provider) === OPENAI_PROVIDER_ID &&
    normalizeRuntimeId(params.model.api) === OPENAI_RESPONSES_API
  ) {
    return {
      modelApi: OPENAI_CODEX_RESPONSES_API,
      modelId: params.modelId,
      provider: OPENAI_PROVIDER_ID,
    };
  }
  return {
    ...(params.model.api ? { modelApi: params.model.api } : {}),
    modelId: params.modelId,
    provider: params.provider,
  };
}

export function resolveInitialThinkLevel(params: {
  requested?: ThinkLevel;
  config?: RunEmbeddedAgentParams["config"];
  provider: string;
  modelId: string;
  model: { reasoning?: boolean };
}): ThinkLevel {
  if (params.requested) {
    return params.requested;
  }
  return resolveThinkingDefault({
    cfg: params.config ?? {},
    provider: params.provider,
    model: params.modelId,
    catalog: [
      {
        provider: params.provider,
        id: params.modelId,
        name: params.modelId,
        reasoning: params.model.reasoning,
      },
    ],
  });
}

/** Marks only request parameters that OpenClaw applies to provider egress. */
export function resolveRequestStreamTransportOverrides(
  streamParams: RunEmbeddedAgentParams["streamParams"],
): "present" | undefined {
  return streamParams && Object.keys(streamParams).length > 0 ? "present" : undefined;
}

export function resolveInitialEmbeddedRunModel(params: {
  config: RunEmbeddedAgentParams["config"];
  agentId?: string;
  provider?: string;
  model?: string;
  requestedRouteResolution?: RunEmbeddedAgentParams["requestedRouteResolution"];
  normalization?: Parameters<typeof normalizeModelRef>[2];
}): { provider: string; modelId: string } {
  const explicitProvider = normalizeProviderId(params.provider ?? "") || undefined;
  const explicitModel = normalizeOptionalString(params.model);
  // Preliminary route identification stays static; prepared metadata owns
  // plugin and workspace normalization once the runtime context exists.
  const normalization =
    params.normalization ??
    ({
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    } as const);
  if (explicitProvider && explicitModel) {
    const selected =
      params.requestedRouteResolution === "resolved"
        ? { provider: explicitProvider, model: explicitModel }
        : normalizeModelRef(explicitProvider, explicitModel, normalization);
    return { provider: selected.provider, modelId: selected.model };
  }
  const cfg = params.config ?? {};
  const configuredDefault = resolveDefaultModelForAgent({
    cfg,
    agentId: params.agentId,
    ...normalization,
  });
  const defaultProvider = configuredDefault.provider || DEFAULT_PROVIDER;

  if (explicitModel) {
    const provider = explicitProvider ?? defaultProvider;
    const aliasIndex = buildModelAliasIndex({
      cfg,
      agentId: params.agentId,
      defaultProvider: provider,
      ...normalization,
    });
    const resolved = resolveModelRefFromString({
      cfg,
      agentId: params.agentId,
      raw: explicitModel,
      defaultProvider: provider,
      aliasIndex,
      ...normalization,
    });
    return {
      provider: explicitProvider ?? resolved?.ref.provider ?? provider,
      modelId: resolved?.ref.model ?? explicitModel,
    };
  }

  return {
    provider: explicitProvider ?? defaultProvider,
    modelId: configuredDefault.model || DEFAULT_MODEL,
  };
}
