// Covers model catalog metadata declared by plugin manifests.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makePluginDir() {
  return makeTrackedTempDir("openclaw-manifest-model-catalog", tempDirs);
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf8");
}

describe("plugin manifest model catalog", () => {
  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it.each([true, false])("loads models.dev opt-in only with provider ownership: %s", (owned) => {
    const dir = makePluginDir();
    writeManifest(dir, {
      id: "example-plugin",
      providers: owned ? [" Example "] : [],
      modelCatalog: { modelsDev: { " EXAMPLE ": " upstream-id ", other: "other-source" } },
      configSchema: { type: "object" },
    });

    const result = loadPluginManifest(dir);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.manifest.modelCatalog).toEqual(
      owned ? { modelsDev: { example: "upstream-id" } } : undefined,
    );
  });

  it("keeps catalog aliases and model-id policies within their declared owners", () => {
    const dir = makePluginDir();
    writeManifest(dir, {
      id: "anthropic",
      providers: ["Anthropic"],
      cliBackends: ["claude-cli"],
      modelCatalog: {
        aliases: {
          "anthropic-compat": { provider: " ANTHROPIC " },
          "cli-compat": { provider: "claude-cli" },
          foreign: { provider: "unowned" },
          chained: { provider: "anthropic-compat" },
        },
        providers: {
          "claude-cli": {
            models: [{ id: "claude-sonnet-4-6" }],
          },
        },
        discovery: {
          "claude-cli": "static",
        },
      },
      modelIdNormalization: {
        providers: {
          anthropic: { stripPrefixes: ["anthropic/"] },
          "anthropic-compat": { stripPrefixes: ["anthropic-compat/"] },
          "claude-cli": { stripPrefixes: ["claude-cli/"] },
          "cli-compat": { stripPrefixes: ["cli-compat/"] },
          foreign: { stripPrefixes: ["foreign/"] },
          chained: { stripPrefixes: ["chained/"] },
          unowned: { stripPrefixes: ["unowned/"] },
        },
      },
      configSchema: { type: "object" },
    });

    const result = loadPluginManifest(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.manifest.providers).toEqual(["Anthropic"]);
    expect(result.manifest.modelIdNormalization).toEqual({
      providers: {
        anthropic: { stripPrefixes: ["anthropic/"] },
        "anthropic-compat": { stripPrefixes: ["anthropic-compat/"] },
      },
    });
    expect(result.manifest.modelCatalog).toEqual({
      aliases: {
        "anthropic-compat": { provider: "anthropic" },
        "cli-compat": { provider: "claude-cli" },
      },
      providers: {
        "claude-cli": {
          models: [{ id: "claude-sonnet-4-6" }],
        },
      },
      discovery: {
        "claude-cli": "static",
      },
    });
  });
});
