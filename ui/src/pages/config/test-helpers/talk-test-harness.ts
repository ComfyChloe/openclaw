import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import type { NativeDeviceSettingsCapability } from "../../../app/native-device-settings.ts";
import "../talk-page.ts";

export type TalkPageElement = HTMLElement & {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  updateComplete: Promise<boolean>;
  changeModel: (model: string | null) => void;
  changeProvider: (providerId: string | null) => void;
};

export type TalkMutationHarnessOptions = {
  nativeDeviceSettings?: NativeDeviceSettingsCapability;
  voiceWakeRequest?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ triggers: string[] }>;
  catalogRequest?: (
    requestIndex: number,
    catalog: TalkCatalogResult,
  ) => Promise<TalkCatalogResult> | TalkCatalogResult;
  configSnapshot?: { hash?: string | null; configRevisionHash?: string | null };
  activeProvider?: string | null;
  activeVoiceSelectionPolicy?: "allowlist-default";
  aliases?: string[];
  consultRouting?: string | null;
  defaultModel?: string;
  model?: string | null;
  openAIProviderModel?: string;
  provider?: string | null;
  transport?: string | null;
  transports?: TalkCatalogResult["transports"];
  unavailable?: boolean;
  voicesByModel?: Record<string, string[]>;
};

export function createTalkMutationHarness(options: TalkMutationHarnessOptions = {}) {
  const catalog = {
    modes: ["realtime"],
    transports: ["gateway-relay", "webrtc"],
    brains: ["agent-consult"],
    speech: { providers: [] },
    transcription: { providers: [] },
    realtime: {
      ready: true,
      activeProvider: options.activeProvider ?? "openai",
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          configured: true,
          aliases: options.aliases ?? [],
          models: [options.defaultModel ?? "gpt-live-test-canary"],
          voices: ["marin"],
          activeVoices: ["cove", "spruce"],
          activeVoiceSelectionPolicy: options.activeVoiceSelectionPolicy,
          voicesByModel: options.voicesByModel,
          transports: options.transports ?? ["gateway-relay"],
          defaultModel: options.defaultModel ?? "gpt-live-test-canary",
        },
        {
          id: "xai",
          label: "xAI",
          configured: true,
          aliases: [],
          models: ["grok-voice"],
          voices: ["ara"],
          activeVoices: ["xai-active"],
          transports: ["gateway-relay"],
          defaultModel: "grok-voice",
        },
      ],
    },
  } satisfies TalkCatalogResult;
  let catalogRequestIndex = 0;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method.startsWith("voicewake.") && options.voiceWakeRequest) {
      return options.voiceWakeRequest(method, params);
    }
    if (options.unavailable) {
      throw new Error("talk.catalog unavailable");
    }
    catalogRequestIndex += 1;
    return await (options.catalogRequest?.(catalogRequestIndex, catalog) ?? catalog);
  });
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: options.voiceWakeRequest
      ? {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: ["operator.admin"] },
          features: { methods: ["voicewake.get", "voicewake.set"] },
        }
      : null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gatewayListeners = new Set<() => void>();
  const gatewayConnection = { gatewayUrl: "wss://gateway.example.test" };
  const hello = snapshot.hello;
  const configForm = {
    talk: {
      realtime: {
        provider: options.provider === undefined ? "openai" : options.provider,
        ...(options.model === null
          ? {}
          : { model: options.model === undefined ? "gpt-realtime-2.1" : options.model }),
        transport: options.transport === undefined ? "gateway-relay" : options.transport,
        consultRouting: options.consultRouting,
        providers: options.openAIProviderModel
          ? { openai: { model: options.openAIProviderModel } }
          : undefined,
      },
    },
  };
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configForm,
      configSnapshot: options.configSnapshot ?? { hash: "hash" },
      configLoading: false,
      configSaving: false,
      configApplying: false,
    },
    patchForm: vi.fn(),
    removeFormValue: vi.fn(),
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const context = {
    nativeDeviceSettings: options.nativeDeviceSettings ?? null,
    gateway: {
      snapshot,
      connection: gatewayConnection,
      subscribe: (listener: () => void) => {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    },
    runtimeConfig,
  } as unknown as ApplicationContext;
  const page = document.createElement("openclaw-talk-settings") as TalkPageElement;
  page.context = context;
  page.configObject = configForm;
  document.body.append(page);
  return {
    page,
    request,
    runtimeConfig,
    setConfigHash: (hash: string | null) => {
      runtimeConfig.state.configSnapshot.hash = hash;
      runtimeConfigListeners.forEach((notify) => notify());
    },
    setGatewayConnection: (connected: boolean, gatewayUrl = gatewayConnection.gatewayUrl) => {
      gatewayConnection.gatewayUrl = gatewayUrl;
      snapshot.phase = connected ? "connected" : "reconnecting";
      snapshot.hello = connected ? hello : null;
      gatewayListeners.forEach((notify) => notify());
    },
  };
}
