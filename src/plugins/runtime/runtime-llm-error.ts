import type { LlmCompleteErrorCode } from "./types-core.js";

export class LlmCompleteError extends Error {
  constructor(
    readonly code: LlmCompleteErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LlmCompleteError";
  }
}
