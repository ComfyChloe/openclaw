// Covers manifest suppression identity through both public config-validation entry points.
import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

describe.each([
  ["raw", validateConfigObjectRawWithPlugins],
  ["with defaults", validateConfigObjectWithPlugins],
] as const)("%s config manifest suppression", (_name, validate) => {
  it.each([
    { model: "Alpha", ref: "fixture/Alpha", ok: false },
    { model: "Alpha", ref: "fixture/alpha", ok: false },
    { model: "alpha", ref: "fixture/Alpha", ok: false },
    { model: "Alpha", ref: "fixture/Other", ok: true },
    { model: "Alpha", ref: "fixture/alpha", conditional: true, ok: true },
    { model: "Alpha", provider: "fixture-alias", ref: "FIXTURE-ALIAS/alpha", ok: false },
    { model: "alpha", provider: "foreign", ref: "foreign/alpha", ok: true },
  ])(
    "validates $ref against authored $model suppression",
    ({ model, provider, ref, conditional, ok }) => {
      const plugin: PluginManifestRecord = {
        id: "fixture",
        channels: [],
        cliBackends: [],
        hooks: [],
        providers: ["fixture"],
        skills: [],
        configSchema: { type: "object", additionalProperties: true },
        manifestPath: "/fixture/openclaw.plugin.json",
        origin: "bundled",
        rootDir: "/fixture",
        source: "/fixture/index.js",
        modelCatalog: {
          aliases: { "fixture-alias": { provider: "fixture" } },
          suppressions: [
            {
              provider: provider ?? "fixture",
              model,
              reason: "This model is unavailable.",
              ...(conditional ? { when: { baseUrlHosts: ["route.example.test"] } } : {}),
            },
          ],
        },
      };
      const result = validate(
        { agents: { defaults: { model: { primary: ref } } } },
        { pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [plugin] } } },
      );
      expect(result.ok).toBe(ok);
      if (!ok && !result.ok) {
        expect(result.issues).toEqual([
          {
            path: "agents.defaults.model.primary",
            message: `Unknown model: ${provider ?? "fixture"}/${model}. This model is unavailable.`,
          },
        ]);
      }
    },
  );
});
