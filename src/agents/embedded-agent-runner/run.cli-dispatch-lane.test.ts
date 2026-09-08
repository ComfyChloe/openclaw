// Proves opted-in CLI-backend dispatch executes inside embedded lane
// admission: the dispatch decision and the CLI run must happen within the
// enqueued global-lane task, not before it, so dispatched runs obey the same
// lifecycle, placement, and concurrency gates as native embedded runs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { CommandQueueEnqueueFn } from "../../process/command-queue.types.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const runEmbeddedAgentViaCliBackendIfEligible = vi.hoisted(() => vi.fn());
vi.mock("./cli-backend-dispatch.js", () => ({
  runEmbeddedAgentViaCliBackendIfEligible,
}));

import { runEmbeddedAgent } from "./run.js";

const tempRoot = mkdtempSync(join(tmpdir(), "cli-dispatch-lane-"));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const dispatchResult: EmbeddedAgentRunResult = {
  payloads: [{ text: "dispatched" }],
  meta: {
    durationMs: 1,
    agentMeta: { usage: {} },
  },
} as unknown as EmbeddedAgentRunResult;

function laneRunParams() {
  return {
    admittedRunContext: createTestAdmittedRunContext("run-cli-dispatch-lane-test"),
    sessionId: "recall-lane-session",
    sessionKey: "agent:main:recall-lane-test",
    agentId: "main",
    sessionTarget: {
      agentId: "main",
      sessionId: "recall-lane-session",
      sessionKey: "agent:main:recall-lane-test",
      storePath: join(tempRoot, "sessions.json"),
    },
    sessionFile: join(tempRoot, "session.jsonl"),
    workspaceDir: join(tempRoot, "workspace"),
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 5_000,
    runId: "run-cli-dispatch-lane-test",
    config: {},
    cliBackendDispatch: "subscription-auth" as const,
  };
}

describe("runEmbeddedAgent CLI dispatch lane admission", () => {
  beforeEach(() => {
    runEmbeddedAgentViaCliBackendIfEligible.mockReset();
  });

  it("resolves and executes CLI dispatch inside the global-lane task", async () => {
    const order: string[] = [];
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
      order.push("dispatch-run");
      return dispatchResult;
    });
    // The custom enqueue hook stands in for both the session and the global
    // lane, so a compliant run enters it twice before dispatching.
    const enqueue: CommandQueueEnqueueFn = async (task) => {
      order.push("global-lane-enter");
      const result = await task();
      order.push("global-lane-exit");
      return result;
    };

    const params = laneRunParams();
    const sessionEntry: InternalSessionEntry = {
      sessionId: params.sessionId,
      updatedAt: 1,
      lifecycleRevision: "cli-dispatch-lifecycle",
    };
    await upsertSessionEntryCore(params.sessionTarget, sessionEntry);
    const result = await runEmbeddedAgent({ ...params, enqueue });

    expect(result.payloads?.[0]?.text).toBe("dispatched");
    // Both lane admissions (session, then global) must fully wrap the
    // dispatch decision and execution.
    expect(order).toEqual([
      "global-lane-enter",
      "global-lane-enter",
      "dispatch-run",
      "global-lane-exit",
      "global-lane-exit",
    ]);
    expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentViaCliBackendIfEligible.mock.calls[0]?.[0].sessionTarget).toMatchObject({
      ...params.sessionTarget,
      expectedWriterRunId: params.runId,
      expectedLifecycleRevision: sessionEntry.lifecycleRevision,
    });
  });

  it.each([
    { name: "missing model", provider: "claude-cli", model: undefined },
    { name: "missing provider", provider: undefined, model: "opus" },
    { name: "missing pair", provider: undefined, model: undefined },
    { name: "blank model", provider: "claude-cli", model: "  " },
    { name: "blank provider", provider: "  ", model: "opus" },
    {
      name: "missing model before opted-in CLI dispatch",
      provider: "claude-cli",
      model: undefined,
      cliBackendDispatch: "subscription-auth",
    },
  ] as const)(
    "rejects resolved input with $name before execution",
    async ({ name: _name, ...selection }) => {
      runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue(dispatchResult);
      let laneEntries = 0;
      const enqueue: CommandQueueEnqueueFn = async (task) => {
        laneEntries += 1;
        return await task();
      };
      const params = {
        ...laneRunParams(),
        cliBackendDispatch: undefined,
        ...selection,
      };
      await upsertSessionEntryCore(params.sessionTarget, {
        sessionId: params.sessionId,
        updatedAt: 1,
        lifecycleRevision: "cli-dispatch-invalid-input",
      });

      await expect(
        runEmbeddedAgent({ ...params, requestedRouteResolution: "resolved", enqueue }),
      ).rejects.toThrow("Resolved model requests require both provider and model.");
      expect(laneEntries).toBe(0);
      expect(runEmbeddedAgentViaCliBackendIfEligible).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "a complete resolved pair",
      provider: "claude-cli",
      model: "claude-cli/opus",
      requestedRouteResolution: "resolved",
    },
    {
      name: "raw model-only input",
      provider: undefined,
      model: "fast",
      requestedRouteResolution: "raw",
    },
    {
      name: "raw provider-only input",
      provider: "claude-cli",
      model: undefined,
      requestedRouteResolution: "raw",
    },
    {
      name: "provider-only input with the marker omitted",
      provider: "claude-cli",
      model: undefined,
    },
    { name: "omitted model defaults", provider: undefined, model: undefined },
  ] as const)(
    "admits $name through the public embedded entry",
    async ({ name: _name, ...selection }) => {
      runEmbeddedAgentViaCliBackendIfEligible.mockResolvedValue(dispatchResult);
      const enqueue: CommandQueueEnqueueFn = async (task) => await task();
      const params = { ...laneRunParams(), ...selection };
      await upsertSessionEntryCore(params.sessionTarget, {
        sessionId: params.sessionId,
        updatedAt: 1,
        lifecycleRevision: "cli-dispatch-valid-input",
      });

      await expect(runEmbeddedAgent({ ...params, enqueue })).resolves.toEqual(dispatchResult);
      expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledOnce();
    },
  );
});
