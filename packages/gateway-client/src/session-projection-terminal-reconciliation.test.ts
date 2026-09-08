import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  projectLiveSessionMessage,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "./session-projection.js";

const scope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

function createAssistantMessage(text: string, metadata?: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(metadata ? { __openclaw: metadata } : {}),
  };
}

describe("terminal snapshot reconciliation", () => {
  it("promotes the actual terminal when history contains an earlier same-run tool boundary", () => {
    const runId = "tool-heavy-run";
    const toolBoundary = {
      role: "assistant",
      content: [
        { type: "text", text: "Checking the repository." },
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "AGENTS.md" } },
      ],
      __openclaw: { id: "assistant-tool-boundary", seq: 2, runId },
    };
    const synthetic = createAssistantMessage("The repair is complete.");
    const persisted = {
      role: "assistant",
      content: [{ text: "The repair is complete.", type: "text" }],
      __openclaw: { id: "assistant-final", seq: 4, runId },
    };
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, structuredClone(synthetic), { runId });

    expect(
      reconcileSessionProjectionSnapshot(state, [toolBoundary, persisted], scope).messages,
    ).toEqual([toolBoundary, persisted]);
  });

  it("retains an unsequenced terminal when multiple same-run rows have terminal content", () => {
    const runId = "ambiguous-run";
    const synthetic = createAssistantMessage("The repair is complete.");
    const first = createAssistantMessage("The repair is complete.", {
      id: "assistant-first",
      seq: 2,
      runId,
    });
    const second = createAssistantMessage("The repair is complete.", {
      id: "assistant-second",
      seq: 3,
      runId,
    });
    let state = reduceSessionProjection(createSessionProjection(scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: synthetic,
    });
    state = projectLiveSessionMessage(state, synthetic, { runId });

    expect(reconcileSessionProjectionSnapshot(state, [first, second], scope).messages).toEqual([
      first,
      second,
      synthetic,
    ]);
  });
});
