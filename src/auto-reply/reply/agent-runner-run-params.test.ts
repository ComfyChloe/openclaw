import {
  normalizeConfiguredProviderCatalogModelId,
  setCurrentManifestModelIdNormalizationPolicies,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { describe, expect, it } from "vitest";
import { makeModel } from "../../agents/embedded-agent-runner/model.test-harness.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { resolveRunModelHasVision } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

function createRun(models: ModelDefinitionConfig[], selectedModel = "model"): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/unused/agent",
    sessionId: "identity-test",
    sessionFile: "/unused/session",
    workspaceDir: "/unused/workspace",
    config: {
      models: {
        providers: {
          custom: { api: "openai-completions", baseUrl: "https://models.example.test", models },
        },
      },
    },
    provider: "custom",
    model: selectedModel,
    thinkingCatalog: models.map((row) => ({
      provider: "custom",
      id: row.id,
      name: row.name,
      input: ["text" as const],
      api: "openai-completions" as const,
      baseUrl: "https://models.example.test",
    })),
    timeoutMs: 1_000,
    blockReplyBreak: "message_end",
  };
}

describe("queued run model input", () => {
  it("keeps an exact resolved vision row ahead of a later input alias", async () => {
    setCurrentManifestModelIdNormalizationPolicies(
      new Map([["custom", { aliases: { latest: "middle", middle: "final" } }]]),
    );
    try {
      const model = normalizeConfiguredProviderCatalogModelId("custom", "latest");
      const run = createRun([{ ...makeModel("middle"), input: ["text", "image"] }], model);
      expect(model).toBe("middle");
      await expect(resolveRunModelHasVision({ run, provider: "custom", model })).resolves.toBe(
        true,
      );
    } finally {
      setCurrentManifestModelIdNormalizationPolicies(undefined);
    }
  });

  it.each([false, true])(
    "keeps case-distinct vision settings separate (reversed=%s)",
    async (reverse) => {
      const rows: ModelDefinitionConfig[] = [
        makeModel("Model"),
        { ...makeModel("model"), input: ["text", "image"] },
      ];
      const run = createRun(reverse ? rows.toReversed() : rows);
      await expect(
        resolveRunModelHasVision({ run, provider: "custom", model: "Model" }),
      ).resolves.toBe(false);
      await expect(
        resolveRunModelHasVision({ run, provider: "custom", model: "model" }),
      ).resolves.toBe(true);
    },
  );
});
