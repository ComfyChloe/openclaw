import { resolveClaudeOpus5ModelIdentity } from "@openclaw/llm-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveThinkingDefaultForModel } from "../auto-reply/thinking.js";
import { normalizeThinkLevel, type ThinkLevel } from "../auto-reply/thinking.shared.js";
import { resolveAgentModelConfigValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderThinkingPolicySource } from "../plugins/provider-thinking.types.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";
import { modelKey, normalizeProviderId } from "./model-ref-shared.js";
import { normalizeModelSelection } from "./model-selection-resolve.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";

type ThinkingDefaultParams = {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
  agentRuntime?: string | null;
  agentId?: string;
};

function resolveConfiguredModelThinkingDefault(raw: unknown): ThinkLevel | undefined {
  if (raw === false || raw === "disabled" || raw === "none") {
    return "off";
  }
  return typeof raw === "string" ? normalizeThinkLevel(raw) : undefined;
}

export function resolveConfiguredThinkingDefaultCore(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
}): ThinkLevel | undefined {
  const { modelParams, agentModelParams } = resolveModelExtraParamSources({
    config: params.cfg,
    provider: params.provider,
    modelId: params.model,
    agentId: params.agentId,
  });
  return (
    resolveConfiguredModelThinkingDefault(agentModelParams?.thinking ?? modelParams?.thinking) ??
    params.cfg.agents?.defaults?.thinkingDefault
  );
}

export function resolveThinkingDefaultCore(
  params: ThinkingDefaultParams & {
    providerPolicySource?: ProviderThinkingPolicySource;
  },
): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const normalizedModel = normalizeLowercaseStringOrEmpty(params.model).replace(/\./g, "-");
  const catalog = Array.isArray(params.catalog)
    ? params.catalog
    : buildConfiguredModelCatalog({ cfg: params.cfg });
  const catalogCandidate = catalog.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const configured = resolveConfiguredThinkingDefaultCore(params);
  if (configured) {
    return configured;
  }
  const isClaudeProvider =
    normalizedProvider === "anthropic" ||
    normalizedProvider === "anthropic-vertex" ||
    normalizedProvider === "claude-cli";
  if (isClaudeProvider && resolveClaudeOpus5ModelIdentity({ id: normalizedModel })) {
    return "high";
  }
  if (
    isClaudeProvider &&
    (normalizedModel.startsWith("claude-opus-4-8") || normalizedModel.startsWith("claude-opus-4-7"))
  ) {
    return "off";
  }
  if (
    normalizedProvider === "anthropic" &&
    typeof catalogCandidate?.name === "string" &&
    /4\.6\b/.test(catalogCandidate.name) &&
    (normalizedModel.startsWith("claude-opus-4-6") ||
      normalizedModel.startsWith("claude-sonnet-4-6"))
  ) {
    const configuredModels = { ...params.cfg.agents?.defaults?.models };
    const primarySelection = normalizeModelSelection(params.cfg.agents?.defaults?.model);
    // The primary is another authored ref: share the config owner's exact
    // model casing and provider-supported aliases when checking its presence.
    if (primarySelection) {
      const primaryKey = primarySelection.includes("/")
        ? primarySelection
        : modelKey(normalizedProvider, primarySelection);
      configuredModels[primaryKey] ??= {};
    }
    if (resolveAgentModelConfigValue(configuredModels, params.provider, params.model, () => true)) {
      return "adaptive";
    }
  }
  return resolveThinkingDefaultForModel({
    provider: params.provider,
    model: params.model,
    catalog,
    agentRuntime: params.agentRuntime,
    providerPolicySource: params.providerPolicySource,
  });
}
