// Command status runtime helpers collect agent/session state for plugin command status output.
import { listAgentEntries, resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveReasoningDefault } from "../agents/model-selection.js";
import { resolveThinkingDefaultCore } from "../agents/model-thinking-default-core.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { buildStatusReply } from "../auto-reply/reply/commands-status.js";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import { resolveDefaultModel } from "../auto-reply/reply/directive-handling.defaults.js";
import { resolveCurrentDirectiveLevels } from "../auto-reply/reply/directive-handling.levels.js";
import { resolveRuntimeNormalization } from "../auto-reply/reply/model-runtime-normalization.js";
import { resolveStoredRuntimeModelSelection } from "../auto-reply/reply/stored-model-override.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewaySessionEntryReadOnly } from "../gateway/session-utils.js";
import { readStoredModelOverride } from "../sessions/stored-model-overrides.js";

/** Inputs for rendering direct-session status replies outside the active channel turn. */
export type ResolveDirectStatusReplyForSessionParams = {
  /** Caller config used when the target session cannot load a config snapshot. */
  cfg: OpenClawConfig;
  /** Requested session key; whitespace-only keys produce no status reply. */
  sessionKey: string;
  /** Channel/surface name used when rendering the status command context. */
  channel: string;
  /** Optional sender id for command-context rendering and audit output. */
  senderId?: string;
  /** Whether the requester is an owner and may see owner-only session state. */
  senderIsOwner: boolean;
  /** Whether the requester passed channel allowlist/authorization checks. */
  isAuthorizedSender: boolean;
  /** Whether the status reply is being rendered for a group conversation. */
  isGroup: boolean;
  /** Channel default activation mode used by the status renderer for groups. */
  defaultGroupActivation: () => "always" | "mention";
};

/**
 * Builds a direct `/status` reply for an arbitrary session key.
 * Reads captured selection and capability facts without running admission or
 * repairing session pins. Unauthorized requests are suppressed before lookup.
 */
export async function resolveDirectStatusReplyForSessionCore(
  params: ResolveDirectStatusReplyForSessionParams,
): Promise<ReplyPayload | undefined> {
  const requestedSessionKey = params.sessionKey.trim();
  if (!requestedSessionKey || !params.isAuthorizedSender) {
    return undefined;
  }

  const statusLoaded = loadGatewaySessionEntryReadOnly(requestedSessionKey);
  const statusCfg = statusLoaded.cfg ?? params.cfg;
  const statusSessionKey = statusLoaded.canonicalKey;
  const statusEntry = statusLoaded.entry;
  const statusAgentId = resolveSessionAgentId({
    sessionKey: statusSessionKey,
    config: statusCfg,
  });
  const agentCfg = statusCfg.agents?.defaults;
  const agentEntry = listAgentEntries(statusCfg).find(
    (entry) => entry.id?.trim().toLowerCase() === statusAgentId,
  );
  const { getAvailablePreparedModelCatalogSnapshot } =
    await import("../agents/prepared-model-catalog.js");
  const preparedModelCatalog = getAvailablePreparedModelCatalogSnapshot({
    config: statusCfg,
    agentId: statusAgentId,
  });
  const { manifestPlugins } = resolveRuntimeNormalization(statusCfg);
  // Missing prepared metadata is a known absence for this read, not permission to discover it.
  const normalization = {
    manifestPlugins: manifestPlugins ?? [],
    resolvedModelCatalog: preparedModelCatalog?.entries,
    allowManifestNormalization: true,
    allowPluginNormalization: false,
  };
  const { defaultProvider, defaultModel } = resolveDefaultModel({
    cfg: statusCfg,
    agentId: statusAgentId,
    ...normalization,
  });
  const selectedProvider =
    statusEntry?.providerOverride?.trim() || statusEntry?.modelProvider?.trim() || defaultProvider;
  const selectedModel =
    statusEntry?.modelOverride?.trim() || statusEntry?.model?.trim() || defaultModel;
  const modelPolicy = createModelVisibilityPolicy({
    cfg: statusCfg,
    agentId: statusAgentId,
    catalog: preparedModelCatalog?.entries ?? [],
    defaultProvider,
    defaultModel,
    ...normalization,
  });
  const thinkingCatalog = modelPolicy.allowedCatalog;
  const storedOverride = readStoredModelOverride({
    sessionEntry: statusEntry,
    sessionStore: statusLoaded.store,
    sessionKey: statusSessionKey,
    parentSessionKey: statusEntry?.parentSessionKey,
  });
  const thinkingSelection = storedOverride
    ? resolveStoredRuntimeModelSelection({
        cfg: statusCfg,
        sessionEntry: statusEntry,
        storedOverride,
        defaultProvider,
        catalog: preparedModelCatalog?.entries ?? thinkingCatalog,
        aliasIndex: modelPolicy.selectionAliasIndex,
        normalization,
      })
    : { provider: selectedProvider, model: selectedModel };
  const resolveDefaultThinkingLevel = async () =>
    agentEntry?.thinkingDefault ??
    resolveThinkingDefaultCore({
      cfg: statusCfg,
      agentId: statusAgentId,
      ...thinkingSelection,
      catalog: thinkingCatalog,
      providerPolicySource: "active",
    });
  const {
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = await resolveCurrentDirectiveLevels({
    sessionEntry: statusEntry,
    agentEntry,
    agentCfg,
    resolveDefaultThinkingLevel,
  });
  let resolvedReasoningLevel = currentReasoningLevel;
  const hasAgentReasoningDefault =
    (agentEntry?.reasoningDefault !== undefined && agentEntry.reasoningDefault !== null) ||
    (agentCfg?.reasoningDefault !== undefined && agentCfg.reasoningDefault !== null);
  const sessionReasoningExplicitlySet =
    statusEntry?.reasoningLevel !== undefined && statusEntry.reasoningLevel !== null;
  const reasoningExplicitlySet = sessionReasoningExplicitlySet || hasAgentReasoningDefault;
  if (!reasoningExplicitlySet && resolvedReasoningLevel === "off" && currentThinkLevel === "off") {
    resolvedReasoningLevel = resolveReasoningDefault({
      ...thinkingSelection,
      catalog: thinkingCatalog,
    });
  }

  const command: CommandContext = {
    surface: params.channel,
    channel: params.channel,
    ownerList: [],
    senderIsOwner: params.senderIsOwner,
    isAuthorizedSender: params.isAuthorizedSender,
    senderId: params.senderId,
    rawBodyNormalized: "/status",
    commandBodyNormalized: "/status",
  };

  return await buildStatusReply({
    cfg: statusCfg,
    agentId: statusAgentId,
    command,
    sessionEntry: statusEntry,
    sessionKey: statusSessionKey,
    parentSessionKey: statusEntry?.parentSessionKey,
    sessionScope: statusCfg.session?.scope,
    storePath: statusLoaded.storePath,
    provider: selectedProvider,
    model: selectedModel,
    contextTokens: statusEntry?.contextTokens ?? 0,
    thinkingCatalog,
    resolvedThinkLevel: currentThinkLevel,
    resolvedFastMode: currentFastMode,
    resolvedVerboseLevel: currentVerboseLevel ?? "off",
    resolvedReasoningLevel,
    resolvedElevatedLevel: currentElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup: params.isGroup,
    defaultGroupActivation: params.defaultGroupActivation,
  });
}
