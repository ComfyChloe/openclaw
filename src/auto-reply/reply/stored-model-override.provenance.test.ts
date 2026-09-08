import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { readStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import { resolveStoredRuntimeModelSelection } from "./stored-model-override.js";

const normalizeRuntime = vi.hoisted(() => vi.fn());
vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeRuntime,
}));

beforeEach(() => {
  normalizeRuntime.mockReset();
});

const catalog: ModelCatalogEntry[] = [{ provider: "custom", id: "final", name: "Other model" }];
const aliasIndex = { byAlias: new Map(), byKey: new Map() };

function project(source: "manifest" | "runtime", providerOverride: string | undefined) {
  const entry: SessionEntry = {
    sessionId: "stored-selection",
    updatedAt: 1,
    providerOverride,
    modelOverride: providerOverride ? "middle" : "custom/latest",
  };
  const aliases = { latest: "middle", middle: "final" };
  const normalization = {
    manifestPlugins:
      source === "manifest"
        ? [{ modelIdNormalization: { providers: { custom: { aliases } } } }]
        : [],
    resolvedModelCatalog: catalog,
    allowPluginNormalization: source === "runtime",
  };
  if (source === "runtime") {
    normalizeRuntime.mockImplementation(({ context }: { context: { modelId: string } }) =>
      context.modelId === "latest" ? "middle" : context.modelId === "middle" ? "final" : undefined,
    );
  }
  const stored = readStoredModelOverride({
    sessionEntry: entry,
  });
  expect(stored).not.toBeNull();
  const selected = resolveStoredRuntimeModelSelection({
    cfg: {},
    sessionEntry: entry,
    storedOverride: stored!,
    defaultProvider: "openai",
    catalog,
    aliasIndex,
    normalization,
  });
  return { stored, selected, entry };
}

describe("saved model normalization ownership", () => {
  it.each([
    { source: "manifest", providerOverride: "custom" },
    { source: "manifest", providerOverride: undefined },
    { source: "runtime", providerOverride: "custom" },
    { source: "runtime", providerOverride: undefined },
  ] as const)(
    "preserves selected tuples and decodes $source input (provider: $providerOverride)",
    ({ source, providerOverride }) => {
      const { stored, selected, entry } = project(source, providerOverride);
      expect(selected, JSON.stringify({ stored, selected })).toMatchObject({
        provider: "custom",
        model: "middle",
        routeResolution: "resolved",
      });
      expect(entry.modelOverride).toBe(providerOverride ? "middle" : "custom/latest");
      expect(entry.modelOverrideRouteResolution).toBeUndefined();
    },
  );
});

it.each([
  { input: "custom/Model", resolution: "raw", provider: "custom", model: "Model" },
  { input: "openrouter:auto", resolution: "raw", provider: "openrouter", model: "openrouter/auto" },
  { input: "openrouter/auto", resolution: "raw", provider: "openrouter", model: "openrouter/auto" },
  {
    input: "openrouter:auto",
    resolution: "resolved",
    provider: "openrouter",
    model: "openrouter/auto",
  },
  {
    input: "openrouter/openrouter/auto",
    resolution: "resolved",
    provider: "openrouter",
    model: "openrouter/auto",
  },
] as const)(
  "preserves provider-less $resolution input $input",
  ({ input, resolution, provider, model }) => {
    const normalization = { manifestPlugins: [], allowPluginNormalization: false };
    const entry = {
      sessionId: "provider-less",
      updatedAt: 1,
      modelOverride: input,
      ...(resolution === "resolved" ? { modelOverrideRouteResolution: resolution } : {}),
    };
    const stored = readStoredModelOverride({
      sessionEntry: entry,
    });
    expect(stored).not.toBeNull();
    expect(
      resolveStoredRuntimeModelSelection({
        cfg: {},
        sessionEntry: entry,
        storedOverride: stored!,
        defaultProvider: "openai",
        catalog: [],
        aliasIndex,
        normalization,
      }),
    ).toEqual({ provider, model, routeResolution: "resolved" });
    expect(entry.modelOverride).toBe(input);
  },
);

it.each(["user", undefined] as const)("preserves pre-marker pins with source=%s", (source) => {
  const normalization = {
    manifestPlugins: [
      { modelIdNormalization: { providers: { custom: { aliases: { middle: "final" } } } } },
    ],
    allowPluginNormalization: false,
  };
  const entry = {
    sessionId: "pre-marker-user",
    updatedAt: 1,
    providerOverride: "custom",
    modelOverride: "middle",
    ...(source ? { modelOverrideSource: source } : {}),
  };
  const stored = readStoredModelOverride({
    sessionEntry: entry,
  });
  expect(stored).not.toBeNull();
  expect(
    resolveStoredRuntimeModelSelection({
      cfg: {},
      sessionEntry: entry,
      storedOverride: stored!,
      defaultProvider: "openai",
      catalog,
      aliasIndex,
      normalization,
    }),
  ).toEqual({ provider: "custom", model: "middle", routeResolution: "resolved" });
});

it("decodes provider-less resolved input with its captured policy exactly once", () => {
  const normalization = {
    manifestPlugins: [
      {
        modelIdNormalization: {
          providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
        },
      },
    ],
    resolvedModelCatalog: catalog,
    allowPluginNormalization: false,
  };
  normalizeRuntime.mockReturnValue("unrelated-runtime-model");
  const entry = {
    sessionId: "encoded-resolved",
    updatedAt: 1,
    modelOverride: "custom/latest",
    modelOverrideRouteResolution: "resolved" as const,
  };
  const stored = readStoredModelOverride({
    sessionEntry: entry,
  });
  expect(stored).toMatchObject({
    model: "custom/latest",
    routeResolution: "resolved",
  });
  expect(stored?.provider).toBeUndefined();
  expect(
    resolveStoredRuntimeModelSelection({
      cfg: {},
      sessionEntry: entry,
      storedOverride: stored!,
      defaultProvider: "openai",
      catalog,
      aliasIndex,
      normalization,
    }),
  ).toEqual({ provider: "custom", model: "middle", routeResolution: "resolved" });
  expect(normalizeRuntime.mock.calls.length).toBe(0);
});

it("preserves selected configured API-provider output ahead of runtime rewriting", () => {
  const normalization = {
    manifestPlugins: [
      {
        modelIdNormalization: {
          providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
        },
      },
    ],
    allowPluginNormalization: true,
  };
  const cfg: Parameters<typeof resolveStoredRuntimeModelSelection>[0]["cfg"] = {
    models: {
      providers: {
        custom: {
          baseUrl: "https://custom.invalid/v1",
          api: "openai-completions",
          models: [
            {
              id: "latest",
              name: "Configured input",
              reasoning: false,
              input: ["text"],
              contextWindow: 1024,
              maxTokens: 100,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
  normalizeRuntime.mockReturnValue("final");
  const entry = {
    sessionId: "configured-api-selection",
    updatedAt: 1,
    providerOverride: "custom",
    modelOverride: "middle",
  };
  const stored = readStoredModelOverride({ sessionEntry: entry });
  expect(
    resolveStoredRuntimeModelSelection({
      cfg,
      sessionEntry: entry,
      storedOverride: stored!,
      defaultProvider: "openai",
      catalog,
      aliasIndex,
      normalization,
    }),
  ).toEqual({ provider: "custom", model: "middle", routeResolution: "resolved" });
  expect(normalizeRuntime.mock.calls.length).toBe(0);
  expect(entry.modelOverride).toBe("middle");
});
