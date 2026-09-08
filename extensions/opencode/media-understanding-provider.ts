// Opencode provider module implements model/runtime integration.
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";

export const opencodeMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "opencode",
  capabilities: ["image"],
  defaultModels: {
    image: "gpt-5-nano",
  },
};
