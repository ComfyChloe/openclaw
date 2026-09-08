/**
 * Model runtime policy resolution.
 *
 * Agent execution uses this to choose a model/provider-specific runtime policy
 * from agent entries, model catalog config, provider config, or QA overrides.
 */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveAgentModelConfigValue } from "../config/model-input.js";
import {
  findProviderModelConfig,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";

/** A stored-row owner is already selected; request hints still require normal admission. */
export type AgentRuntimePolicyScope = { sessionKey?: string } & (
  | { agentId?: string; agentScope?: never }
  | { agentId?: never; agentScope: { kind: "prepared"; agentId: string } }
);

/** Resolve request hints; prepared owner facts never re-admit a canonical sentinel. */
export function resolveAgentRuntimePolicyAgentId(
  params: AgentRuntimePolicyScope & { config?: OpenClawConfig },
): string | undefined {
  if (params.agentScope?.kind === "prepared") {
    return params.agentScope.agentId;
  }
  return params.config && (params.agentId?.trim() || params.sessionKey?.trim())
    ? resolveSessionAgentIds({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }).sessionAgentId
    : params.agentId;
}

/** Config surface that supplied a resolved model runtime policy. */
type ModelRuntimePolicySource = "model" | "provider";

/** Runtime policy plus the config surface that supplied it. */
type ResolvedModelRuntimePolicy = {
  policy?: AgentRuntimePolicyConfig;
  source?: ModelRuntimePolicySource;
  matchedProvider?: string;
  forcedByEnvironment?: true;
};

type ModelEntryMatchKind = "exact" | "provider-wildcard";

type AgentModelRuntimePolicyMatch = {
  provider: string;
  policy: AgentRuntimePolicyConfig;
};

type AgentModelRuntimePolicyResolution = ResolvedModelRuntimePolicy & {
  ambiguous?: true;
};

function hasRuntimePolicy(value: AgentRuntimePolicyConfig | undefined): boolean {
  return Boolean(value?.id?.trim());
}

function resolvePolicyMatch(
  matches: AgentModelRuntimePolicyMatch[],
  callerProvider: string,
): AgentModelRuntimePolicyResolution {
  const providerMatches = callerProvider
    ? matches.filter((match) => match.provider === callerProvider)
    : [];
  const candidates = providerMatches.length > 0 ? providerMatches : matches;
  const [first] = candidates;
  if (!first) {
    return {};
  }
  if (!callerProvider && candidates.some((match) => match.provider !== first.provider)) {
    return { ambiguous: true };
  }
  return {
    policy: first.policy,
    source: "model",
    matchedProvider: first.provider || callerProvider,
  };
}

function resolveAgentModelEntryRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  matchKind: ModelEntryMatchKind;
}): AgentModelRuntimePolicyResolution {
  const modelId = params.modelId?.trim();
  if (!params.config || (!modelId && params.matchKind !== "provider-wildcard")) {
    return {};
  }
  // Point lookup: projecting the whole roster per model ref made runtime
  // collection O(agents² × models) on large fleets (#135743).
  const agentEntry = params.agentId ? resolveAgentEntry(params.config, params.agentId) : undefined;
  const modelMaps: Array<Record<string, AgentModelEntryConfig> | undefined> = [
    agentEntry?.models,
    params.config.agents?.defaults?.models,
  ];
  const callerProvider = normalizeProviderId(params.provider ?? "");
  for (const models of modelMaps) {
    if (callerProvider && modelId && params.matchKind === "exact") {
      const policy = resolveAgentModelConfigValue(models, callerProvider, modelId, (entry) =>
        hasRuntimePolicy(entry?.agentRuntime) ? entry.agentRuntime : undefined,
      );
      if (policy) {
        return { policy, source: "model", matchedProvider: callerProvider };
      }
    }
    const scopeMatches: AgentModelRuntimePolicyMatch[] = [];
    for (const [key, entry] of Object.entries(models ?? {})) {
      const ref = parseModelCatalogRef(key);
      if (callerProvider && ref && ref.provider !== callerProvider) {
        continue;
      }
      const matches =
        params.matchKind === "provider-wildcard"
          ? ref?.modelId === "*"
          : (ref?.modelId ?? key.trim()) === modelId;
      const policy = entry?.agentRuntime;
      if (!matches || !policy || !hasRuntimePolicy(policy)) {
        continue;
      }
      scopeMatches.push({ provider: ref?.provider ?? "", policy });
    }
    // Unqualified model ids can match multiple provider-qualified entries; avoid
    // choosing an arbitrary runtime when the provider is unknown.
    const resolved = resolvePolicyMatch(scopeMatches, callerProvider);
    if (resolved.policy || resolved.ambiguous) {
      return resolved;
    }
  }
  return {};
}

function resolveModelConfig(params: {
  providerConfig?: ModelProviderConfig;
  provider?: string;
  modelId?: string;
}): ModelDefinitionConfig | undefined {
  const modelId = params.modelId?.trim();
  if (!modelId || !Array.isArray(params.providerConfig?.models)) {
    return undefined;
  }
  return findProviderModelConfig(params.providerConfig.models, params.provider ?? "", modelId);
}

/** Resolves the effective runtime policy for an agent/model/provider selection. */
export function resolveModelRuntimePolicy(
  params: {
    config?: OpenClawConfig;
    provider?: string;
    modelId?: string;
  } & AgentRuntimePolicyScope,
): ResolvedModelRuntimePolicy {
  const callerProvider = normalizeProviderId(params.provider ?? "");
  // A separate provider makes modelId provider-local. Only raw refs without
  // that owner are parsed here; resolved model namespaces must remain literal.
  const rawRef = callerProvider ? null : parseModelCatalogRef(params.modelId ?? "");
  const effectiveProvider = callerProvider || rawRef?.provider;
  const modelId = rawRef?.modelId ?? params.modelId;
  const inferredMatchedProvider = callerProvider ? undefined : effectiveProvider;
  if (process.env.OPENCLAW_BUILD_PRIVATE_QA === "1") {
    const forcedRuntime = process.env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase();
    if (forcedRuntime === "openclaw" || forcedRuntime === "codex") {
      return { policy: { id: forcedRuntime }, source: "model", forcedByEnvironment: true };
    }
  }

  const hasAgentScope = Boolean(
    params.agentScope || params.agentId?.trim() || params.sessionKey?.trim(),
  );
  const agentId = hasAgentScope
    ? resolveAgentRuntimePolicyAgentId(params)
    : params.config && tryResolveLegacyCompatibilityAgentId(params.config);
  const agentModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    agentId,
    provider: effectiveProvider,
    modelId,
    matchKind: "exact",
  });
  if (agentModelPolicy.ambiguous) {
    return {};
  }
  if (agentModelPolicy.policy) {
    return agentModelPolicy;
  }
  const providerConfig = effectiveProvider
    ? resolveMergedModelProviderConfig(params.config, effectiveProvider)
    : undefined;
  const modelConfig = resolveModelConfig({
    providerConfig,
    provider: effectiveProvider,
    modelId,
  });
  if (hasRuntimePolicy(modelConfig?.agentRuntime)) {
    return {
      policy: modelConfig?.agentRuntime,
      source: "model",
      ...(inferredMatchedProvider ? { matchedProvider: inferredMatchedProvider } : {}),
    };
  }
  const agentWildcardModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    agentId,
    provider: effectiveProvider,
    modelId,
    matchKind: "provider-wildcard",
  });
  if (agentWildcardModelPolicy.policy) {
    return agentWildcardModelPolicy;
  }
  if (hasRuntimePolicy(providerConfig?.agentRuntime)) {
    return {
      policy: providerConfig?.agentRuntime,
      source: "provider",
      ...(inferredMatchedProvider ? { matchedProvider: inferredMatchedProvider } : {}),
    };
  }
  return {};
}
