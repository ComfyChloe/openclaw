import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { resolveProviderRefOwnership } from "../../../plugins/providers.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { getPluginRuntimeGenerationRegistry } from "../../../plugins/runtime/generation-scope.js";
import type { AgentHarnessPluginSelection } from "../../harness/runtime-plugin-load-plan.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLeaseOptions,
} from "../../prepared-model-runtime.types.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";

const state = vi.hoisted(() => ({
  admittedConfig: undefined as OpenClawConfig | undefined,
  metadata: undefined as ReturnType<typeof createPluginMetadataSnapshotFixture> | undefined,
  registry: undefined as ReturnType<typeof createEmptyPluginRegistry> | undefined,
  derived: [] as readonly AgentHarnessPluginSelection[],
  acquire: vi.fn(),
  release: vi.fn(),
  live: vi.fn(),
  normalize: vi.fn(),
}));

vi.mock("../../prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: (...args: unknown[]) => state.acquire(...args),
  acquireReadOnlyPreparedModelRuntime: (...args: unknown[]) => state.acquire(...args),
}));
vi.mock("../../provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (...args: unknown[]) => state.normalize(...args),
}));
vi.mock("./subagent-spawn-deps.js", () => ({
  getSubagentSpawnDeps: () => ({
    loadPreparedModelCatalog: (...args: unknown[]) => state.live(...args),
    resolveProviderRefOwnership: (...args: Parameters<typeof resolveProviderRefOwnership>) =>
      resolveProviderRefOwnership(...args),
  }),
}));
vi.mock("./subagent-spawn.runtime.js", () => ({
  normalizeDeliveryContext: (input: unknown) => input,
  resolveAgentConfig: (cfg: OpenClawConfig, id: string) => cfg.agents?.entries?.[id],
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
}));
vi.mock("./subagent-spawn-requester-prefs.js", () => ({
  readRequesterThinkingLevel: () => undefined,
  readRequesterFastMode: () => undefined,
}));

function config(primary: string, subagent?: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary }, ...(subagent ? { subagents: { model: subagent } } : {}) },
    },
  };
}

beforeEach(() => {
  state.admittedConfig = undefined;
  state.metadata = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "provider-a", providers: ["provider-a"] },
      { id: "provider-b", providers: ["provider-b"] },
      { id: "cli-fixture", cliBackends: ["cli-fixture"] },
    ],
  });
  state.registry = createEmptyPluginRegistry();
  state.derived = [];
  state.release.mockReset();
  state.normalize.mockReset().mockReturnValue(undefined);
  state.live.mockReset().mockRejectedValue(new Error("unexpected live catalog read"));
  state.acquire
    .mockReset()
    .mockImplementation(
      async (input: PreparedModelRuntimeInput, options: PreparedModelRuntimeLeaseOptions) => {
        expect(options.catalogMode).toBe("static");
        const cfg = state.admittedConfig ?? input.config;
        const metadataSnapshot = expectDefined(state.metadata, "prepared fixture metadata");
        state.derived =
          options.deriveRuntimePluginSelections?.({ config: cfg, metadataSnapshot }) ?? [];
        const snapshot = {
          config: cfg,
          agentId: input.agentId,
          agentDir: input.agentDir,
          workspaceDir: input.workspaceDir ?? "/tmp/spawn-owned-workspace",
          metadataSnapshot,
          pluginRegistry: state.registry,
          modelCatalog: { entries: [], routeVariants: [] },
          isCurrent: () => true,
          createStores: () => ({ authStorage: {}, modelRegistry: {} }),
        };
        return {
          snapshot,
          pluginGeneration: { pluginMetadataSnapshot: metadataSnapshot },
          release: state.release,
        };
      },
    );
});

function plan(
  cfg: OpenClawConfig,
  request: { model?: string; outputSchema?: Record<string, unknown> } = {},
) {
  return resolveSubagentChildPlan({
    cfg,
    request: { task: "fixture", ...request },
    ctx: { requesterThinkingLevel: "off" },
    requesterInternalKey: "agent:main:main",
    requesterAgentId: "main",
    targetAgentId: "main",
    sandboxMode: "inherit",
    swarmEnabled: false,
  });
}

function selected(result: Awaited<ReturnType<typeof plan>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.result.error);
  }
  return result.resolved.modelPlan;
}

describe("spawn prepared model ownership", () => {
  it.each(["provider-a/base-a", "cli-fixture/Arbitrary/Case"])(
    "keeps default %s off live discovery",
    async (primary) => {
      const result = selected(await plan(config(primary)));
      expect(result.resolvedModel).toBe(primary);
      expect(state.live).not.toHaveBeenCalled();
      expect(state.derived).toEqual([
        {
          provider: primary.split("/")[0],
          modelId: primary.slice(primary.indexOf("/") + 1),
          agentId: "main",
        },
      ]);
      expect(state.release).toHaveBeenCalledTimes(1);
    },
  );

  it("derives and selects cfgB's subagent provider under its retained runtime-only hook", async () => {
    const cfgA = config("provider-a/base-a");
    state.admittedConfig = config("provider-a/base-a", "provider-b/runtime-alias");
    const registry = state.registry;
    state.normalize.mockImplementation(({ provider, context }) => {
      if (provider !== "provider-b" || context.modelId !== "runtime-alias") {
        return undefined;
      }
      expect(getPluginRuntimeGenerationRegistry()).toBe(registry);
      expect(state.derived).toEqual([
        { provider: "provider-b", modelId: "runtime-alias", agentId: "main" },
      ]);
      return "middle-b";
    });
    const result = selected(await plan(cfgA));
    expect(result.resolvedModel).toBe("provider-b/middle-b");
    expect(result.initialSessionPatch).toMatchObject({
      providerOverride: "provider-b",
      modelOverride: "middle-b",
      modelOverrideFallbackOriginProvider: "provider-b",
      modelOverrideFallbackOriginModel: "middle-b",
    });
    expect(state.live).not.toHaveBeenCalled();
    expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps explicit/outputSchema=%s live proof inside the selected generation",
    async (outputSchema) => {
      const cfg = config("provider-b/runtime-alias");
      const registry = state.registry;
      state.live.mockImplementation(async (input) => {
        expect(getPluginRuntimeGenerationRegistry()).toBe(registry);
        expect(input).toMatchObject({
          config: cfg,
          providerDiscoveryProviderIds: ["provider-b"],
          scopedLiveProviderDiscovery: true,
        });
        await Promise.resolve();
        state.registry = createEmptyPluginRegistry();
        expect(getPluginRuntimeGenerationRegistry()).toBe(registry);
        return [];
      });
      state.normalize.mockImplementation(({ provider, context }) => {
        if (provider !== "provider-b" || context.modelId !== "runtime-alias") {
          return undefined;
        }
        expect(getPluginRuntimeGenerationRegistry()).toBe(registry);
        return "middle-b";
      });
      const result = selected(
        await plan(
          cfg,
          outputSchema
            ? { outputSchema: { type: "object" } }
            : { model: "provider-b/runtime-alias" },
        ),
      );
      expect(result.resolvedModel).toBe("provider-b/middle-b");
      expect(state.live).toHaveBeenCalledTimes(1);
      expect(state.release).toHaveBeenCalledTimes(1);
    },
  );
});
