import { setCurrentManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentModelConfigValue } from "./model-input.js";
import {
  resolveMergedModelProviderModels,
  createModelProviderRouteOverrideResolver,
  findProviderModelConfig,
} from "./model-provider-config.js";
import type { ModelDefinitionConfig } from "./types.models.js";

function model(id: string, fields: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return { id, ...fields } as ModelDefinitionConfig;
}

describe("resolveMergedModelProviderModels", () => {
  it("preserves exact resolved rows across alias chains without renormalizing lookups", () => {
    const aliases: Record<string, string> = { latest: "middle", middle: "final" };
    const normalizeModelId = vi.fn((id: string) =>
      id === "filtered" ? undefined : (aliases[id] ?? id),
    );
    const rows = resolveMergedModelProviderModels({
      models: [
        model("latest", { params: { inherited: true }, headers: {} }),
        model("middle", { headers: { "x-route": "middle" } }),
        model("final", { headers: {} }),
        model("filtered", { headers: { "x-route": "excluded" } }),
      ],
      normalizeModelId,
    });
    expect(normalizeModelId).toHaveBeenCalledTimes(4);
    for (const id of ["middle", "final", "middle", "latest", "filtered"]) {
      expect(rows.get(id)).toEqual(
        id === "filtered"
          ? undefined
          : {
              id,
              headers: id === "middle" ? { "x-route": "middle" } : {},
              ...(id === "middle" || id === "latest" ? { params: { inherited: true } } : {}),
            },
      );
    }
    expect(normalizeModelId).toHaveBeenCalledTimes(4);
  });

  it("keeps first-row fields and fills only omissions from exact duplicate rows", () => {
    const models = resolveMergedModelProviderModels({
      models: [
        model("gpt-5.5", {
          api: "openai-responses",
          headers: {},
        }),
        model("gpt-5.5", {
          api: "openai-completions",
          baseUrl: "https://relay.example.test/v1",
          headers: { "x-route": "custom" },
          params: { azureApiVersion: "2025-01-01" },
        }),
      ],
      normalizeModelId: (modelId) => modelId.replace(/^openai\//u, ""),
    });

    expect(models.get("gpt-5.5")).toEqual({
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      headers: {},
      params: { azureApiVersion: "2025-01-01" },
    });
  });

  it("fills headers when the first canonical row omits them", () => {
    const models = resolveMergedModelProviderModels({
      models: [
        model("gpt-5.5", { api: "openai-responses" }),
        model("openai/gpt-5.5", { headers: { "x-route": "custom" } }),
      ],
      normalizeModelId: (modelId) => modelId.replace(/^openai\//u, ""),
    });

    expect(models.get("gpt-5.5")?.headers).toEqual({ "x-route": "custom" });
  });
});

describe("findProviderModelConfig", () => {
  it("uses only same-provider legacy config spellings without changing the row id", () => {
    const legacy = model(" CUSTOM/model ", {
      api: "openai-responses",
      baseUrl: "https://host.example.test/v1",
      headers: { "x-route": "legacy" },
    });
    expect(findProviderModelConfig([legacy], "custom", "model")).toEqual(legacy);
    expect(findProviderModelConfig([legacy], "custom", "CUSTOM/model")).toEqual(legacy);
    expect(findProviderModelConfig([legacy], "other", "model")).toBeUndefined();
    expect(findProviderModelConfig([legacy], "custom", "Model")).toBeUndefined();
    expect(legacy.id).toBe(" CUSTOM/model ");
  });

  it.each(["model", "latest"])("keeps the %s row ahead of legacy config spellings", (id) => {
    setCurrentManifestModelIdNormalizationPolicies(
      new Map([["custom", { aliases: { latest: "model" } }]]),
    );
    try {
      const legacy = model("custom/model", {
        api: "openai-responses",
        baseUrl: "https://host.example.test/v1",
        headers: { "x-route": "legacy" },
        input: ["text", "image"],
      });
      const exact = model(id, { headers: {}, input: ["text"] });
      expect(findProviderModelConfig([legacy, exact], "custom", "model")).toEqual(exact);
      expect(findProviderModelConfig([legacy, exact], "custom", "custom/model")).toEqual(legacy);
    } finally {
      setCurrentManifestModelIdNormalizationPolicies(undefined);
    }
  });

  it("keeps full-ref agent settings separate from raw provider config aliases", () => {
    const settings: Record<string, { contextTokens?: number }> = {
      "custom/model": {},
      "custom/custom/model": { contextTokens: 8192 },
    };
    expect(
      resolveAgentModelConfigValue(settings, "custom", "model", (entry) => entry.contextTokens),
    ).toBeUndefined();
    expect(
      resolveAgentModelConfigValue(
        settings,
        "custom",
        "custom/model",
        (entry) => entry.contextTokens,
      ),
    ).toBe(8192);
  });
});

describe("createModelProviderRouteOverrideResolver", () => {
  it.each([false, true])("keeps legacy header overrides behind exact rows (exact=%s)", (exact) => {
    const resolve = createModelProviderRouteOverrideResolver({
      provider: "custom",
      authoredConfig: {
        models: {
          providers: {
            custom: {
              baseUrl: "",
              models: [
                model("custom/model", { headers: { "x-route": "legacy" } }),
                ...(exact ? [model("model", { headers: {} })] : []),
              ],
            },
          },
        },
      },
    });
    expect([resolve("model"), resolve("custom/model"), resolve("model")]).toEqual(
      exact ? ["none", "present", "none"] : ["present", "present", "present"],
    );
  });

  it.each([false, true])(
    "keeps cached alias-chain queries independent (reversed=%s)",
    (reverse) => {
      setCurrentManifestModelIdNormalizationPolicies(
        new Map([["custom", { aliases: { latest: "middle", middle: "final" } }]]),
      );
      try {
        const resolve = createModelProviderRouteOverrideResolver({
          provider: "custom",
          authoredConfig: {
            models: {
              providers: {
                custom: {
                  baseUrl: "https://models.example.test",
                  models: [
                    model("latest", { headers: {} }),
                    model("middle", { headers: { "x-route": "middle" } }),
                    model("final", { headers: {} }),
                  ],
                },
              },
            },
          },
        });
        const ids = reverse ? ["final", "middle", "final"] : ["middle", "final", "middle"];
        expect(ids.map((id) => resolve(id))).toEqual(
          ids.map((id) => (id === "middle" ? "present" : "none")),
        );
      } finally {
        setCurrentManifestModelIdNormalizationPolicies(undefined);
      }
    },
  );

  it("keeps another namespaced model's request overrides off the selected route", () => {
    const resolve = createModelProviderRouteOverrideResolver({
      provider: "custom",
      authoredConfig: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://models.example.test",
              models: [model("custom/model", { params: { route: "namespaced" } }), model("model")],
            },
          },
        },
      },
    });
    expect(resolve("model")).toBe("none");
    expect(resolve("custom/model")).toBe("present");
  });

  it.each([
    ["empty metadata", {}, "none"],
    ["affirmative reasoning support", { supportsReasoningEffort: true }, "none"],
    [
      "native reasoning efforts",
      { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      "none",
    ],
    [
      "combined reasoning metadata",
      { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "high"] },
      "none",
    ],
    ["disabled reasoning", { supportsReasoningEffort: false }, "present"],
    ["malformed reasoning support", { supportsReasoningEffort: "true" }, "present"],
    ["empty effort list", { supportedReasoningEfforts: [] }, "present"],
    ["non-native effort", { supportedReasoningEfforts: ["high", "custom"] }, "present"],
    ["disabled effort", { supportedReasoningEfforts: ["none"] }, "present"],
    ["malformed effort", { supportedReasoningEfforts: ["high", false] }, "present"],
    ["store behavior", { supportsStore: false }, "present"],
    [
      "mixed metadata and behavior",
      { supportsReasoningEffort: true, supportedReasoningEfforts: ["high"], supportsStore: false },
      "present",
    ],
  ])("classifies %s without discarding request behavior", (_label, compat, expected) => {
    const config = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.6-sol", compat }],
          },
        },
      },
    } as never;

    expect(
      createModelProviderRouteOverrideResolver({
        provider: "openai",
        authoredConfig: config,
      })("gpt-5.6-sol"),
    ).toBe(expected);
  });

  it("treats a provider request timeout as authored behavior", () => {
    expect(
      createModelProviderRouteOverrideResolver({
        provider: "openai",
        authoredConfig: {
          models: {
            providers: {
              openai: { baseUrl: "", timeoutSeconds: 90, models: [model("gpt-5.5")] },
            },
          },
        },
      })("gpt-5.5"),
    ).toBe("present");
  });
});
