import { describe, expect, it, vi } from "vitest";
import { normalizeAgentCommandModelRef } from "./model-ref.js";

vi.mock("../provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
const context = {
  manifestPlugins: [
    {
      modelIdNormalization: {
        providers: {
          custom: {
            aliases: { middle: "final" },
          },
        },
      },
    },
  ],
  resolvedModelCatalog: [],
};

describe("explicit command model input provenance", () => {
  it.each([undefined, "raw"] as const)(
    "normalizes legacy input with resolution=%s",
    (resolution) => {
      expect(normalizeAgentCommandModelRef({}, "custom", "middle", context, resolution)).toEqual({
        provider: "custom",
        model: "final",
      });
    },
  );

  it.each(["middle", "namespace/Middle"])(
    "preserves the selected provider-local ID %s",
    (model) => {
      expect(normalizeAgentCommandModelRef({}, " CUSTOM ", model, context, "resolved")).toEqual({
        provider: "custom",
        model,
      });
    },
  );
});
