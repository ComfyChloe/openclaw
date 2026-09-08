import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import {
  resolveInitialEmbeddedRunModel,
  resolveInitialThinkLevel,
  resolveRequestStreamTransportOverrides,
} from "./runtime-resolution.js";

describe("resolveInitialEmbeddedRunModel", () => {
  const manifestPlugins = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "custom",
        modelIdNormalization: {
          providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
        },
      },
    ],
  });
  const config = { agents: { defaults: { model: { primary: "custom/latest" } } } };

  it.each([
    { provider: undefined, model: undefined },
    { provider: undefined, model: "custom/latest" },
    { provider: "custom", model: "latest" },
    { provider: "custom", model: "latest", requestedRouteResolution: "raw" },
    { provider: "custom", model: "middle", requestedRouteResolution: "resolved" },
    { provider: " CUSTOM ", model: "middle", requestedRouteResolution: "resolved" },
  ] as const)("resolves authored input once and preserves selected pairs: %j", (selection) => {
    expect(
      resolveInitialEmbeddedRunModel({
        config,
        ...selection,
        normalization: {
          manifestPlugins,
          resolvedModelCatalog: [{ provider: "custom", id: "final" }],
          allowPluginNormalization: false,
        },
      }),
    ).toEqual({ provider: "custom", modelId: "middle" });
  });

  it.each([
    { requestedRouteResolution: "raw", expected: "grok-4.3" },
    { requestedRouteResolution: "resolved", expected: "grok-4.3-latest" },
  ] as const)(
    "honors $requestedRouteResolution explicit model input",
    ({ expected, ...selection }) => {
      expect(
        resolveInitialEmbeddedRunModel({
          config: {},
          provider: "xai",
          model: "grok-4.3-latest",
          ...selection,
        }),
      ).toEqual({ provider: "xai", modelId: expected });
    },
  );
});

describe("resolveRequestStreamTransportOverrides", () => {
  it("marks non-empty request stream parameters for OpenClaw routing", () => {
    expect(resolveRequestStreamTransportOverrides({ maxTokens: 64 })).toBe("present");
  });

  it("keeps an empty request stream parameter record on the implicit runtime route", () => {
    expect(resolveRequestStreamTransportOverrides({})).toBeUndefined();
  });
});

describe("resolveInitialThinkLevel", () => {
  it("preserves logical Ultra until the provider runtime boundary", () => {
    expect(
      resolveInitialThinkLevel({
        requested: "ultra",
        config: {},
        provider: "openai",
        modelId: "gpt-5.5",
        model: { reasoning: true },
      }),
    ).toBe("ultra");
  });
});
