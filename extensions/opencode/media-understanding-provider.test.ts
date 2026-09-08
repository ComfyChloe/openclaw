// Model-backed image dispatch belongs to the shared media runtime.
import { expect, it } from "vitest";
import { opencodeMediaUnderstandingProvider } from "./media-understanding-provider.js";

it("declares OpenCode image understanding for shared model-backed dispatch", () => {
  expect(opencodeMediaUnderstandingProvider.id).toBe("opencode");
  expect(opencodeMediaUnderstandingProvider.capabilities).toEqual(["image"]);
  expect(opencodeMediaUnderstandingProvider.defaultModels).toEqual({ image: "gpt-5-nano" });
  expect(opencodeMediaUnderstandingProvider.describeImage).toBeUndefined();
  expect(opencodeMediaUnderstandingProvider.describeImages).toBeUndefined();
});
