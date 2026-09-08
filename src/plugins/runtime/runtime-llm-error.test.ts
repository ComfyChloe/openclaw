import { describe, expect, it } from "vitest";
import { LlmCompleteError } from "./runtime-llm-error.js";

describe("LlmCompleteError", () => {
  it("preserves the completion error identity, fields and cause", () => {
    const cause = new Error("provider failed");
    const error = new LlmCompleteError("LLM_COMPLETION_FAILED", "Completion failed.", cause);

    expect(error).toBeInstanceOf(LlmCompleteError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "LlmCompleteError",
      code: "LLM_COMPLETION_FAILED",
      message: "Completion failed.",
      cause,
    });
    expect(error.cause).toBe(cause);
  });

  it("omits the cause property when no cause is supplied", () => {
    const error = new LlmCompleteError("LLM_COMPLETION_ABORTED", "Completion aborted.");

    expect(Object.hasOwn(error, "cause")).toBe(false);
  });
});
