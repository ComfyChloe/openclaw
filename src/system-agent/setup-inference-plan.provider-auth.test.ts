import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareAuthChoiceLoadedPluginProvider } from "../plugins/provider-auth-choice.js";
import { withSetupInferencePlan } from "./setup-inference-plan.js";

vi.mock("../agents/model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider: ({ cfg }: { cfg: OpenClawConfig }) =>
    cfg.agents?.defaults?.models?.["fixture/test-model"]?.agentRuntime?.id === "fixture-cli"
      ? "fixture-cli"
      : undefined,
}));

vi.mock("../plugins/provider-auth-choice.js", () => ({
  prepareAuthChoiceLoadedPluginProvider: vi.fn(),
  applyProviderPluginAuthMethodResultConfig: vi.fn(),
  runProviderPluginAuthMethodUnpersisted: vi.fn(),
}));
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntry: () => ({
    pluginId: "fixture",
    label: "Fixture",
    onboardingScopes: ["text-inference"],
  }),
}));

const existingInstall = { source: "npm" as const, spec: "@openclaw/existing" };
const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  plugins: { installs: { existing: existingInstall } },
};
const installRecord = {
  source: "npm" as const,
  spec: "@openclaw/fixture",
  installPath: "/tmp/fixture-plugin",
};
const persistAuthProfiles = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("catalog-only provider preparation", () => {
  it.each([
    {
      label: "installer detail",
      installError:
        "Synthetic install failed: package checksum differs. Retry after checking the registry.",
    },
    { label: "an undetailed skipped install", installError: undefined },
  ])("keeps $label in the terminal setup failure", async ({ installError }) => {
    vi.mocked(prepareAuthChoiceLoadedPluginProvider).mockResolvedValue({
      config,
      retrySelection: true,
      ...(installError ? { installError } : {}),
      authProfiles: [],
      persistAuthProfiles,
    });

    const result = await withSetupInferencePlan(
      {
        kind: "provider-auth",
        authChoice: "fixture-api-key",
        cfg: config,
        sourceCfg: config,
        pluginWorkspaceDir: "/tmp/selected-workspace",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
        prompter: createWizardPrompter(),
        deps: { resolveManifestProviderAuthChoice: () => undefined },
      },
      async () => {
        throw new Error("Unexpected successful plan");
      },
    );

    expect(result).toEqual({
      ok: false,
      status: "unavailable",
      error:
        installError ??
        "Fixture was not installed and configured. Review the installer details and try again.",
    });
    expect(persistAuthProfiles).not.toHaveBeenCalled();
  });

  it.each(["matching-last", "missing-match"] as const)(
    "selects the model provider's credential from %s auth profiles",
    async (profileCase) => {
      const matchingCredential = {
        type: "api_key" as const,
        provider: "FIXTURE",
        key: "synthetic-selected-key",
      };
      vi.mocked(prepareAuthChoiceLoadedPluginProvider).mockResolvedValue({
        config,
        agentModelOverride: "fixture/starter-alias",
        provider: {
          id: "fixture",
          label: "Fixture",
          auth: [],
          normalizeModelId: () => "test-model",
        },
        authProfiles: [
          {
            profileId: "other:default",
            credential: {
              type: "api_key",
              provider: "other",
              key: "synthetic-unrelated-key",
            },
          },
          ...(profileCase === "matching-last"
            ? [{ profileId: "fixture:default", credential: matchingCredential }]
            : []),
        ],
        persistAuthProfiles,
      });
      const result = await withSetupInferencePlan(
        {
          kind: "provider-auth",
          authChoice: "fixture-api-key",
          cfg: config,
          sourceCfg: config,
          pluginWorkspaceDir: "/tmp/selected-workspace",
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
          prompter: createWizardPrompter(),
          deps: { resolveManifestProviderAuthChoice: () => undefined },
        },
        async (plan) => {
          expect(profileCase).toBe("matching-last");
          expect(plan).toMatchObject({
            modelRef: "fixture/test-model",
            manualAuth: { profiles: [{ credential: matchingCredential }] },
          });
          expect(plan.authProfileId).toBe(plan.manualAuth?.profiles[0]?.profileId);
          return true;
        },
      );
      expect(persistAuthProfiles).not.toHaveBeenCalled();
      if (profileCase === "missing-match") {
        expect(result).toEqual({
          ok: false,
          status: "unavailable",
          error: expect.stringContaining("did not return credentials"),
        });
      } else {
        expect(result).toBe(true);
      }
    },
  );

  it.each(["openclaw", "fixture-cli"])(
    "normalizes the starter while retaining trusted installation and the selected %s runtime",
    async (runtimeId) => {
      const normalizeModelId = vi.fn(() => "test-model");
      vi.mocked(prepareAuthChoiceLoadedPluginProvider).mockResolvedValue({
        config: {
          ...config,
          agents: {
            ...config.agents,
            defaults: { models: { "fixture/starter-alias": { agentRuntime: { id: runtimeId } } } },
          },
          plugins: {
            entries: { fixture: { enabled: true } },
            installs: { fixture: { ...installRecord, spec: "untrusted-provider-patch" } },
          },
        },
        pendingPluginInstalls: { fixture: installRecord },
        agentModelOverride: "fixture/starter-alias",
        provider: { id: "fixture", label: "Fixture", auth: [], normalizeModelId },
        authProfiles: [],
        persistAuthProfiles,
      });
      const result = await withSetupInferencePlan(
        {
          kind: "provider-auth",
          authChoice: "fixture-api-key",
          cfg: config,
          sourceCfg: config,
          pluginWorkspaceDir: "/tmp/selected-workspace",
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
          prompter: createWizardPrompter(),
          deps: {
            resolveManifestProviderAuthChoice: () =>
              runtimeId === "fixture-cli"
                ? {
                    pluginId: "fixture",
                    providerId: "fixture",
                    choiceId: "fixture-api-key",
                    choiceLabel: "Fixture",
                    methodId: "native",
                  }
                : undefined,
          },
        },
        async (plan) => {
          expect(plan).toMatchObject({
            modelRef: "fixture/test-model",
            runner: runtimeId === "fixture-cli" ? "cli" : "embedded",
            selectedAgentRuntimeId: runtimeId,
            config: {
              plugins: { installs: { existing: existingInstall, fixture: installRecord } },
            },
          });
          expect(normalizeModelId).toHaveBeenCalledExactlyOnceWith({
            provider: "fixture",
            modelId: "starter-alias",
          });
          expect(persistAuthProfiles).not.toHaveBeenCalled();
          return true;
        },
      );
      expect(result).toBe(true);
    },
  );
});
