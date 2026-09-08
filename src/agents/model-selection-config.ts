/** Pure configured-model selection helpers safe for config validation. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { normalizeModelSelection, resolveConfiguredModelRef } from "./model-selection-shared.js";

export function resolveDefaultModelForAgent(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  return resolveConfiguredModelRef({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowManifestNormalization: params.allowManifestNormalization,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
    resolvedModelCatalog: params.resolvedModelCatalog,
  });
}

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeAgentPrimary?: boolean;
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  return (
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    (params.includeAgentPrimary === false ? undefined : normalizeModelSelection(agentConfig?.model))
  );
}

/** Select authored spawn input without turning aliases into execution identities. */
export function resolveSubagentSpawnModelInput(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    modelOverride?: unknown;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): string {
  const raw =
    normalizeModelSelection(params.modelOverride) ??
    resolveSubagentConfiguredModelSelection(params) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.model);
  if (raw) {
    return raw;
  }
  const fallback = resolveDefaultModelForAgent(params);
  return `${fallback.provider}/${fallback.model}`;
}
