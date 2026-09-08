/**
 * Builds runtime context for context-engine backed embedded compaction.
 */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ThinkLevel, ThinkingCatalogEntry } from "../../auto-reply/thinking.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  listActiveProcessSessionReferences,
  type ActiveProcessSessionReference,
} from "../bash-process-references.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_PROVIDER } from "../defaults.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import {
  normalizeModelRef,
  normalizeProviderId,
  type ModelManifestNormalizationContext,
} from "../model-ref-shared.js";
import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  listModelAliasCandidates,
} from "../model-selection-shared.js";
import { resolveSelectedOpenAIRuntimeProvider } from "../openai-routing.js";
import { agentRuntimeAuthPlanMatchesTarget } from "../runtime-plan/prepare-auth.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import { resolveCandidateThinkingLevel } from "../thinking-runtime.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { readAgentModelContextTokens } from "./model-context-tokens.js";
import { normalizeContextTokenBudget } from "./utils.js";

type EmbeddedCompactionRuntimeContextParams = Omit<
  Partial<CompactEmbeddedAgentSessionParams>,
  | "workspaceDir"
  | "sessionKey"
  | "messageChannel"
  | "messageProvider"
  | "chatType"
  | "agentAccountId"
  | "currentChannelId"
  | "currentThreadTs"
  | "currentMessageId"
  | "authProfileId"
  | "cwd"
  | "senderId"
  | "provider"
  | "model"
> & {
  workspaceDir: string;
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  chatType?: ChatType | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  authProfileId?: string | null;
  cwd?: string | null;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  harnessRuntime?: string | null;
  activeProcessSessions?: ActiveProcessSessionReference[];
};

/** Resolve the configured compaction override against the actual model/runtime candidate. */
export function resolveEmbeddedCompactionThinkingLevel(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  inheritedLevel?: ThinkLevel;
  compactionThinkingDefault?: ProviderRuntimeModel["compactionThinkingDefault"];
  catalog?: ThinkingCatalogEntry[];
  agentId?: string;
  sessionKey?: string;
  agentRuntime?: string | null;
}): ThinkLevel {
  const configuredLevel = params.config?.agents?.defaults?.compaction?.thinkingLevel;
  const requestedLevel =
    configuredLevel === "inherit"
      ? params.inheritedLevel
      : (configuredLevel ?? params.compactionThinkingDefault ?? "low");
  if (!requestedLevel) {
    return "off";
  }
  // A compaction model override or fallback can change the supported level set.
  // Revalidate the immutable request for every concrete candidate instead of
  // carrying a level clamped for an earlier model into a later attempt.
  return (
    resolveCandidateThinkingLevel({
      cfg: params.config,
      provider: params.provider,
      modelId: params.modelId,
      level: requestedLevel,
      catalog: params.catalog,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      agentRuntime: params.agentRuntime,
    }) ?? "off"
  );
}

/**
 * Resolve the effective compaction target from config, falling back to the
 * caller-supplied provider/model and optionally applying runtime defaults.
 */
export function resolveEmbeddedCompactionTarget(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
  harnessRuntime?: string | null;
  modelSelectionLocked?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  allowPluginNormalization?: boolean;
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"];
  resolvedModelCatalog?: ModelManifestNormalizationContext["resolvedModelCatalog"];
}): {
  provider: string | undefined;
  runtimeProvider?: string;
  contextProvider?: string;
  nativeHarnessCompaction?: boolean;
  model: string | undefined;
  authProfileId: string | undefined;
} {
  const provider =
    normalizeProviderId(params.provider?.trim() || params.defaultProvider || "") || undefined;
  const model = params.modelId?.trim() || params.defaultModel;
  // A locked session's creating model owns every transcript read, including
  // summaries. Compaction-specific model overrides would cross that boundary.
  const override = params.modelSelectionLocked
    ? undefined
    : params.config?.agents?.defaults?.compaction?.model?.trim();
  const assembleTarget = (targetProvider: string | undefined, targetModel: string | undefined) => {
    // A provider switch cannot inherit credentials selected for the session's
    // original provider; all target paths share that boundary.
    const authProfileId =
      targetProvider !== provider ? undefined : (params.authProfileId ?? undefined);
    return {
      provider: targetProvider,
      ...resolveCompactionTargetRuntime(targetProvider, params.harnessRuntime),
      model: targetModel,
      authProfileId,
    };
  };
  if (!override) {
    return assembleTarget(provider, model);
  }
  const resolveRawTarget = (
    targetProvider: string | undefined,
    targetModel: string | undefined,
  ) => {
    // Future-context projections stay cold; admitted execution supplies its normalization facts.
    if (!targetProvider || !targetModel || !params.manifestPlugins) {
      return assembleTarget(targetProvider, targetModel);
    }
    const resolved = normalizeModelRef(targetProvider, targetModel, {
      manifestPlugins: params.manifestPlugins,
      resolvedModelCatalog: params.resolvedModelCatalog,
      allowPluginNormalization: params.allowPluginNormalization,
    });
    return assembleTarget(resolved.provider, resolved.model);
  };
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = normalizeProviderId(override.slice(0, slashIdx));
    const overrideModel = override.slice(slashIdx + 1).trim() || params.defaultModel;
    return resolveRawTarget(overrideProvider, overrideModel);
  }
  const config = params.config ?? {};
  if (
    provider &&
    hasBareConfiguredModelForProvider({
      cfg: config,
      provider,
      model: override,
    })
  ) {
    return resolveRawTarget(provider, override);
  }
  const inferredLiteralProvider = inferUniqueProviderFromConfiguredModels({
    cfg: config,
    model: override,
    allowManifestNormalization: false,
  });
  if (inferredLiteralProvider) {
    return resolveRawTarget(inferredLiteralProvider, override);
  }
  const defaultProvider = provider || DEFAULT_PROVIDER;
  const aliasKey = normalizeCompactionConfigKey(splitTrailingAuthProfile(override).model);
  // Unrelated aliases must not cold-load provider runtime for a literal override.
  const alias = listModelAliasCandidates(config).some(
    ({ alias: candidate }) => normalizeCompactionConfigKey(candidate) === aliasKey,
  )
    ? buildModelAliasIndex({
        cfg: config,
        defaultProvider,
        allowPluginNormalization: params.allowPluginNormalization,
        manifestPlugins: params.manifestPlugins,
        resolvedModelCatalog: params.resolvedModelCatalog,
      }).byAlias.get(aliasKey)
    : undefined;
  if (alias) {
    return assembleTarget(alias.ref.provider, alias.ref.model);
  }
  return resolveRawTarget(provider, override);
}

/** Binds harness ownership without repeating model or alias selection. */
export function resolveCompactionTargetRuntime(
  provider: string | undefined,
  harnessRuntime?: string | null,
) {
  if (!provider) {
    return {};
  }
  const selectedHarnessRuntime = normalizeOptionalAgentRuntimeId(harnessRuntime);
  // Provider defaults choose new runs; they cannot move an existing transcript.
  const useNativeHarnessRuntime =
    selectedHarnessRuntime !== undefined &&
    selectedHarnessRuntime !== "openclaw" &&
    !isDefaultAgentRuntimeId(selectedHarnessRuntime);
  const runtimeProvider = resolveSelectedOpenAIRuntimeProvider({ provider });
  const routedRuntimeProvider = runtimeProvider === provider ? undefined : runtimeProvider;
  return {
    runtimeProvider: routedRuntimeProvider,
    contextProvider: useNativeHarnessRuntime ? routedRuntimeProvider : undefined,
    ...(useNativeHarnessRuntime ? { nativeHarnessCompaction: true } : {}),
  };
}

function normalizeCompactionConfigKey(value: string): string {
  return value.trim().toLowerCase();
}

function hasBareConfiguredModelForProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  const model = params.model.trim();
  // Literal identity is case-sensitive; a folded row must not hide another provider's exact match.
  return (
    Object.keys(params.cfg.agents?.defaults?.models ?? {}).some((rawRef) => {
      const ref = parseModelCatalogRef(rawRef);
      return ref?.provider === provider && ref.modelId === model;
    }) ||
    Object.entries(params.cfg.models?.providers ?? {}).some(
      ([id, config]) =>
        normalizeProviderId(id) === provider &&
        config.models?.some((entry) => entry.id.trim() === model),
    )
  );
}

/** Resolves the concrete harness already bound to this exact compaction target. */
export function resolveCompactionHarnessRuntime(params: {
  boundHarnessRuntime?: string | null;
  preparedRuntimePlan?: AgentRuntimePlan;
  configuredHarnessRuntime?: string | null;
  provider: string;
  modelId: string;
}): string | undefined {
  const boundHarnessRuntime = normalizeOptionalAgentRuntimeId(params.boundHarnessRuntime);
  if (boundHarnessRuntime) {
    return boundHarnessRuntime;
  }
  const preparedRuntimePlan = params.preparedRuntimePlan;
  if (
    preparedRuntimePlan &&
    agentRuntimeAuthPlanMatchesTarget(preparedRuntimePlan.auth, {
      provider: params.provider,
      modelId: params.modelId,
    })
  ) {
    const preparedHarnessRuntime = normalizeOptionalAgentRuntimeId(
      preparedRuntimePlan.resolvedRef.harnessId,
    );
    if (preparedHarnessRuntime) {
      return preparedHarnessRuntime;
    }
  }
  return normalizeOptionalAgentRuntimeId(params.configuredHarnessRuntime);
}

/** Resolves the shared policy, target, and harness ownership for either compaction entry point. */
export function resolveCompactionContextTokenBudget(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  agentId?: string;
  requestedTokenBudget?: number;
  fallbackTokenBudget?: number;
}) {
  // Caller budgets stay bounded by the selected model ceiling.
  const resolvedBudget =
    normalizeContextTokenBudget(
      resolveContextWindowInfo({
        cfg: params.config,
        provider: params.provider,
        modelId: params.modelId,
        modelContextTokens: readAgentModelContextTokens(params.model),
        modelContextWindow: params.model?.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      }).tokens,
    ) ?? DEFAULT_CONTEXT_TOKENS;
  return Math.min(
    normalizeContextTokenBudget(params.requestedTokenBudget) ??
      normalizeContextTokenBudget(params.fallbackTokenBudget) ??
      resolvedBudget,
    resolvedBudget,
  );
}

export function buildEmbeddedCompactionRuntimeContext(
  params: EmbeddedCompactionRuntimeContextParams,
  selectedTarget?: Pick<
    ReturnType<typeof resolveEmbeddedCompactionTarget>,
    "provider" | "model" | "authProfileId"
  >,
) {
  // Executing compaction carries its selected target; future contexts still project config.
  const resolved = selectedTarget
    ? {
        ...selectedTarget,
        ...resolveCompactionTargetRuntime(selectedTarget.provider, params.harnessRuntime),
      }
    : resolveEmbeddedCompactionTarget({
        config: params.config,
        provider: params.provider,
        modelId: params.modelId,
        authProfileId: params.authProfileId,
        harnessRuntime: params.harnessRuntime,
        modelSelectionLocked: params.modelSelectionLocked,
      });
  const agentHarnessId = params.harnessRuntime?.trim() || undefined;
  const runtimeAuthPlan =
    params.runtimeAuthPlan &&
    resolved.provider &&
    resolved.model &&
    agentRuntimeAuthPlanMatchesTarget(params.runtimeAuthPlan, {
      provider: resolved.provider,
      modelId: resolved.model,
    })
      ? params.runtimeAuthPlan
      : undefined;
  const processScopeKey = params.sessionKey?.trim();
  const activeProcessSessions =
    params.activeProcessSessions ??
    listActiveProcessSessionReferences({
      scopeKey: processScopeKey,
    });
  return {
    sessionKey: params.sessionKey ?? undefined,
    sandboxSessionKey: params.sandboxSessionKey,
    sandboxAgentId: params.sandboxAgentId,
    messageChannel: params.messageChannel ?? undefined,
    messageProvider: params.messageProvider ?? undefined,
    clientCaps: params.clientCaps,
    pinnedWidgetAuthoring: params.pinnedWidgetAuthoring,
    chatType: params.chatType ?? undefined,
    agentAccountId: params.agentAccountId ?? undefined,
    conversationRoutePeerId: params.conversationRoutePeerId,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    authProfileId: resolved.authProfileId,
    authProfileIdSource: params.authProfileIdSource,
    runtimeAuthPlan,
    agentHarnessId,
    modelSelectionLocked: params.modelSelectionLocked,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd ?? undefined,
    permissionMode: params.permissionMode,
    sessionRoot: params.sessionRoot,
    requireWorkspaceOnly: params.requireWorkspaceOnly,
    requireWritableSandbox: params.requireWritableSandbox,
    agentDir: params.agentDir,
    config: params.config,
    toolOverrides: params.toolOverrides,
    toolsAllow: params.toolsAllow,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId ?? undefined,
    provider: resolved.provider,
    runtimeProvider: resolved.runtimeProvider,
    model: resolved.model,
    modelFallbacksOverride: params.modelFallbacksOverride,
    thinkLevel: params.thinkLevel,
    reasoningLevel: params.reasoningLevel,
    execOverrides: params.execOverrides,
    bashElevated: params.bashElevated,
    extraSystemPrompt: params.extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    ownerNumbers: params.ownerNumbers,
    ...(activeProcessSessions.length > 0 ? { activeProcessSessions } : {}),
  };
}
