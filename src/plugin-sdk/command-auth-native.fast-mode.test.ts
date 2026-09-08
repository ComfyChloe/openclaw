import { describe, expect, expectTypeOf, it } from "vitest";
import { resolveFastModeState } from "./command-auth-native.js";
import type { OpenClawConfig } from "./config-contracts.js";

describe("command-auth-native fast-mode input contracts", () => {
  it("requires exactly one input form in the public parameter type", () => {
    type Params = Parameters<typeof resolveFastModeState>[0];
    type Common = { cfg: undefined; provider: string };
    expectTypeOf<Common & { model: string }>().toMatchTypeOf<Params>();
    expectTypeOf<Common & { modelId: string }>().toMatchTypeOf<Params>();
    expectTypeOf<Common & { model: string; modelId: string }>().not.toMatchTypeOf<Params>();
    expectTypeOf<Common>().not.toMatchTypeOf<Params>();
  });

  it.each([
    {
      provider: "openai",
      model: "openai/gpt-5.5",
      key: "openai/gpt-5.5",
      resolved: [false, 45],
    },
    {
      provider: "custom",
      model: "CUSTOM/Model",
      key: "CUSTOM/Model",
      resolved: [false, 45],
    },
    {
      provider: "custom",
      model: "custom/custom/model",
      key: "custom/custom/model",
      resolved: [false, 45],
    },
    {
      provider: "custom",
      model: "Model",
      key: "custom/Model",
      resolved: ["auto", 30],
    },
    {
      provider: "openrouter",
      model: "anthropic/model",
      key: "openrouter/anthropic/model",
      resolved: ["auto", 30],
    },
  ] as const)("preserves each input contract for $provider and $model", (row) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "custom/model": { params: { fastMode: false, fastAutoOnSeconds: 90 } },
            "custom/Model": { params: { fastMode: false, fastAutoOnSeconds: 20 } },
            [`${row.provider}/${row.model}`]: {
              params: { fastMode: false, fastAutoOnSeconds: 45 },
            },
            [row.key]: { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
          },
        },
      },
    };
    const params = { cfg, provider: row.provider };
    expect(resolveFastModeState({ ...params, model: row.model })).toEqual({
      mode: "auto",
      enabled: true,
      source: "config",
      fastAutoOnSeconds: 30,
    });
    expect(resolveFastModeState({ ...params, modelId: row.model })).toMatchObject({
      mode: row.resolved[0],
      source: "config",
      fastAutoOnSeconds: row.resolved[1],
    });
  });

  it("does not borrow a foreign provider's settings", () => {
    expect(
      resolveFastModeState({
        cfg: {
          agents: {
            defaults: {
              models: { "other/model": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } } },
            },
          },
        },
        provider: "custom",
        model: "other/model",
      }),
    ).toEqual({ mode: false, enabled: false, source: "default", fastAutoOnSeconds: 60 });
  });

  it.each([
    { override: undefined, mode: false, source: "config" },
    { override: "auto", mode: "auto", source: "session" },
  ] as const)("keeps the model cutoff with a $source mode", ({ override, mode, source }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: { "custom/model": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } } },
        },
        list: [{ id: "main", models: { "custom/model": { params: { fastMode: false } } } }],
      },
    };
    const params = {
      cfg,
      provider: "custom",
      agentId: "main",
      sessionEntry: { fastMode: override },
    };
    expect(resolveFastModeState({ ...params, model: "custom/model" })).toMatchObject({
      mode,
      source,
      fastAutoOnSeconds: 30,
    });
    expect(resolveFastModeState({ ...params, modelId: "model" })).toMatchObject({
      mode,
      source,
      fastAutoOnSeconds: 30,
    });
  });
});
