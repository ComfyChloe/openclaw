/**
 * Resolves default thinking levels for provider/model pairs. It combines
 * explicit per-model config, global defaults, catalog metadata, and model
 * family fallbacks.
 */
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { resolveThinkingDefaultCore } from "./model-thinking-default-core.js";
export { resolveConfiguredThinkingDefaultCore as resolveConfiguredThinkingDefault } from "./model-thinking-default-core.js";

/** Resolves the default thinking level for a provider/model pair. */
export function resolveThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  catalog?: ModelCatalogEntry[];
  agentRuntime?: string | null;
}): ThinkLevel {
  return resolveThinkingDefaultCore(params);
}

/** Resolves thinking default after loading runtime catalog only when needed. */
export async function resolveThinkingDefaultWithRuntimeCatalogCore(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  loadRuntimeCatalog: () => Promise<ModelCatalogEntry[]>;
  agentRuntime?: string | null;
  agentId?: string;
}): Promise<ThinkLevel> {
  const configuredCatalog = buildConfiguredModelCatalog({ cfg: params.cfg });
  const configuredSelectedEntry = configuredCatalog.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const needsRuntimeCatalog =
    configuredCatalog.length === 0 ||
    !configuredSelectedEntry ||
    configuredSelectedEntry.reasoning === undefined;
  const runtimeCatalog = needsRuntimeCatalog ? await params.loadRuntimeCatalog() : undefined;
  const runtimeSelectedEntry = runtimeCatalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const catalog =
    runtimeSelectedEntry || configuredCatalog.length === 0
      ? (runtimeCatalog ?? configuredCatalog)
      : configuredCatalog;
  return resolveThinkingDefault({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    catalog,
    agentRuntime: params.agentRuntime,
  });
}
