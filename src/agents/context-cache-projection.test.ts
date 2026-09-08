import { setCurrentManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyConfiguredContextWindows,
  prepareContextWindowCaches,
} from "./context-cache-projection.js";
import {
  lookupCachedContextTokens,
  lookupCachedContextWindow,
  replaceContextWindowCaches,
  providerContextTokenCacheKey,
} from "./context-cache.js";
import { resetContextWindowCacheForTest } from "./context-runtime-state.js";

function publishConfiguredModel(model: string, contextWindow: number): void {
  replaceContextWindowCaches({
    configuredTokenCache: new Map([[model, contextWindow]]),
    discoveredTokenCache: new Map(),
    contextWindowCache: new Map(),
  });
}

function createLargeCatalog(prefix: string, count: number) {
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      provider: "synthetic",
      contextWindow: 64_000,
    })),
    staticEntries: [],
  };
}

describe("context cache projection", () => {
  afterEach(() => {
    resetContextWindowCacheForTest();
    setCurrentManifestModelIdNormalizationPolicies(undefined);
  });

  it.each(["contextTokens", "contextWindow"] as const)(
    "uses exact configured %s in both synchronous and prepared caches",
    async (field) => {
      setCurrentManifestModelIdNormalizationPolicies(
        new Map([
          [
            "custom",
            {
              aliases: { latest: "middle", middle: "final" },
            },
          ],
        ]),
      );
      const config = {
        models: {
          providers: {
            custom: {
              models: [
                { id: "latest", [field]: 90000 },
                { id: "middle", [field]: 40000 },
                { id: "final", [field]: 80000 },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const cache = new Map<string, number>();
      const windowCache = new Map<string, number>();
      applyConfiguredContextWindows({ cache, windowCache, modelsConfig: config.models });
      const prepared = await prepareContextWindowCaches({ config, modelCatalog: { entries: [] } });
      const projections =
        field === "contextTokens"
          ? [cache, prepared.configuredTokenCache]
          : [windowCache, prepared.contextWindowCache];
      for (const projection of projections) {
        expect(projection.get(providerContextTokenCacheKey("custom", "middle"))).toBe(40000);
        expect(projection.get(providerContextTokenCacheKey("custom", "final"))).toBe(80000);
      }
    },
  );

  it("keeps the prior generation visible until a cooperative projection is complete", async () => {
    publishConfiguredModel("prior-model", 48_000);

    const pending = prepareContextWindowCaches({
      config: {
        models: {
          providers: {
            synthetic: {
              baseUrl: "https://example.invalid",
              models: [{ id: "next-model", contextWindow: 96_000 } as never],
            },
          },
        },
      },
      modelCatalog: createLargeCatalog("discovered", 600),
    });

    expect(lookupCachedContextTokens("prior-model")).toBe(48_000);
    expect(lookupCachedContextTokens("next-model")).toBeUndefined();

    replaceContextWindowCaches(await pending);
    expect(lookupCachedContextTokens("prior-model")).toBeUndefined();
    expect(lookupCachedContextWindow("next-model")).toBe(96_000);
    expect(lookupCachedContextTokens("discovered-599")).toBe(64_000);
  });

  it("does not publish a superseded cooperative projection", async () => {
    publishConfiguredModel("prior-model", 48_000);
    let current = true;
    const pending = prepareContextWindowCaches({
      config: {},
      modelCatalog: createLargeCatalog("superseded", 1_024),
      assertCurrent: () => {
        if (!current) {
          throw new Error("projection superseded");
        }
      },
    });
    current = false;

    await expect(pending).rejects.toThrow("projection superseded");
    expect(lookupCachedContextTokens("prior-model")).toBe(48_000);
    expect(lookupCachedContextTokens("superseded-1023")).toBeUndefined();
  });
});
