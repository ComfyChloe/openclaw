import type { ModelManifestNormalizationContext } from "../../agents/model-ref-shared.js";
// Default model and alias resolution for directive handling.
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  resolveDefaultModelForAgent,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Resolve default provider/model plus alias index for directive parsing. */
export function resolveDefaultModel(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const mainModel = resolveDefaultModelForAgent({
    ...params,
    // Pure readers stay static; admitted reply selection supplies captured identities.
    allowPluginNormalization: params.allowPluginNormalization ?? false,
  });
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    ...params,
    defaultProvider,
    allowPluginNormalization: params.allowPluginNormalization ?? false,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}
