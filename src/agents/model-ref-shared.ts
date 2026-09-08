/**
 * Shared provider/model reference normalization for static catalogs,
 * allowlists, and display paths. Manifest policies are optional so tests can
 * isolate built-in normalization behavior.
 */
import type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeConfiguredProviderCatalogModelRef,
  normalizeStaticProviderModelIdWithPolicies,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import {
  resolveManifestModelIdNormalizationPolicies,
  type ManifestModelIdNormalizationSource,
} from "../plugins/manifest-model-id-normalization.js";
import { modelKey } from "../shared/model-key.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";
export {
  findNormalizedProviderKey,
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "@openclaw/model-catalog-core/provider-id";
export { modelKey } from "../shared/model-key.js";

export type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";

export type ModelManifestNormalizationContext = {
  manifestPlugins?: ManifestModelIdNormalizationSource;
  /** Executable identities captured by this selection's prepared owner. */
  resolvedModelCatalog?: readonly { provider: string; id: string }[];
};

/** Exact prepared identities win over input aliases, retaining named config retirements. */
export function resolveCatalogModelRef(
  provider: string,
  model: string,
  catalog: ModelManifestNormalizationContext["resolvedModelCatalog"],
): ModelRef | undefined {
  if (!catalog?.length) {
    return undefined;
  }
  const providerId = normalizeProviderId(provider);
  const modelId = normalizeAgentModelRefForConfig(modelKey(providerId, model)).slice(
    providerId.length + 1,
  );
  return catalog.some(
    (entry) => normalizeProviderId(entry.provider) === providerId && entry.id === modelId,
  )
    ? { provider: providerId, model: modelId }
    : undefined;
}

export type ProviderModelIdNormalizationOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
};

/** Normalize a static provider model ID with built-in and optional manifest policy. */
export function normalizeStaticProviderModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  return createStaticProviderModelIdNormalizer(options)(provider, model);
}

/**
 * Captures manifest policies once for repeated static model-id comparisons.
 * Lifecycle-prepared callers must not rediscover plugin metadata inside model loops.
 */
export function createStaticProviderModelIdNormalizer(
  options: ProviderModelIdNormalizationOptions = {},
): (provider: string, model: string) => string {
  let policies: ReturnType<typeof resolveManifestModelIdNormalizationPolicies> | undefined;
  return (provider, model) =>
    normalizeStaticProviderModelIdWithPolicies(
      normalizeProviderId(provider),
      model,
      options.allowManifestNormalization === false
        ? undefined
        : (policies ??= resolveManifestModelIdNormalizationPolicies({
            plugins: options.manifestPlugins,
          })),
    );
}

/** Normalize a configured catalog model ID for comparisons against provider catalogs. */
export function normalizeConfiguredProviderCatalogModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  return normalizeConfiguredProviderCatalogModelRef(
    normalizeStaticProviderModelId(provider, model, options),
  );
}

/** Reuses one manifest-policy view across configured model rows in an operation. */
export function createConfiguredProviderCatalogModelIdNormalizer(
  options: ProviderModelIdNormalizationOptions = {},
): (provider: string, model: string) => string {
  const normalizeStatic = createStaticProviderModelIdNormalizer(options);
  return (provider, model) =>
    normalizeConfiguredProviderCatalogModelRef(normalizeStatic(provider, model));
}

type ModelRefNormalizeOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
};

function normalizeProviderModelId(
  provider: string,
  model: string,
  options?: ModelRefNormalizeOptions,
): string {
  const staticModelId = normalizeStaticProviderModelId(provider, model, options);
  const catalogRef = resolveCatalogModelRef(provider, staticModelId, options?.resolvedModelCatalog);
  if (catalogRef) {
    return catalogRef.model;
  }
  if (options?.allowPluginNormalization === false) {
    return staticModelId;
  }
  return (
    normalizeProviderModelIdWithRuntime({
      provider,
      context: {
        provider,
        modelId: staticModelId,
      },
    }) ?? staticModelId
  );
}

/** Normalize a provider/model pair into a canonical model reference. */
export function normalizeModelRef(
  provider: string,
  model: string,
  options?: ModelRefNormalizeOptions,
): ModelRef {
  const catalogRef = resolveCatalogModelRef(provider, model, options?.resolvedModelCatalog);
  if (catalogRef) {
    return catalogRef;
  }
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModel = normalizeProviderModelId(normalizedProvider, model.trim(), options);
  return { provider: normalizedProvider, model: normalizedModel };
}

function parseStaticModelRef(raw: string, defaultProvider: string): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const providerRaw = slash === -1 ? defaultProvider : trimmed.slice(0, slash).trim();
  const modelRaw = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const provider = normalizeProviderId(providerRaw);
  return {
    provider,
    model: normalizeStaticProviderModelId(provider, modelRaw),
  };
}

/** Resolve an allowlist entry to a canonical provider/model key. */
export function resolveStaticAllowlistModelKey(
  raw: string,
  defaultProvider: string,
): string | null {
  const parsed = parseStaticModelRef(raw, defaultProvider);
  if (!parsed) {
    return null;
  }
  return modelKey(parsed.provider, parsed.model);
}

/** Preserve literal provider/model refs that already include a provider prefix twice. */
export function formatLiteralProviderPrefixedModelRef(provider: string, modelRef: string): string {
  const providerId = normalizeProviderId(provider);
  const trimmedRef = modelRef.trim();
  if (!providerId || !trimmedRef) {
    return trimmedRef;
  }
  const normalizedRef = normalizeLowercaseStringOrEmpty(trimmedRef);
  const literalPrefix = `${providerId}/${providerId}/`;
  if (normalizedRef.startsWith(literalPrefix)) {
    return trimmedRef;
  }
  return normalizedRef.startsWith(`${providerId}/`) ? `${providerId}/${trimmedRef}` : trimmedRef;
}
