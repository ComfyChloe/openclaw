import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { augmentModelCatalogWithAgentHarness } from "../../agents/harness/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { includeConfiguredStaticCatalogEntries } from "./models-list-configured-static.js";

export async function prepareModelsListHarnessCatalog(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  workspaceDir: string;
  snapshot: ModelCatalogSnapshot;
  view: "default" | "configured" | "provider-config" | "all";
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
  isCurrent?: () => boolean;
  observationConfig?: OpenClawConfig;
  allowHarnessDiscovery: boolean;
  onError?: (error: unknown) => void;
}) {
  const rawDefaultModel = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const defaultRef = rawDefaultModel
    ? resolveDefaultModelForAgent({
        cfg: params.cfg,
        agentId: params.agentId,
        manifestPlugins: params.metadataSnapshot,
        resolvedModelCatalog: params.snapshot.entries,
        allowPluginNormalization: true,
      })
    : undefined;
  const defaultProvider = defaultRef?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = defaultRef?.model;
  const snapshot = params.allowHarnessDiscovery
    ? await augmentModelCatalogWithAgentHarness({
        cfg: params.cfg,
        agentId: params.agentId,
        agentDir: params.agentDir ?? resolveAgentDir(params.cfg, params.agentId),
        workspaceDir: params.workspaceDir,
        defaultProvider,
        defaultModel: rawDefaultModel,
        snapshot: params.snapshot,
        pluginRegistry: params.pluginRegistry,
        isCurrent: params.isCurrent,
        observationConfig: params.observationConfig,
        onError: params.onError,
      })
    : params.snapshot;
  return {
    snapshot,
    defaultProvider,
    defaultModel,
    rawDefaultModel,
    catalog: includeConfiguredStaticCatalogEntries({
      ...params,
      snapshot,
      defaultProvider,
      defaultModel,
      enabled: params.view === "configured",
    }),
  };
}
