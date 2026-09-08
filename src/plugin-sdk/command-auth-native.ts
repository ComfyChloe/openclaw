/**
 * Public SDK subpath for native command specs, parsing, and authorization helpers.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import {
  resolveFastModeStateForResolvedModel,
  resolveFastModeStateFromModelParams,
} from "../agents/fast-mode.js";
import { modelKey } from "../shared/model-key.js";

export {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  listChatCommands,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  maybeResolveTextAlias,
  normalizeCommandBody,
  parseCommandArgs,
  serializeCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
export type {
  ChatCommandDefinition,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
  NativeCommandSpec,
} from "../auto-reply/commands-registry.js";
export type { CommandArgsParsing } from "../auto-reply/commands-registry.types.js";
export {
  hasControlCommand,
  shouldComputeCommandAuthorized,
} from "../auto-reply/command-detection.js";
export {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
} from "../channels/command-gating.js";
export { resolveNativeCommandSessionTargets } from "../channels/native-command-session-targets.js";
export {
  resolveCommandAuthorization,
  type CommandAuthorization,
} from "../auto-reply/command-auth.js";
export { resolveStoredModelOverride } from "../sessions/stored-model-overrides.js";
export { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
export {
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeSourceSuffix,
  formatFastModeStatusValue,
} from "../agents/fast-mode.js";
export type { ModelsProviderData } from "../auto-reply/reply/commands-models.js";
export { listSkillCommandsForAgents } from "../skills/discovery/chat-commands.js";
export { listProviderPluginCommandSpecs } from "../plugins/command-specs.js";

/** Resolve fast mode from a literal modelId or a legacy model reference. */
export function resolveFastModeState(
  params: Omit<Parameters<typeof resolveFastModeStateForResolvedModel>[0], "model"> &
    ({ modelId: string; model?: never } | { model: string; modelId?: never }),
): ReturnType<typeof resolveFastModeStateForResolvedModel> {
  if (params.modelId !== undefined) {
    return resolveFastModeStateForResolvedModel({ ...params, model: params.modelId });
  }
  const provider = params.provider.trim();
  const model = params.model.trim();
  // v2026.9.2 recognizes full refs without changing the exact authored key.
  // Keep this SDK input contract out of resolved model settings lookup.
  const key = normalizeLowercaseStringOrEmpty(model).startsWith(
    `${normalizeLowercaseStringOrEmpty(provider)}/`,
  )
    ? model
    : modelKey(provider, model);
  const agent =
    params.agentId && params.cfg ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  return resolveFastModeStateFromModelParams(
    params,
    params.cfg?.agents?.defaults?.models?.[key]?.params,
    agent?.models?.[key]?.params,
  );
}
