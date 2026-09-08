import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BuildStatusTextParams } from "../status/status-text.types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  getPreparedModelCatalogSnapshot: vi.fn(),
  persistReplySessionEntry: vi.fn(),
  patchSessionEntryCore: vi.fn(),
  loadPreparedModelCatalogSnapshot: vi.fn(),
  loadProviderScopedThinkingCatalog: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
  loadManifestMetadataSnapshot: vi.fn(),
  normalizeProviderModel: vi.fn(),
  renderStatus: vi.fn(),
}));
vi.mock("../gateway/session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: mocks.loadSessionEntry,
}));
vi.mock("../agents/prepared-model-catalog.js", () => ({
  getPreparedModelCatalogSnapshot: mocks.getPreparedModelCatalogSnapshot,
}));
vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: () => [],
  loadPreparedModelCatalogSnapshot: mocks.loadPreparedModelCatalogSnapshot,
  loadProviderScopedThinkingCatalog: mocks.loadProviderScopedThinkingCatalog,
}));
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: mocks.normalizeProviderModel,
}));
vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
  isManifestPluginAvailableForControlPlane: () => false,
}));
vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
}));
vi.mock("../auto-reply/reply/session-entry-persistence.js", () => ({
  persistReplySessionEntry: mocks.persistReplySessionEntry,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: mocks.patchSessionEntryCore,
}));
vi.mock("../status/status-text.js", () => ({
  buildStatusReplyParts: mocks.renderStatus,
  buildStatusText: vi.fn(),
}));

const { resolveDirectStatusReplyForSessionCore } = await import("./command-status.runtime.js");

let sessionKey: string;
const catalog = [
  { provider: "status-provider", id: "default", name: "Default", reasoning: true },
  { provider: "status-provider", id: "pinned", name: "Pinned", reasoning: false },
];
let cfg: OpenClawConfig;
let entry: SessionEntry;
let store: Record<string, SessionEntry>;

function readStatus(authorized = true) {
  return resolveDirectStatusReplyForSessionCore({
    cfg,
    sessionKey,
    channel: "discord",
    senderIsOwner: authorized,
    isAuthorizedSender: authorized,
    isGroup: false,
    defaultGroupActivation: () => "always",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionKey = "agent:main:discord:direct:status-fixture";
  cfg = {
    agents: {
      entries: { main: {} },
      defaults: {
        model: { primary: "status-provider/default" },
        modelPolicy: { allow: ["status-provider/default"] },
        models: { "status-provider/default": {} },
      },
    },
  };
  entry = { sessionId: "status-session", updatedAt: 123 };
  store = { [sessionKey]: entry };
  mocks.loadSessionEntry.mockImplementation(() => ({
    cfg,
    canonicalKey: sessionKey,
    entry: structuredClone(entry),
    store,
    storePath: "/tmp/passive-status-fixture/sessions.json",
  }));
  mocks.getPreparedModelCatalogSnapshot.mockReturnValue({
    entries: catalog,
    routeVariants: catalog,
  });
  mocks.loadPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: catalog,
    routeVariants: catalog,
  });
  mocks.loadProviderScopedThinkingCatalog.mockResolvedValue(catalog);
  mocks.loadManifestMetadataSnapshot.mockReturnValue({ plugins: [] });
  mocks.normalizeProviderModel.mockReturnValue(undefined);
  mocks.ensureAuthProfileStore.mockReturnValue({
    version: 1,
    profiles: { "other:pinned": { provider: "other", type: "api_key", key: "synthetic" } },
  });
  mocks.persistReplySessionEntry.mockImplementation(async ({ entry: next }) => ({
    status: "current",
    entry: next,
  }));
  mocks.patchSessionEntryCore.mockImplementation(async (_target, update) => ({
    ...entry,
    ...update(entry),
  }));
  mocks.renderStatus.mockImplementation(async (params: BuildStatusTextParams) => ({
    text: JSON.stringify({
      provider: params.provider,
      model: params.model,
      think: params.resolvedThinkLevel,
      reasoning: params.resolvedReasoningLevel,
    }),
  }));
});

describe("direct status is a passive session read", () => {
  it.each([
    { authorized: true, pin: "model" },
    { authorized: false, pin: "model" },
    { authorized: true, pin: "auth" },
    { authorized: false, pin: "auth" },
  ] as const)(
    "keeps $pin state unchanged (authorized: $authorized)",
    async ({ authorized, pin }) => {
      if (pin === "model") {
        Object.assign(entry, {
          providerOverride: "status-provider",
          modelOverride: "pinned",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        });
      } else {
        entry.authProfileOverride = "other:pinned";
        entry.authProfileOverrideSource = "user";
      }
      const before = structuredClone({ entry, store });
      const result = await readStatus(authorized);
      expect(mocks.persistReplySessionEntry).not.toHaveBeenCalled();
      expect(mocks.patchSessionEntryCore).not.toHaveBeenCalled();
      expect({ entry, store }).toEqual(before);
      if (authorized) {
        expect(result?.text).toBeDefined();
        expect(mocks.renderStatus.mock.calls[0]?.[0].sessionEntry).toEqual(before.entry);
      } else {
        expect(result).toBeUndefined();
        expect(mocks.renderStatus).not.toHaveBeenCalled();
      }
    },
  );
});

it.each([
  { source: "config", level: "off", authorized: true },
  { source: "config", level: "stream", authorized: true },
  { source: "config", level: "stream", authorized: false },
  { source: "session", level: "stream", authorized: true },
  { source: "session", level: "stream", authorized: false },
] as const)(
  "preserves $source reasoning visibility (authorized: $authorized)",
  async ({ source, level, authorized }) => {
    cfg.agents!.defaults!.thinkingDefault = "off";
    if (source === "config") {
      cfg.agents!.defaults!.reasoningDefault = level;
    } else {
      entry.reasoningLevel = level;
    }
    const result = await readStatus(authorized);
    if (authorized) {
      expect(JSON.parse(result!.text!)).toMatchObject({ reasoning: level });
    } else {
      expect(result).toBeUndefined();
      expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
      expect(mocks.renderStatus).not.toHaveBeenCalled();
    }
  },
);

it.each([
  {
    session: "minimal",
    agent: "high",
    agentModel: "off",
    model: "med",
    global: "low",
    expected: "minimal",
  },
  { agent: "high", agentModel: "low", model: "med", global: "low", expected: "high" },
  { targetAgent: "worker", agentModel: "high", model: "med", global: "low", expected: "high" },
  { agentModel: false, model: "med", global: "low", expected: "off" },
  { model: "med", global: "low", expected: "medium" },
  { model: "auto", global: "low", expected: "adaptive" },
  { model: false, global: "low", expected: "off" },
  { model: "disabled", global: "low", expected: "off" },
  { global: "low", expected: "low" },
  { expected: "medium" },
] as const)(
  "uses passive thinking precedence $expected ($model, agent model: $agentModel)",
  async (scenario) => {
    const agentId = ("targetAgent" in scenario ? scenario.targetAgent : undefined) ?? "main";
    if (agentId !== "main") {
      cfg.agents!.entries![agentId] = {};
      sessionKey = `agent:${agentId}:discord:direct:status-fixture`;
      store = { [sessionKey]: entry };
    }
    if ("session" in scenario) {
      entry.thinkingLevel = scenario.session;
    }
    if ("agent" in scenario) {
      cfg.agents!.entries![agentId]!.thinkingDefault = scenario.agent;
    }
    if ("agentModel" in scenario) {
      cfg.agents!.entries![agentId]!.models = {
        "status-provider/default": { params: { thinking: scenario.agentModel } },
      };
    }
    if ("model" in scenario) {
      cfg.agents!.defaults!.models!["status-provider/default"] = {
        params: { thinking: scenario.model },
      };
    }
    if ("global" in scenario) {
      cfg.agents!.defaults!.thinkingDefault = scenario.global;
    }
    const result = await readStatus();
    expect(JSON.parse(result!.text!)).toMatchObject({ think: scenario.expected });
    expect(mocks.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  },
);

it.each([
  { provenance: "legacy-selected", cataloged: false, expected: "off" },
  { provenance: "resolved", cataloged: false, expected: "off" },
  { provenance: "legacy-selected", cataloged: true, expected: "off" },
  { provenance: "resolved", cataloged: true, expected: "off" },
] as const)(
  "preserves $provenance alias identity (cataloged: $cataloged)",
  async ({ provenance, cataloged, expected }) => {
    cfg.agents!.defaults!.modelPolicy = { allow: ["status-provider/*"] };
    cfg.agents!.defaults!.models!["status-provider/real"] = {
      alias: "tiny",
      params: { thinking: "high" },
    };
    Object.assign(entry, {
      providerOverride: "status-provider",
      modelOverride: "tiny",
      ...(provenance === "resolved"
        ? { modelOverrideSource: "user", modelOverrideRouteResolution: "resolved" }
        : {}),
    });
    const entries = [
      ...catalog,
      { provider: "status-provider", id: "real", name: "Real", reasoning: true },
      ...(cataloged
        ? [{ provider: "status-provider", id: "tiny", name: "Tiny", reasoning: false }]
        : []),
    ];
    mocks.getPreparedModelCatalogSnapshot.mockReturnValue({
      entries,
      routeVariants: entries,
    });
    const before = structuredClone({ entry, store });
    const result = await readStatus();
    expect(JSON.parse(result!.text!)).toMatchObject({ model: "tiny", think: expected });
    expect({ entry, store }).toEqual(before);
    expect(mocks.loadManifestMetadataSnapshot.mock.calls.length).toBe(0);
    expect(mocks.normalizeProviderModel.mock.calls.length).toBe(0);
    expect(mocks.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  },
);

it("keeps an unknown recorded identity and cold capability reads passive", async () => {
  entry.modelProvider = "status-provider";
  entry.model = "namespace/unknown";
  mocks.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
  const before = structuredClone({ entry, store });
  const result = await readStatus();
  expect(JSON.parse(result!.text!)).toMatchObject({
    provider: "status-provider",
    model: "namespace/unknown",
    think: "off",
    reasoning: "off",
  });
  expect({ entry, store }).toEqual(before);
  expect(mocks.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
  expect(mocks.loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
});

it.each([false, true])(
  "does not discover metadata while reading a configured alias (prepared: %s)",
  async (prepared) => {
    cfg.agents!.defaults!.model = { primary: "preferred" };
    cfg.agents!.defaults!.models!["status-provider/default"] = {
      alias: "preferred",
      params: { thinking: "high" },
    };
    if (!prepared) {
      mocks.getPreparedModelCatalogSnapshot.mockReturnValue(undefined);
    }
    const result = await readStatus();
    expect(JSON.parse(result!.text!)).toMatchObject({
      provider: "status-provider",
      model: "default",
      think: "high",
    });
    expect(mocks.loadManifestMetadataSnapshot.mock.calls.length).toBe(0);
    expect(mocks.normalizeProviderModel.mock.calls.length).toBe(0);
    expect(mocks.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  },
);
