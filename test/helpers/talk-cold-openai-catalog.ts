import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type {
  PluginCapabilityCatalogContext,
  PluginCapabilityCatalogEntry,
} from "../../src/plugins/capability-catalog-context.types.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../src/test-utils/bundled-plugin-public-surface.js";

/** Load the real static catalog while trapping credential and session operations. */
export async function createColdOpenAIRealtimeCatalogFixture() {
  const moduleId = resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "openai",
    artifactBasename: "capability-catalog.js",
  });
  // SAFETY: this manifest-owned public artifact exports the maintained catalog entry contract.
  const { default: catalogEntry } = (await import(moduleId)) as {
    default: PluginCapabilityCatalogEntry;
  };
  const credentialOperation = vi.fn(() => {
    throw new Error("cold owner must not resolve credentials");
  });
  const catalog =
    typeof catalogEntry === "function"
      ? catalogEntry(
          // SAFETY: every context operation is a function; the proxy traps all calls with a throwing spy.
          new Proxy({}, { get: () => credentialOperation }) as PluginCapabilityCatalogContext,
        )
      : catalogEntry;
  const provider = expectDefined(
    catalog.realtimeVoiceProviders?.[0],
    "OpenAI catalog voice provider",
  );
  const resolveConfig = vi.spyOn(provider, "resolveConfig").mockImplementation(() => {
    throw new Error("cold SecretRef");
  });
  const configured = vi.spyOn(provider, "isConfigured");
  const createBrowser = vi.spyOn(provider, "createBrowserSession");
  const createBridge = vi.spyOn(provider, "createBridge");
  return { provider, credentialOperation, resolveConfig, configured, createBrowser, createBridge };
}
