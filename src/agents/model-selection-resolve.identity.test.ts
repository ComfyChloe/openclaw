import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadPluginManifest } from "../plugins/manifest.js";
import { normalizeModelRef } from "./model-ref-shared.js";
import { resolveAllowedModelRefCore } from "./model-selection-resolve.js";

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => {
    throw new Error("prepared catalog selection must not load provider runtime");
  },
}));

const manifestPlugins = [
  {
    modelIdNormalization: {
      providers: {
        custom: {
          aliases: { latest: "middle", middle: "final" },
        },
      },
    },
  },
];
const catalog = [
  { provider: "custom", id: "middle", name: "Middle" },
  { provider: "custom", id: "final", name: "Final" },
];

describe("allowed model prepared identities", () => {
  it.each(["latest", "middle", "custom/middle"])(
    "admits %s as the exact middle identity",
    (raw) => {
      expect(
        resolveAllowedModelRefCore({
          cfg: {},
          catalog,
          manifestPlugins,
          raw,
          defaultProvider: "custom",
        }),
      ).toEqual({ ref: { provider: "custom", model: "middle" }, key: "custom/middle" });
    },
  );

  it("still rejects the selected identity when policy excludes it", () => {
    expect(
      resolveAllowedModelRefCore({
        cfg: { agents: { defaults: { modelPolicy: { allow: ["custom/final"] } } } },
        catalog,
        manifestPlugins,
        raw: "middle",
        defaultProvider: "custom",
      }),
    ).toHaveProperty("error");
  });

  it.each(["zai", "z.ai", "z-ai"])(
    "keeps %s source-prefix compatibility and exact catalog identity",
    (provider) => {
      const loaded = loadPluginManifest(path.resolve("extensions/zai"));
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      const zaiManifest = loaded.manifest;
      const model = "GLM-4.7";
      const qualifiedModel = `${provider}/${model}`;
      const options = { manifestPlugins: [zaiManifest], allowPluginNormalization: false };
      expect(normalizeModelRef(provider, qualifiedModel, options)).toEqual({ provider, model });
      expect(normalizeModelRef(provider, `${provider}/${qualifiedModel}`, options)).toEqual({
        provider,
        model: qualifiedModel,
      });
      for (const other of ["zai", "z.ai", "z-ai"].filter((source) => source !== provider)) {
        expect(normalizeModelRef(provider, `${other}/${model}`, options)).toEqual({
          provider,
          model: `${other}/${model}`,
        });
      }
      expect(
        resolveAllowedModelRefCore({
          cfg: {},
          catalog: [
            { provider, id: model, name: "Bare GLM" },
            { provider, id: qualifiedModel, name: "Literal namespaced GLM" },
          ],
          manifestPlugins: [zaiManifest],
          raw: `${provider}/${qualifiedModel}`,
          defaultProvider: provider,
        }),
      ).toEqual({ ref: { provider, model: qualifiedModel }, key: `${provider}/${qualifiedModel}` });
    },
  );
});
