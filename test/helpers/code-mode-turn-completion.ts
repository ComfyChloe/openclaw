import { isRecord } from "@openclaw/normalization-core/record-coerce";

type CompletionParams = {
  history: unknown;
  sessionKey: string;
  sessionId?: string;
  plannedToolCallId: string;
  plannedCode: string;
  marker: string;
  deliveryStatus: "sent" | "partial_failed";
};

type CompletionObservation =
  | { status: "pending"; reason: string }
  | {
      status: "complete";
      sessionId: string;
      toolCallId: string;
      messages: unknown[];
      execResult: Record<string, unknown>;
    };

/** Observe the public history projection, never private result details or escaped JSON text. */
export function observeCodeModeTurnCompletion(params: CompletionParams): CompletionObservation {
  const pending = (reason: string): CompletionObservation => ({ status: "pending", reason });
  const history = params.history;
  if (!isRecord(history) || !Array.isArray(history.messages) || history.messages.length > 1_000) {
    return pending("history unavailable");
  }
  if (
    history.sessionKey !== params.sessionKey ||
    typeof history.sessionId !== "string" ||
    !history.sessionId ||
    (params.sessionId !== undefined && history.sessionId !== params.sessionId)
  ) {
    return pending("session identity mismatch");
  }
  if (!params.plannedToolCallId || !params.marker || !params.plannedCode.includes(params.marker)) {
    return pending("current provider plan unavailable");
  }
  const calls = history.messages.flatMap((message, index) =>
    isRecord(message) && message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((block) =>
          isRecord(block) &&
          block.type === "toolCall" &&
          block.name === "exec" &&
          block.id === params.plannedToolCallId &&
          isRecord(block.arguments) &&
          block.arguments.code === params.plannedCode
            ? [index]
            : [],
        )
      : [],
  );
  if (calls.length !== 1) {
    return pending("current assistant exec identity unavailable or ambiguous");
  }
  const results = history.messages.flatMap((message, index) =>
    isRecord(message) &&
    message.role === "toolResult" &&
    message.toolName === "exec" &&
    message.toolCallId === params.plannedToolCallId
      ? [{ message, index }]
      : [],
  );
  if (results.length !== 1 || results[0]!.index <= calls[0]!) {
    return pending("current exec result unavailable or ambiguous");
  }
  const { message, index } = results[0]!;
  if (index !== history.messages.length - 1 || message.isError === true) {
    return pending("current exec is not the final successful transcript result");
  }
  const textBlocks = Array.isArray(message.content)
    ? message.content.filter((block) => isRecord(block) && block.type === "text")
    : [];
  const text = textBlocks.length === 1 ? textBlocks[0]?.text : undefined;
  if (typeof text !== "string" || text.length > 64_000) {
    return pending("current exec text unavailable or oversized");
  }
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    return pending("current exec text is not complete JSON");
  }
  if (!isRecord(result) || result.status !== "completed") {
    return pending("current exec has not completed");
  }
  const value = result.value;
  const sent = isRecord(value) ? value.sent : undefined;
  if (
    !isRecord(value) ||
    value.observed !== true ||
    !isRecord(sent) ||
    sent.status !== params.deliveryStatus ||
    (params.deliveryStatus === "partial_failed" &&
      (sent.sentBeforeError !== true || typeof sent.error !== "string" || !sent.error.trim()))
  ) {
    return pending("current delivery outcome or following observation mismatch");
  }
  if (!isRecord(history.sessionInfo) || history.sessionInfo.hasActiveRun !== false) {
    return pending("session still active or activity unknown");
  }
  return {
    status: "complete",
    sessionId: history.sessionId,
    toolCallId: params.plannedToolCallId,
    messages: history.messages,
    execResult: result,
  };
}
