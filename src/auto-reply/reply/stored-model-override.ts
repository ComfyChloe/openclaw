// Normalizes stored reply models and detects stale heartbeat fallback pins.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasSessionAutoModelFallbackProvenance } from "../../agents/agent-scope.js";
import { resolveCliRuntimeCanonicalProvider } from "../../agents/cli-backends.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { parseRawModelRef } from "../../agents/model-selection-normalize.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection-persisted.js";
import { parseConfiguredModelRef } from "../../agents/model-selection-shared.js";
import {
  modelKey,
  resolveModelAliasFromPair,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { StoredModelOverride } from "../../sessions/stored-model-overrides.js";
import type { RuntimeModelNormalization } from "./model-runtime-normalization.js";

/** Project a saved selection without validating or repairing its persisted owner. */
export function resolveStoredRuntimeModelSelection(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  storedOverride: StoredModelOverride;
  defaultProvider: string;
  catalog: readonly Pick<ModelCatalogEntry, "provider" | "id">[];
  aliasIndex: ModelAliasIndex;
  normalization: RuntimeModelNormalization;
}): { provider: string; model: string; routeResolution: "resolved" } {
  const { storedOverride, normalization } = params;
  const raw = storedOverride.provider
    ? modelKey(storedOverride.provider, storedOverride.model)
    : storedOverride.model;
  const input = parseRawModelRef(raw, params.defaultProvider) ?? {
    provider: storedOverride.provider || params.defaultProvider,
    model: storedOverride.model,
  };
  const cataloged = findModelInCatalog(params.catalog, input.provider, input.model);
  const alias =
    storedOverride.routeResolution === "raw" && !cataloged
      ? resolveModelAliasFromPair({
          cfg: params.cfg,
          ...input,
          defaultProvider: params.defaultProvider,
          aliasIndex: params.aliasIndex,
          ...normalization,
        })
      : null;
  const selected =
    storedOverride.routeResolution === "resolved"
      ? (resolvePersistedOverrideModelRef({
          ...normalization,
          defaultProvider: params.defaultProvider,
          overrideProvider: storedOverride.provider,
          overrideModel: storedOverride.model,
          overrideRouteResolution: "resolved",
        }) ?? input)
      : (alias ??
        (cataloged ? { provider: cataloged.provider, model: cataloged.id } : null) ??
        parseConfiguredModelRef({
          cfg: params.cfg,
          raw,
          defaultProvider: params.defaultProvider,
          ...normalization,
        }) ??
        input);
  const canonicalProvider = params.sessionEntry?.cliSessionBindings?.[selected.provider]
    ? resolveCliRuntimeCanonicalProvider({
        runtime: selected.provider,
        config: params.cfg,
        includeSetupRegistry: true,
      })
    : undefined;
  return {
    ...selected,
    provider: canonicalProvider ?? selected.provider,
    routeResolution: "resolved",
  };
}

function resolveModelRefKey(params: {
  defaultProvider: string;
  overrideProvider?: string;
  overrideModel?: string;
}): string | null {
  const ref = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.overrideProvider,
    overrideModel: params.overrideModel,
    overrideRouteResolution: "resolved",
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  if (!ref) {
    return null;
  }
  return modelKey(ref.provider, ref.model);
}

/** Detects heartbeat auto-fallback overrides that no longer match the primary model. */
export function isStaleHeartbeatAutoFallbackOverride(params: {
  isHeartbeat?: boolean;
  hasResolvedHeartbeatModelOverride?: boolean;
  sessionEntry?: SessionEntry;
  storedOverride?: StoredModelOverride | null;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
}): boolean {
  if (params.isHeartbeat !== true || params.hasResolvedHeartbeatModelOverride === true) {
    return false;
  }
  if (params.storedOverride?.source !== "session") {
    return false;
  }
  const entry = params.sessionEntry;
  const recoveredAutoFallbackOverride =
    entry !== undefined &&
    entry.modelOverrideSource === undefined &&
    hasSessionAutoModelFallbackProvenance(entry);
  // Older sessions may lack modelOverrideSource; provenance recovers the auto-fallback state.
  if (entry?.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return false;
  }
  if (!entry) {
    return false;
  }

  const primaryKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.primaryProvider ?? params.defaultProvider,
    overrideModel: params.primaryModel ?? params.defaultModel,
  });
  if (!primaryKey) {
    return false;
  }

  const originKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: entry.modelOverrideFallbackOriginProvider,
    overrideModel: entry.modelOverrideFallbackOriginModel,
  });
  if (originKey) {
    return originKey !== primaryKey;
  }

  const noticeSelectedKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideModel: normalizeOptionalString(entry.fallbackNotice?.selectedModel),
  });
  if (noticeSelectedKey) {
    return noticeSelectedKey !== primaryKey;
  }

  const storedOverrideKey = resolveModelRefKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.storedOverride.provider,
    overrideModel: params.storedOverride.model,
  });
  return storedOverrideKey !== null && storedOverrideKey !== primaryKey;
}
