import { describe, expect, it } from "vitest";
import { observeCodeModeTurnCompletion } from "./code-mode-turn-completion.js";

function fixture(turn = "A", deliveryStatus: "sent" | "partial_failed" = "sent") {
  const marker = `QA-${turn}-OUTBOUND`;
  const plannedToolCallId = `call-${turn}`;
  const plannedCode = `return await send_current_reply({ text: "${marker}" });`;
  const result = {
    status: "completed",
    value: {
      sent:
        deliveryStatus === "sent"
          ? { status: "sent", messageId: `message-${turn}` }
          : { status: "partial_failed", sentBeforeError: true, error: "response lost" },
      observed: true,
    },
    output: [],
  };
  const assistant = {
    role: "assistant",
    content: [
      { type: "toolCall", id: plannedToolCallId, name: "exec", arguments: { code: plannedCode } },
    ],
  };
  const toolResult = {
    role: "toolResult",
    toolName: "exec",
    toolCallId: plannedToolCallId,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
  const history: {
    sessionKey: string;
    sessionId: string;
    sessionInfo: { hasActiveRun?: boolean };
    messages: unknown[];
  } = {
    sessionKey: "agent:main:qa:proof",
    sessionId: "proof-session",
    sessionInfo: { hasActiveRun: false },
    messages: [assistant, toolResult],
  };
  const params: Parameters<typeof observeCodeModeTurnCompletion>[0] = {
    history,
    sessionKey: history.sessionKey,
    plannedToolCallId,
    plannedCode,
    marker,
    deliveryStatus,
  };
  return {
    params,
    history,
    assistant,
    toolResult,
    result,
  };
}

describe("Code Mode current-turn completion observer", () => {
  it.each(["sent", "partial_failed"] as const)(
    "reads pretty-printed public exec text with truthful %s delivery",
    (deliveryStatus) => {
      const { params, history } = fixture("A", deliveryStatus);
      expect(observeCodeModeTurnCompletion(params)).toMatchObject({
        status: "complete",
        sessionId: history.sessionId,
        toolCallId: params.plannedToolCallId,
        execResult: { status: "completed", value: { sent: { status: deliveryStatus } } },
      });
    },
  );

  it("requires the second turn's planned call on the same inactive session", () => {
    const first = fixture("A");
    const second = fixture("B");
    const completedFirst = observeCodeModeTurnCompletion(first.params);
    expect(completedFirst.status).toBe("complete");
    second.history.messages = first.history.messages;
    expect(observeCodeModeTurnCompletion(second.params).status).toBe("pending");
    second.history.messages = [...first.history.messages, second.assistant, second.toolResult];
    expect(
      observeCodeModeTurnCompletion({ ...second.params, sessionId: first.history.sessionId }),
    ).toMatchObject({ status: "complete", toolCallId: "call-B" });
    second.history.sessionId = "replacement-session";
    expect(
      observeCodeModeTurnCompletion({ ...second.params, sessionId: first.history.sessionId }),
    ).toEqual({ status: "pending", reason: "session identity mismatch" });
  });

  it.each([
    ["missing history", (f) => (f.params.history = undefined)],
    ["wrong session key", (f) => (f.history.sessionKey = "another-session")],
    ["missing session id", (f) => (f.history.sessionId = "")],
    ["active run", (f) => (f.history.sessionInfo.hasActiveRun = true)],
    ["unknown activity", (f) => (f.history.sessionInfo = {})],
    ["missing provider call id", (f) => (f.params.plannedToolCallId = "")],
    ["wrong provider call id", (f) => (f.params.plannedToolCallId = "another-call")],
    ["historical marker", (f) => (f.params.marker = "QA-B-OUTBOUND")],
    ["wrong assistant call id", (f) => (f.assistant.content[0]!.id = "another-call")],
    ["wrong assistant arguments", (f) => (f.assistant.content[0]!.arguments.code = "return 1")],
    ["wrong assistant role", (f) => (f.assistant.role = "user")],
    ["duplicate assistant call", (f) => f.history.messages.unshift(f.assistant)],
    ["wrong result call id", (f) => (f.toolResult.toolCallId = "another-call")],
    ["duplicate result", (f) => f.history.messages.push(f.toolResult)],
    ["result before call", (f) => (f.history.messages = f.history.messages.toReversed())],
    ["ordinary final after result", (f) => f.history.messages.push({ role: "assistant" })],
    ["wrong result role", (f) => (f.toolResult.role = "assistant")],
    ["wrong tool name", (f) => (f.toolResult.toolName = "read")],
    ["error result", (f) => Object.assign(f.toolResult, { isError: true })],
    ["malformed JSON", (f) => (f.toolResult.content[0]!.text = '{"status":"completed"')],
    [
      "nested status only",
      (f) => (f.toolResult.content[0]!.text = '{"value":{"status":"completed"}}'),
    ],
    ["oversized result", (f) => (f.toolResult.content[0]!.text = "x".repeat(64_001))],
    ["ambiguous text blocks", (f) => f.toolResult.content.push(f.toolResult.content[0]!)],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => unknown]>)(
    "does not certify %s",
    (_name, mutate) => {
      const f = fixture();
      mutate(f);
      const observed = observeCodeModeTurnCompletion(f.params);
      expect(observed.status).toBe("pending");
      if (observed.status === "pending") {
        expect(observed.reason.length).toBeLessThan(100);
        expect(observed.reason).not.toContain(f.params.plannedCode);
      }
    },
  );

  it.each([
    ["waiting", (result) => (result.status = "waiting")],
    ["failed", (result) => (result.status = "failed")],
    ["missing following observation", (result) => (result.value.observed = false)],
    ["acknowledgement loss called success", (result) => (result.value.sent.status = "sent")],
    ["no dispatch evidence", (result) => (result.value.sent.sentBeforeError = false)],
    ["no acknowledgement error", (result) => (result.value.sent.error = "")],
  ] satisfies Array<[string, (result: ReturnType<typeof fixture>["result"]) => unknown]>)(
    "does not certify %s even when private details say completed",
    (_name, mutate) => {
      const f = fixture("A", "partial_failed");
      mutate(f.result);
      f.toolResult.content[0]!.text = JSON.stringify(f.result);
      Object.assign(f.toolResult, { details: { status: "completed", value: { observed: true } } });
      expect(observeCodeModeTurnCompletion(f.params).status).toBe("pending");
    },
  );
});
