// Model key tests cover canonical provider/model key construction.
import { describe, expect, it } from "vitest";
import { modelKey } from "./model-key.js";

describe("modelKey", () => {
  it("joins provider and model into a canonical key", () => {
    expect(modelKey("openai", "gpt-5")).toBe("openai/gpt-5");
    expect(modelKey("anthropic", "claude-opus-4-8")).toBe("anthropic/claude-opus-4-8");
  });

  it("returns the model alone when provider is empty", () => {
    expect(modelKey("", "gpt-5")).toBe("gpt-5");
    expect(modelKey("   ", "gpt-5")).toBe("gpt-5");
  });

  it("returns the provider alone when model is empty", () => {
    expect(modelKey("openai", "")).toBe("openai");
    expect(modelKey("openai", "   ")).toBe("openai");
  });

  it("preserves a provider-local model namespace even when it repeats the provider", () => {
    expect(modelKey("custom", "custom/model")).toBe("custom/custom/model");
    expect(modelKey("custom", "model")).toBe("custom/model");
  });

  it("trims whitespace from both arguments", () => {
    expect(modelKey(" openai ", " gpt-5 ")).toBe("openai/gpt-5");
  });
});
