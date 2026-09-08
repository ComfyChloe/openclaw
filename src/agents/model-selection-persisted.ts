// Persisted model metadata normalization without loading the broader selection runtime.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { parseModelRef } from "./model-selection-normalize.js";

function normalizePersistedDefaultProvider(value: unknown): string {
  return normalizeOptionalString(value) ?? DEFAULT_PROVIDER;
}

export function resolvePersistedOverrideModelRef(
  params: {
    defaultProvider?: unknown;
    overrideProvider?: unknown;
    overrideModel?: unknown;
    overrideRouteResolution?: "raw" | "resolved";
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const defaultProvider = normalizePersistedDefaultProvider(params.defaultProvider);
  const overrideProvider = normalizeOptionalString(params.overrideProvider);
  const overrideModel = normalizeOptionalString(params.overrideModel);
  if (!overrideModel) {
    return null;
  }
  // Producers mark canonical pairs; never transform their model identity a second time.
  if (overrideProvider && params.overrideRouteResolution === "resolved") {
    return { provider: overrideProvider, model: overrideModel };
  }
  const encodedOverride = overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel;
  return (
    parseModelRef(encodedOverride, defaultProvider, {
      allowManifestNormalization: params.allowManifestNormalization,
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
      resolvedModelCatalog: params.resolvedModelCatalog,
    }) ?? {
      provider: overrideProvider || defaultProvider,
      model: overrideModel,
    }
  );
}
