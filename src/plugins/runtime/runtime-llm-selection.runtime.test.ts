import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "./generation-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const state = vi.hoisted(() => ({
  admittedConfig: undefined as OpenClawConfig | undefined,
  admittedModel: "middle",
  prepareAuthorizedModel: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => {
  const selection = (modelId: string) => ({ provider: "custom", modelId, agentDir: "/tmp/agent" });
  return {
    withPreparedSimpleCompletionSelection: vi.fn(),
    acquireSimpleCompletionModelForAgent: async (
      params: Parameters<
        typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
      >[0],
      validateSelection: Parameters<
        typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
      >[1],
    ) => {
      const selected = selection(state.admittedModel);
      const config = state.admittedConfig ?? params.cfg;
      validateSelection?.({ selection: selected, config });
      state.prepareAuthorizedModel();
      return {
        config,
        selection: selected,
        release: () => {},
        assertCurrent: () => params.abortSignal?.throwIfAborted(),
        model: { provider: "custom", id: state.admittedModel, api: "openai-completions" },
        auth: { apiKey: "synthetic-test-only", mode: "api_key", source: "test" },
      };
    },
    completeWithPreparedSimpleCompletionModel: state.complete,
  };
});

describe("plugin completion selection authority", () => {
  beforeEach(() => {
    state.admittedConfig = undefined;
    state.admittedModel = "middle";
    state.prepareAuthorizedModel.mockReset();
    state.complete
      .mockReset()
      .mockResolvedValue({ content: [{ type: "text", text: "OK" }], stopReason: "stop" });
  });

  it.each(["middle", "final"])(
    "checks the exact admitted identity against %s-only policy",
    async (allowedModel) => {
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom",
            modelIdNormalization: { providers: { custom: { aliases: { middle: "final" } } } },
          },
        ],
      });
      const runtime = createRuntimeLlm({
        getConfig: () => ({}),
        authority: { agentId: "main", allowedCompletionModels: [`custom/${allowedModel}`] },
      });
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const result = runtime.complete({ messages: [{ role: "user", content: "test" }] });
        if (allowedModel === "middle") {
          await expect(result).resolves.toMatchObject({ model: "middle", text: "OK" });
          expect(state.complete).toHaveBeenCalledWith(
            expect.objectContaining({ model: expect.objectContaining({ id: "middle" }) }),
          );
        } else {
          await expect(result).rejects.toThrow('model "custom/middle" is not allowlisted');
          expect(state.prepareAuthorizedModel).not.toHaveBeenCalled();
          expect(state.complete).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("authorizes the final admitted selection after a default changes during admission", async () => {
    state.admittedModel = "replacement";
    const runtime = createRuntimeLlm({
      getConfig: () => ({}),
      authority: { agentId: "main", allowedCompletionModels: ["custom/replacement"] },
    });
    await expect(
      runtime.complete({ messages: [{ role: "user", content: "test" }] }),
    ).resolves.toMatchObject({ model: "replacement", text: "OK" });
  });

  it("uses the admitted plugin policy before preparing credentials", async () => {
    const configFor = (model: string): OpenClawConfig => ({
      plugins: { entries: { owner: { llm: { allowedCompletionModels: [`custom/${model}`] } } } },
    });
    state.admittedConfig = configFor("other");
    const runtime = createRuntimeLlm({
      getConfig: () => configFor("middle"),
      authority: { agentId: "main", pluginIdForPolicy: "owner" },
    });
    await expect(
      runtime.complete({ messages: [{ role: "user", content: "test" }] }),
    ).rejects.toThrow('model "custom/middle" is not allowlisted');
    expect(state.prepareAuthorizedModel).not.toHaveBeenCalled();
  });
});
