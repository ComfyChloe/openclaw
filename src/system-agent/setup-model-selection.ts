import { toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import type { ModelRef } from "../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";

type SystemAgentModelSelectionParams = {
  config: OpenClawConfig;
  /** Strings are authored input; tuples already name the selected model. */
  model: string | ModelRef;
  /** Write the model onto this configured agent instead of the default route. */
  targetAgentId?: string;
  agentRuntimeId?: string;
  /** Pin the selected model to the exact credential that passed inference. */
  authProfileId?: string;
};

type SystemAgentModelSelectionModules = {
  agentScope: typeof import("../agents/agent-scope.js");
  modelConfig: typeof import("../commands/models/shared.js");
  runtimePolicy: typeof import("../agents/model-runtime-policy.js");
};

function applySystemAgentModelSelectionWithModules(
  params: SystemAgentModelSelectionParams,
  modules: SystemAgentModelSelectionModules,
): OpenClawConfig {
  const { agentScope, modelConfig, runtimePolicy } = modules;
  const nextConfig = structuredClone(params.config);
  const normalizedTarget =
    params.targetAgentId === undefined ? null : normalizeAgentIdStrict(params.targetAgentId);
  if (normalizedTarget && !normalizedTarget.ok) {
    throw new Error(`Could not resolve configured agent "${params.targetAgentId}".`);
  }
  const targetAgentId = normalizedTarget?.value;
  const agentId = agentScope.resolveAmbientOwnerAgentId(nextConfig, targetAgentId);
  const roster = agentScope.listAgentEntries(nextConfig);
  if (targetAgentId && !roster.some((entry) => normalizeAgentId(entry.id) === targetAgentId)) {
    throw new Error(`Could not resolve configured agent "${targetAgentId}".`);
  }
  // A targeted selection always lands on the agent entry; the default-route
  // selection only writes the agent when it already carries an explicit model.
  const writesAgent = Boolean(
    targetAgentId || agentScope.resolveAgentExplicitModelPrimary(nextConfig, agentId),
  );
  nextConfig.agents ??= {};
  nextConfig.agents.defaults ??= {};
  const agentDefaults = nextConfig.agents.defaults;
  const target =
    typeof params.model === "string"
      ? modelConfig.resolveModelTarget({ raw: params.model, cfg: nextConfig })
      : params.model;
  const key = modelConfig.upsertCanonicalModelConfigEntry({}, target);

  const configuredVisibleModels = agentDefaults.models;
  if (configuredVisibleModels && Object.keys(configuredVisibleModels).length > 0) {
    // An authored global visibility map is restrictive. Extend it for the
    // approved selection; never create one merely to carry runtime metadata.
    const defaultModels = { ...configuredVisibleModels };
    modelConfig.upsertCanonicalModelConfigEntry(defaultModels, target);
    if (!params.agentRuntimeId) {
      const entry = { ...defaultModels[key] };
      delete entry.agentRuntime;
      defaultModels[key] = entry;
    }
    agentDefaults.models = defaultModels;
  }

  const agentEntries = toAgentEntriesRecord(roster);
  if (writesAgent || params.agentRuntimeId) {
    const { list: _legacyList, ...agentConfig } = nextConfig.agents;
    nextConfig.agents = { ...agentConfig, entries: agentEntries };
  }
  const agentEntryKey =
    roster.find((entry) => normalizeAgentId(entry.id) === agentId)?.id ?? agentId;
  let agent = agentEntries[agentEntryKey];
  if (writesAgent && !agent) {
    throw new Error(`Could not resolve configured default agent "${agentId}".`);
  }
  if (params.agentRuntimeId && !agent) {
    agent = {};
    agentEntries[agentEntryKey] = agent;
  }
  if (
    agent &&
    (writesAgent || params.agentRuntimeId || (agent.models && Object.keys(agent.models).length > 0))
  ) {
    const agentModels = { ...agent.models };
    const agentKey = modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
    const entry = { ...agentModels[agentKey] };
    if (params.agentRuntimeId) {
      entry.agentRuntime = { id: params.agentRuntimeId };
    } else {
      delete entry.agentRuntime;
    }
    agentModels[agentKey] = entry;
    agent.models = agentModels;
  }
  const selectedModel = params.authProfileId ? `${key}@${params.authProfileId}` : key;
  agentScope.setAgentEffectiveModelPrimary(nextConfig, agentId, selectedModel, {
    forceAgent: Boolean(targetAgentId),
  });
  if (params.agentRuntimeId) {
    const effectiveRuntime = runtimePolicy.resolveModelRuntimePolicy({
      config: nextConfig,
      provider: target.provider,
      modelId: target.model,
      agentId,
    }).policy?.id;
    if (effectiveRuntime !== params.agentRuntimeId) {
      throw new Error(`Could not pin ${key} to the ${params.agentRuntimeId} runtime.`);
    }
  }
  return nextConfig;
}

export async function createSystemAgentModelSelectionUpdater(
  params: Omit<SystemAgentModelSelectionParams, "config">,
): Promise<(config: OpenClawConfig) => OpenClawConfig> {
  const [agentScope, modelConfig, runtimePolicy] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../commands/models/shared.js"),
    import("../agents/model-runtime-policy.js"),
  ]);
  const modules = { agentScope, modelConfig, runtimePolicy };
  return (config) => applySystemAgentModelSelectionWithModules({ ...params, config }, modules);
}

export async function applySystemAgentModelSelection(
  params: SystemAgentModelSelectionParams,
): Promise<OpenClawConfig> {
  const update = await createSystemAgentModelSelectionUpdater(params);
  return update(params.config);
}
