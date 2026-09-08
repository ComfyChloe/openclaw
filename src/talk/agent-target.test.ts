import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareTalkSessionTarget } from "../gateway/talk-session-target.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveTalkSessionAgentId } from "./agent-target.js";

const explicitRoster = {
  agents: { list: [{ id: "main" }, { id: "molty" }] },
};

describe("resolveTalkSessionAgentId", () => {
  it("uses an agent-scoped session owner without requiring an ambient Talk default", () => {
    expect(resolveTalkSessionAgentId(explicitRoster, "agent:molty:talk:voice-1")).toBe("molty");
  });

  it("keeps ownerless Talk sessions as an explicit configuration error", () => {
    expect(() => resolveTalkSessionAgentId(explicitRoster, "global")).toThrow(
      AgentSelectionRequiredError,
    );
  });
});

const config: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { primary: {}, voice: {} } },
  talk: { agentId: "voice" },
};

describe("Talk target agent normalization", () => {
  it.each([
    { requestedAgentId: undefined, agentId: "voice" },
    { requestedAgentId: "", agentId: "voice" },
    { requestedAgentId: " 	 ", agentId: "voice" },
    { requestedAgentId: "primary", agentId: "primary" },
    { requestedAgentId: " primary ", agentId: "primary" },
  ])(
    "retains the selected owner for '$requestedAgentId'",
    async ({ requestedAgentId, agentId }) => {
      await withOpenClawTestState({ scenario: "empty" }, async () => {
        const target = prepareTalkSessionTarget(config, " selected ", requestedAgentId);
        expect(target).toMatchObject({
          agentId,
          sessionKey: "selected",
          canonicalKey: "agent:" + agentId + ":selected",
        });
        expect(Object.isFrozen(target)).toBe(true);
      });
    },
  );

  it.each([undefined, " 	 "])("retains omitted-session fallback for '%s'", async (agentId) => {
    await withOpenClawTestState({ scenario: "empty" }, async () => {
      expect(prepareTalkSessionTarget(config, undefined, agentId)).toMatchObject({
        agentId: "voice",
        sessionKey: "agent:voice:main",
        canonicalKey: "agent:voice:main",
      });
    });
  });

  it.each([
    { sessionKey: "selected", agentId: "missing", error: /Unknown agent id/ },
    { sessionKey: "selected", agentId: "PRIMARY", error: /Unknown agent id/ },
    {
      sessionKey: "agent:voice:selected",
      agentId: "primary",
      error: /belongs to "voice", not "primary"/,
    },
  ])(
    "rejects owner mismatch or invalid agent ($sessionKey/$agentId)",
    async ({ sessionKey, agentId, error }) => {
      await withOpenClawTestState({ scenario: "empty" }, async () => {
        expect(() => prepareTalkSessionTarget(config, sessionKey, agentId)).toThrow(error);
      });
    },
  );
});
