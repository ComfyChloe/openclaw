/**
 * Model selection resolution facade.
 *
 * This module resolves configured fallbacks and explicit model selections.
 */
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelFallbacksOverride } from "./agent-scope.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  getModelRefStatus,
  resolveAllowedModelRefFromAliasIndex,
} from "./model-selection-shared.js";

export {
  buildModelAliasIndex,
  getModelRefStatus,
  normalizeModelSelection,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveModelAliasFromPair,
  resolveModelRefFromString,
} from "./model-selection-shared.js";

/** Resolve agent-owned fallback overrides without loading the full selection facade. */
export function resolveConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string[] {
  if (params.agentId) {
    const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}

/** Resolves a raw model string into an allowed model ref or an explanatory error. */
export function resolveAllowedModelRefCore(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    raw: string;
    defaultProvider: string;
    defaultModel?: string;
    /** Resolved authorization default, separate from raw-input parsing. */
    defaultRef?: ModelRef;
    agentId?: string;
  } & ModelManifestNormalizationContext,
):
  | { ref: ModelRef; key: string }
  | {
      error: string;
    } {
  const selectionScope = {
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    manifestPlugins: params.manifestPlugins,
    resolvedModelCatalog: params.resolvedModelCatalog ?? params.catalog,
  };
  return resolveAllowedModelRefFromAliasIndex({
    ...selectionScope,
    raw: params.raw,
    aliasIndex: buildModelAliasIndex(selectionScope),
    getStatus: (ref) =>
      getModelRefStatus({
        ...selectionScope,
        catalog: params.catalog,
        ref,
        defaultModel: params.defaultModel,
        defaultRef: params.defaultRef,
      }),
  });
}
