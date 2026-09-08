import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";
import {
  projectDefaultInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";
import { canonicalizeSetupModelRef } from "./setup-inference-plan-helpers.js";

function devConfig(agentRuntime?: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: "openai/gpt-5.5" },
      entries: {
        dev: { default: true, workspace: "/tmp/x" },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...(agentRuntime ? { agentRuntime: { id: agentRuntime } } : {}),
          models: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    },
  };
}

afterEach(() => {
  clearAgentHarnesses();
});

describe("resolveSystemAgentConfiguredRouteFromConfig", () => {
  it.each(["custom/latest", "custom/Middle", "fast"])(
    "keeps prepared catalog identity for source-agent input %s",
    async (primary) => {
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom",
            providers: ["custom"],
            modelIdNormalization: {
              providers: { custom: { aliases: { latest: "Middle", middle: "Wrong" } } },
            },
          },
        ],
      });
      const resolvedModelCatalog = [{ provider: "custom", id: "Middle" }];
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "other/default" },
          entries: {
            main: {
              model: `${primary}@custom:selected`,
              models: { "custom/Middle": { alias: "fast" } },
            },
          },
        },
        models: {
          providers: {
            custom: {
              baseUrl: "https://fixture.invalid/v1",
              models: [],
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      };
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const route = await resolveSystemAgentConfiguredRouteFromConfig(cfg, "main", {
          pluginMetadataPlugins: metadataSnapshot.plugins,
          resolvedModelCatalog,
        });
        expect(route).toMatchObject({
          provider: "custom",
          model: "Middle",
          modelLabel: "custom/Middle",
          authProfileId: "custom:selected",
          agentId: "main",
        });
        for (const raw of [primary, "custom/Middle@custom:selected"]) {
          expect(
            canonicalizeSetupModelRef({
              cfg,
              raw,
              agentId: "main",
              defaultProvider: "custom",
              manifestPlugins: metadataSnapshot,
              resolvedModelCatalog,
            }),
          ).toBe("custom/Middle");
        }
      });
    },
  );

  it("treats a setup-materialized first-agent roster as inference-route neutral", async () => {
    const withoutRoster: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    const withFirstAgent: OpenClawConfig = {
      agents: {
        defaults: withoutRoster.agents?.defaults,
        entries: {
          main: {
            default: true,
            workspace: "/tmp/openclaw-main",
            agentDir: resolveAgentDir(withoutRoster, "main"),
          },
        },
      },
    };

    expect(
      sameDefaultInferenceRoute(
        await projectDefaultInferenceRoute(withoutRoster),
        await projectDefaultInferenceRoute(withFirstAgent),
      ),
    ).toBe(true);
  });

  it.each([
    { label: "main", agentIds: ["main"], owner: "main" },
    { label: "non-main", agentIds: ["dev"], owner: "dev" },
    { label: "multi-agent", agentIds: ["main", "dev"], owner: "dev" },
  ])(
    "admits the route owner and reserved agent for a $label roster",
    async ({ agentIds, owner }) => {
      const config = devConfig();
      config.agents = {
        ...config.agents,
        entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      };
      const route = await resolveSystemAgentConfiguredRouteFromConfig(config, owner);

      expect(route?.agentId).toBe(owner);
      for (const agentId of [owner, SYSTEM_AGENT_ID]) {
        expect(
          resolveRunWorkspaceDir({
            workspaceDir: "/tmp/x",
            agentId,
            config: route!.runConfig,
          }).agentId,
        ).toBe(agentId);
      }
    },
  );

  it("keeps implicit harness selection fallible while forcing explicit policy", async () => {
    const supports = vi.fn((ctx: { modelProvider?: { requestTransportOverrides?: string } }) =>
      ctx.modelProvider?.requestTransportOverrides === "present"
        ? { supported: false as const, reason: "authored request transport overrides" }
        : { supported: true as const, priority: 100 },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: supports as never,
      runAttempt: vi.fn() as never,
    });
    const preparedModelProvider = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "present" as const,
    };

    const implicitRoute = await resolveSystemAgentConfiguredRouteFromConfig(devConfig());
    expect(implicitRoute).toMatchObject({ runner: "embedded" });
    expect(implicitRoute).not.toHaveProperty("agentHarnessRuntimeOverride");
    expect(
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: preparedModelProvider,
        config: implicitRoute!.runConfig,
        agentHarnessRuntimeOverride:
          implicitRoute!.runner === "embedded"
            ? implicitRoute!.agentHarnessRuntimeOverride
            : undefined,
      }).id,
    ).toBe("openclaw");

    const explicitRoute = await resolveSystemAgentConfiguredRouteFromConfig(devConfig("codex"));
    expect(explicitRoute).toMatchObject({
      runner: "embedded",
      agentHarnessRuntimeOverride: "codex",
    });
    expect(() =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: preparedModelProvider,
        config: explicitRoute!.runConfig,
        agentHarnessRuntimeOverride:
          explicitRoute!.runner === "embedded"
            ? explicitRoute!.agentHarnessRuntimeOverride
            : undefined,
      }),
    ).toThrow("authored request transport overrides");
  });
});
