import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";

const states: OpenClawTestState[] = [];
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("legacy runtime session model migration", () => {
  it("updates the retired Codex runtime IDs without moving its account or binding", async () => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "runtime-pair-" });
    states.push(state);
    state.applyEnv();
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    };
    const scope = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:legacy-runtime",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "legacy-runtime",
      updatedAt: 1,
      modelProvider: "openai",
      model: "current-model",
      agentHarnessId: "codex-cli",
      agentRuntimeOverride: "codex-cli",
      authProfileOverride: "authored:account",
      claudeCliSessionId: "retained-binding",
    });

    await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true });

    expect(loadSessionEntry(scope)).toMatchObject({
      modelProvider: "openai",
      model: "current-model",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      authProfileOverride: "authored:account",
      claudeCliSessionId: "retained-binding",
    });
  });

  it("preserves a custom namespaced model under an explicit canonical provider", async () => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "runtime-pair-" });
    states.push(state);
    state.applyEnv();
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
    };
    const scope = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:custom-pair",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "custom-pair",
      updatedAt: 1,
      modelProvider: "openai",
      model: "codex/team/custom-model",
      providerOverride: "openai",
      modelOverride: "codex/team/custom-model",
      modelOverrideSource: "user",
      authProfileOverride: "authored:account",
      authProfileOverrideSource: "user",
      agentRuntimeOverride: "openclaw",
    });
    const before = loadSessionEntry(scope);

    expect(
      (await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true }))
        .repairedSessions,
    ).toBe(0);
    expect(loadSessionEntry(scope)).toEqual(before);
  });

  it.each([
    {
      provider: "claude-cli",
      model: "assistant-a",
      canonicalProvider: "anthropic",
      canonicalModel: "assistant-a",
      explicitRuntime: undefined,
      expectedRuntime: "claude-cli",
    },
    {
      provider: "google",
      model: "google-gemini-cli/assistant-b",
      canonicalProvider: "google",
      canonicalModel: "assistant-b",
      explicitRuntime: "openclaw",
      expectedRuntime: "openclaw",
    },
  ])(
    "repairs the $provider pair while preserving explicit runtime and account pins",
    async (row) => {
      const state = await createOpenClawTestState({
        layout: "state-only",
        prefix: "runtime-pair-",
      });
      states.push(state);
      state.applyEnv();
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
      };
      const scope = {
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionKey: "agent:main:legacy-pair",
        env: state.env,
      };
      await replaceSessionEntry(scope, {
        sessionId: "legacy-pair",
        updatedAt: 1,
        modelProvider: row.provider,
        model: row.model,
        providerOverride: row.provider,
        modelOverride: row.model,
        modelOverrideSource: "user",
        authProfileOverride: "authored:account",
        authProfileOverrideSource: "user",
        agentRuntimeOverride: row.explicitRuntime,
        claudeCliSessionId: "retained-binding",
      });
      const before = loadSessionEntry(scope);
      await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: false });
      expect(loadSessionEntry(scope)).toEqual(before);

      const result = await maybeRepairCodexSessionRoutes({
        cfg,
        env: state.env,
        shouldRepair: true,
      });

      expect(result.repairedSessions).toBe(1);
      expect(loadSessionEntry(scope)).toMatchObject({
        modelProvider: row.canonicalProvider,
        model: row.canonicalModel,
        providerOverride: row.canonicalProvider,
        modelOverride: row.canonicalModel,
        modelOverrideSource: "user",
        authProfileOverride: "authored:account",
        authProfileOverrideSource: "user",
        agentRuntimeOverride: row.expectedRuntime,
        claudeCliSessionId: "retained-binding",
      });
      expect(
        (await maybeRepairCodexSessionRoutes({ cfg, env: state.env, shouldRepair: true }))
          .repairedSessions,
      ).toBe(0);
    },
  );
});
