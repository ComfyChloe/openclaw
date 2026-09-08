/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawSchema } from "../../../../src/config/zod-schema.ts";
import { resolveProviderRawConfig } from "../../../../src/plugin-sdk/provider-selection-runtime.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import {
  createConfigServerMock,
  createGatewayHarness,
} from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTalkMutationHarness } from "./test-helpers/talk-test-harness.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Talk auth picker save/load boundary", () => {
  const disposals = new Set<() => void>();
  afterEach(() => {
    for (const dispose of disposals) {
      dispose();
    }
  });

  async function mount(
    server: ReturnType<typeof createConfigServerMock>,
    cold = false,
    selectedAuthMethod?: string,
    identity = { id: "openai", aliases: ["openai-preview"] },
  ) {
    const harness = createTalkMutationHarness({
      aliases: identity.aliases,
      catalogRequest: (_index, catalog) => ({
        ...catalog,
        realtime: {
          ...catalog.realtime,
          ready: cold ? false : catalog.realtime.ready,
          activeProvider: identity.id,
          providers: catalog.realtime.providers.map((provider) =>
            provider.id === "openai"
              ? {
                  ...provider,
                  id: identity.id,
                  configured: cold ? false : provider.configured,
                  selectedAuthMethod,
                  authMethods: [
                    { id: "oauth", label: "OAuth" },
                    { id: "api-key", label: "API key" },
                  ],
                }
              : provider,
          ),
        },
      }),
    });
    harness.page.remove();
    const request = vi.fn((method: string, params?: unknown) =>
      method === "talk.catalog"
        ? harness.request(method, params as Record<string, unknown>)
        : server.request(method, params),
    );
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    Object.assign(gateway.snapshot, {
      assistantAgentId: "chosen",
      sessionKey: "agent:chosen:thread",
    });
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const dispose = () => {
      if (!disposals.delete(dispose)) {
        return;
      }
      harness.page.remove();
      runtimeConfig.dispose();
    };
    disposals.add(dispose);
    await runtimeConfig.ensureLoaded();
    harness.page.context = {
      ...harness.page.context,
      gateway: { ...gateway, connection: { gatewayUrl: "wss://gateway.example.test" } },
      runtimeConfig,
    } as unknown as ApplicationContext;
    harness.page.configObject = runtimeConfig.state.configForm ?? {};
    runtimeConfig.subscribe((state) => {
      harness.page.configObject = state.configForm ?? {};
    });
    document.body.append(harness.page);
    const picker = () =>
      harness.page.querySelector<HTMLSelectElement>(
        `select[aria-label="${t("talkPage.auth.title")}"]`,
      )!;
    await vi.waitFor(() => expect(picker()?.options.length).toBe(3));
    return { ...harness, runtimeConfig, picker, dispose, request, snapshot: gateway.snapshot };
  }

  it.each([
    { method: "oauth", provider: undefined, cold: true },
    { method: "api-key", provider: "openai-preview", cold: false },
    { method: "", provider: "openai-preview", cold: false },
  ])(
    "saves and reloads '$method' without replacing unrelated selections",
    async ({ method, provider, cold }) => {
      const providers: Record<string, Record<string, unknown>> = {
        openai: { authMethod: "api-key", model: "provider-model" },
        ...(provider
          ? {
              "openai-preview": { authMethod: "oauth", voice: "provider-voice" },
              xai: { model: "grok-voice", voice: "ara" },
            }
          : {}),
      };
      const initial = {
        agents: { entries: { chosen: {} } },
        talk: {
          realtime: {
            ...(provider ? { provider } : {}),
            model: "gpt-realtime-2.1",
            speakerVoice: "spruce",
            transport: "webrtc",
            consultRouting: "provider-direct",
            providers,
          },
        },
      };
      expect(OpenClawSchema.parse(initial)).toMatchObject(initial);
      // Only the RPC server is simulated; draft mutation, serialization, save and reload are real UI owners.
      const server = createConfigServerMock();
      await server.request("config.set", {
        raw: JSON.stringify(initial),
        baseHash: server.currentHash(),
      });
      server.submissions.length = 0;
      const first = await mount(server, cold);
      expect(first.picker().value).toBe(providers[provider ?? "openai"]!.authMethod);
      expect(first.picker().disabled).toBe(false);
      const patch = vi.spyOn(first.runtimeConfig, "patchForm");
      const remove = vi.spyOn(first.runtimeConfig, "removeFormValue");
      const baseHash = server.currentHash();
      first.picker().value = method;
      first.picker().dispatchEvent(new Event("change", { bubbles: true }));
      const expected = structuredClone(initial);
      delete expected.talk.realtime.providers.openai!.authMethod;
      if (provider) {
        delete expected.talk.realtime.providers["openai-preview"]!.authMethod;
      }
      if (method) {
        expected.talk.realtime.providers[provider ?? "openai"]!.authMethod = method;
      }
      expect(OpenClawSchema.parse(expected)).toMatchObject(expected);
      expect(first.runtimeConfig.state.configForm).toEqual(expected);
      expect(remove.mock.calls).toEqual(
        (provider ? [provider, "openai"] : ["openai"]).map((key) => [
          ["talk", "realtime", "providers", key, "authMethod"],
        ]),
      );
      expect(patch.mock.calls).toEqual(
        method
          ? [[["talk", "realtime", "providers", provider ?? "openai", "authMethod"], method]]
          : [],
      );
      expect(first.snapshot).toMatchObject({
        assistantAgentId: "chosen",
        sessionKey: "agent:chosen:thread",
      });
      await expect(first.runtimeConfig.save()).resolves.toBe(true);
      expect(server.submissions).toHaveLength(1);
      expect(server.submissions[0]?.baseHash).toBe(baseHash);
      expect(JSON.parse(server.submissions[0]!.raw)).toEqual(expected);
      first.dispose();
      const reloaded = await mount(server, cold);
      expect(reloaded.request).toHaveBeenCalledWith("config.get", {});
      expect(reloaded.runtimeConfig.state.configForm).toEqual(expected);
      expect(reloaded.picker().value).toBe(method);
      expect(server.submissions).toHaveLength(1);
    },
  );

  it.each([
    {
      provider: "openai-preview",
      canonicalAuth: "oauth",
      aliasAuth: undefined,
      expectedAuth: "oauth",
    },
    {
      provider: "openai-preview",
      canonicalAuth: "oauth",
      aliasAuth: "api-key",
      expectedAuth: "api-key",
    },
    { provider: undefined, canonicalAuth: undefined, aliasAuth: "oauth", expectedAuth: "oauth" },
    { provider: undefined, canonicalAuth: "api-key", aliasAuth: "oauth", expectedAuth: "api-key" },
    { provider: "openai", canonicalAuth: undefined, aliasAuth: "oauth", expectedAuth: "" },
  ])(
    "matches inherited auth and keeps Auto drafts authoritative ($provider/$canonicalAuth/$aliasAuth)",
    async ({ provider, canonicalAuth, aliasAuth, expectedAuth }) => {
      const initial = {
        agents: { entries: { chosen: {} } },
        talk: {
          realtime: {
            ...(provider ? { provider } : {}),
            model: "gpt-realtime-2.1",
            speakerVoice: "spruce",
            transport: "webrtc",
            consultRouting: "provider-direct",
            providers: {
              openai: {
                model: "provider-model",
                apiKey: { source: "env", provider: "default", id: "SAVED_TALK_KEY" },
                ...(canonicalAuth ? { authMethod: canonicalAuth } : {}),
              },
              "openai-preview": {
                voice: "provider-voice",
                ...(aliasAuth ? { authMethod: aliasAuth } : {}),
              },
              xai: { model: "grok-voice", voice: "ara" },
            },
          },
        },
      };
      // Exercise the real Gateway config-merge contract, not a mirrored test resolver.
      expect(
        resolveProviderRawConfig({
          providerId: "openai",
          providerAliases: ["openai-preview"],
          configuredProviderId: provider,
          providerConfigs: initial.talk.realtime.providers,
        }).authMethod ?? "",
      ).toBe(expectedAuth);
      const server = createConfigServerMock();
      await server.request("config.set", {
        raw: JSON.stringify(initial),
        baseHash: server.currentHash(),
      });
      server.submissions.length = 0;
      const { page, picker, runtimeConfig, snapshot } = await mount(server, false, expectedAuth);
      expect(picker().value).toBe(expectedAuth);
      expect(runtimeConfig.state.configForm).toEqual(initial);
      expect(runtimeConfig.state.configFormDirty).toBe(false);
      expect(server.submissions).toHaveLength(0);
      // The catalog still carries the saved choice; an unsaved Automatic selection wins.
      picker().value = "";
      picker().dispatchEvent(new Event("change", { bubbles: true }));
      await page.updateComplete;
      const expected = structuredClone(initial);
      delete expected.talk.realtime.providers.openai.authMethod;
      delete expected.talk.realtime.providers["openai-preview"].authMethod;
      expect(picker().value).toBe("");
      expect(runtimeConfig.state.configForm).toEqual(expected);
      expect(snapshot).toMatchObject({
        assistantAgentId: "chosen",
        sessionKey: "agent:chosen:thread",
      });
      expect(server.submissions).toHaveLength(0);
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(server.submissions).toHaveLength(1);
      const submission = server.submissions[0];
      if (!submission) {
        throw new Error("Expected saved configuration");
      }
      expect(JSON.parse(submission.raw)).toEqual(expected);
    },
  );

  it.each([
    { provider: "example", method: "oauth" },
    { provider: "example", method: "api-key" },
    { provider: "example-alias", method: "api-key" },
    { provider: undefined, method: "api-key" },
    { provider: undefined, method: "" },
  ])("round-trips alias-only provider config ($provider/$method)", async ({ provider, method }) => {
    const identity = { id: "example", aliases: ["example-alias"] };
    const initial = {
      talk: {
        realtime: {
          ...(provider ? { provider: "example-alias" } : {}),
          model: "custom-model",
          speakerVoice: "custom-voice",
          transport: "webrtc",
          providers: {
            "example-alias": { authMethod: "oauth", model: "alias-model", voice: "alias-voice" },
            ...(provider ? { unrelated: { authMethod: "api-key", model: "other-model" } } : {}),
          } as Record<string, Record<string, unknown>>,
        },
      },
    };
    expect(OpenClawSchema.parse(initial)).toMatchObject(initial);
    const server = createConfigServerMock();
    await server.request("config.set", {
      raw: JSON.stringify(initial),
      baseHash: server.currentHash(),
    });
    server.submissions.length = 0;
    const first = await mount(server, false, undefined, identity);
    if (provider) {
      // Enter canonical selection through the real draft, before its provider entry exists.
      first.runtimeConfig.patchForm(["talk", "realtime", "provider"], provider);
      await first.page.updateComplete;
    }
    first.picker().value = method;
    first.picker().dispatchEvent(new Event("change", { bubbles: true }));
    await expect(first.runtimeConfig.save()).resolves.toBe(true);
    expect(server.submissions).toHaveLength(1);
    const saved = JSON.parse(server.submissions[0]!.raw);
    first.dispose();
    const reloaded = await mount(server, false, undefined, identity);
    expect(reloaded.runtimeConfig.state.configForm).toEqual(saved);
    expect(
      resolveProviderRawConfig({
        providerId: identity.id,
        providerAliases: identity.aliases,
        configuredProviderId: provider,
        providerConfigs: saved.talk.realtime.providers,
      }).authMethod ?? "",
    ).toBe(method);
    expect(reloaded.picker().value).toBe(method);
    const expected = structuredClone(initial);
    if (provider) {
      expected.talk.realtime.provider = provider;
    }
    delete expected.talk.realtime.providers["example-alias"]!.authMethod;
    if (method) {
      const key = provider ?? "example-alias";
      expected.talk.realtime.providers[key] = {
        ...expected.talk.realtime.providers[key],
        authMethod: method,
      };
    }
    expect(saved).toEqual(expected);
    expect(OpenClawSchema.parse(saved)).toMatchObject(expected);
  });

  it("does not restore stale catalog auth when the draft has no effective provider entry", async () => {
    const identity = { id: "example", aliases: ["example-alias"] };
    const server = createConfigServerMock();
    const initial = {
      talk: {
        realtime: {
          providers: { "example-alias": { authMethod: "oauth" } },
        },
      },
    };
    await server.request("config.set", {
      raw: JSON.stringify(initial),
      baseHash: server.currentHash(),
    });
    const { picker, page, runtimeConfig } = await mount(server, false, "oauth", identity);
    expect(picker().value).toBe("oauth");
    // Raw settings can select the canonical provider before a new catalog arrives.
    runtimeConfig.patchForm(["talk", "realtime", "provider"], identity.id);
    await page.updateComplete;
    expect(
      resolveProviderRawConfig({
        providerId: identity.id,
        providerAliases: identity.aliases,
        configuredProviderId: identity.id,
        providerConfigs: initial.talk.realtime.providers,
      }).authMethod,
    ).toBeUndefined();
    expect(picker().value).toBe("");
  });

  it("rejects an unsupported option at the selection callback without a config write", async () => {
    const server = createConfigServerMock();
    const { picker, runtimeConfig } = await mount(server);
    expect([...picker().options].map((option) => option.value)).toEqual(["", "oauth", "api-key"]);
    const before = structuredClone(runtimeConfig.state.configForm);
    const patch = vi.spyOn(runtimeConfig, "patchForm");
    const remove = vi.spyOn(runtimeConfig, "removeFormValue");
    // Simulate a stale/malformed option reaching the same DOM callback; the catalog never advertises it.
    picker().add(new Option("Unsupported", "unsupported"));
    picker().value = "unsupported";
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    expect(patch).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(runtimeConfig.state.configForm).toEqual(before);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(server.submissions).toHaveLength(0);
  });
});
