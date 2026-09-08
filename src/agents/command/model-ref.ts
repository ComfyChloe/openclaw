import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelFallbackRouteResolution } from "../model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { parseConfiguredModelRef } from "../model-selection-shared.js";
import {
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../model-selection.js";

export function normalizeAgentCommandModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: ModelManifestNormalizationContext,
  requestedRouteResolution?: ModelFallbackRouteResolution,
) {
  if (requestedRouteResolution === "resolved") {
    return { provider: normalizeProviderId(provider), model: model.trim() };
  }
  const ref = parseConfiguredModelRef({
    cfg,
    raw: modelKey(provider, model),
    defaultProvider: provider,
    ...modelManifestContext,
  });
  if (!ref) {
    throw new Error("Invalid model override.");
  }
  return ref;
}

export function parseAgentCommandModelRef(
  cfg: OpenClawConfig,
  agentId: string,
  raw: string,
  defaultProvider: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  return (
    resolveModelRefFromString({
      cfg,
      agentId,
      raw,
      defaultProvider,
      aliasIndex: buildModelAliasIndex({
        cfg,
        agentId,
        defaultProvider,
        ...modelManifestContext,
      }),
      ...modelManifestContext,
    })?.ref ?? null
  );
}
