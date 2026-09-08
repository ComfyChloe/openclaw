import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeModel } from "../embedded-agent-runner/model.test-harness.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import {
  authStore,
  evaluate,
  platformRoute,
  subscriptionRoute,
} from "../model-auth-availability.test-support.js";

describe("model auth identity", () => {
  it.each([
    ["gpt-5.4", "gpt-5.5"],
    ["openai/gpt-5.4", "gpt-5.5"],
    ["other/gpt-5.4", "gpt-5.5"],
    ["Model", "model"],
    ["model", "Model"],
  ])(
    "keeps successful harness auth scoped to the exact model route %s",
    (modelId, otherModelId) => {
      const materialization = {
        provider: "openai",
        modelId,
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        authMode: "oauth",
        runtimeOwnerId: "codex",
      } as const;
      const store = authStore({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      });

      expect(
        evaluate({
          store,
          ref: { modelId },
          preparedRuntimeAuthMaterializations: [materialization],
        }),
      ).toMatchObject({
        availability: true,
        evidence: "runtime",
        selectedRoute: subscriptionRoute,
      });
      expect(
        evaluate({
          store,
          ref: { modelId: otherModelId },
          preparedRuntimeAuthMaterializations: [materialization],
        }).availability,
      ).not.toBe(true);
      expect(
        evaluate({
          cfg: {
            models: {
              providers: {
                openai: {
                  auth: "api-key",
                  apiKey: "configured-platform-key",
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
          },
          store,
          ref: { modelId },
          preparedRuntimeAuthMaterializations: [materialization],
        }),
      ).toMatchObject({
        availability: true,
        evidence: "provider-config",
        selectedRoute: platformRoute,
      });
    },
  );

  it("does not borrow native AWS authentication from another namespaced model", () => {
    const resolver = createModelAuthAvailabilityResolver({
      cfg: {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock.example.test",
              models: [
                { ...makeModel("amazon-bedrock/model"), api: "bedrock-converse-stream" },
                { ...makeModel("model"), api: "openai-completions" },
              ],
            },
          },
        },
      } satisfies OpenClawConfig,
      authStore: authStore(),
      env: {},
    });
    expect(
      resolver.evaluateModelAuth("amazon-bedrock", { modelId: "model" }).availability,
    ).not.toBe(true);
    expect(
      resolver.evaluateModelAuth("amazon-bedrock", { modelId: "amazon-bedrock/model" })
        .availability,
    ).toBe(true);
  });
});
