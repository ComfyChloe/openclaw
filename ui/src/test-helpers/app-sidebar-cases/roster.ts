import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "../../components/app-sidebar-session-types.ts";
import {
  createGateway,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";

const roster: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
    { id: "recent", name: "Scout" },
    { id: "working", name: "Forge" },
    { id: "system", name: "System helper", kind: "system" },
  ],
};
const owners = [
  { type: "human", id: "profile-ada", label: "Ada" },
  { type: "human", id: "profile-sam", label: "Sam" },
] as const;

function session(agentId: string, updatedAt: number, extra: Partial<GatewaySessionRow> = {}) {
  return {
    key: `agent:${agentId}:main`,
    agentId,
    isMain: true,
    kind: "direct",
    updatedAt,
    ...extra,
  } satisfies GatewaySessionRow;
}

async function mountRoster(
  agents = roster,
  rows?: GatewaySessionRow[],
  gatewayUrl = "ws://gateway.test",
  lineageRows: GatewaySessionRow[] = [],
) {
  const now = Date.now();
  const fixtureRows =
    rows ??
    agents.agents.flatMap((agent, index) => {
      const updatedAt = now - (index + 1) * 60_000;
      return [
        session(agent.id, updatedAt - 300_000, {
          lastMessagePreview: "Preparing the project summary.",
        }),
        session(agent.id, updatedAt, {
          key: `agent:${agent.id}:pinned`,
          label: `${agent.name} project`,
          isMain: false,
          pinned: true,
          pinnedAt: updatedAt,
          owner: { actor: owners[0] },
          hasActiveRun: agent.id === "working" || agent.kind === "system",
          lastMessagePreview: "Preparing the project summary.",
        }),
        session(agent.id, updatedAt - 1_000, {
          key: `agent:${agent.id}:recent`,
          label: `${agent.name} notes`,
          isMain: false,
          owner: { actor: owners[1] },
          unread: agent.id === "main",
        }),
        session(agent.id, updatedAt - 2_000, {
          key: `agent:${agent.id}:archived`,
          label: `${agent.name} archive`,
          isMain: false,
          archived: true,
          unread: true,
          owner: { actor: owners[0] },
        }),
      ];
    });
  const result: SessionsListResult = {
    ts: now,
    path: "",
    count: fixtureRows.length,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    owners: [...owners],
    sessions: fixtureRows,
  };
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "sessions.list") {
      return result;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (
      method === "sessions.get" &&
      typeof params === "object" &&
      params !== null &&
      "key" in params
    ) {
      const key = params.key;
      const row = lineageRows.find((entry) => entry.key === key);
      if (row) {
        return { session: row };
      }
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const gateway = createGateway(createTestGatewayClient(request));
  gateway.connection.gatewayUrl = gatewayUrl;
  patchSettings({ gatewayUrl });
  const sessions = createSessionsHarness("main", ["agent:main:main"]);
  const mainRows = fixtureRows.filter((row) => row.agentId === "main");
  sessions.publish({ result: { ...result, count: mainRows.length, sessions: mainRows } });
  const mounted = await mountSidebar(gateway, sessions.sessions, "panel", agents);
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  return { ...mounted, sessions };
}

function agentIds(sidebar: HTMLElement) {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-roster__row")].map(
    (row) => row.dataset.agentId,
  );
}

function sessionKeys(sidebar: HTMLElement) {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session")].map(
    (row) => row.dataset.sessionKey,
  );
}

async function toggleRoster(sidebar: HTMLElement) {
  const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main");
  if (!trigger) {
    throw new Error("Missing agent switch control");
  }
  trigger.click();
  await vi.waitFor(() => {
    expect(sidebar.querySelector('[value="command:sidebar-agents"]')).not.toBeNull();
  });
  const item = sidebar.querySelector('[value="command:sidebar-agents"]');
  sidebar
    .querySelector(".sidebar-agent-menu")
    ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));
}

async function selectFilter(sidebar: SidebarLifecycleState, value: string) {
  sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")?.click();
  await vi.waitFor(() => {
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).not.toBeNull();
  });
  sidebar
    .querySelector(".sidebar-session-sort-menu")
    ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } }, bubbles: true }));
  await sidebar.updateComplete;
}

describe("AppSidebar agent roster", () => {
  it("nests pinned and recent sessions under every selectable agent in work and recency order", async () => {
    const { sidebar } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["working", "main", "recent"]));
    for (const id of ["working", "main", "recent"]) {
      const group = sidebar.querySelector<HTMLElement>(`[data-agent-group="${id}"]`);
      if (!group) {
        throw new Error(`Missing session group for ${id}`);
      }
      await vi.waitFor(() =>
        expect(sessionKeys(group)).toEqual([`agent:${id}:pinned`, `agent:${id}:recent`]),
      );
      expect(group?.querySelector(`a[href="/new?agent=${id}"]`)).not.toBeNull();
      expect(group?.querySelector('a[aria-label="Open chat"]')?.getAttribute("href")).toBe(
        `/chat/${id}`,
      );
    }
    expect(sidebar.querySelector('[data-agent-id="working"]')?.textContent).toContain(
      "Working: Preparing the project summary.",
    );
    expect(
      sidebar.querySelectorAll('.sidebar-agent-roster__status[data-working="true"]'),
    ).toHaveLength(1);
    expect(sidebar.querySelector('[data-agent-id="recent"]')?.textContent).toMatch(/Active /);
    expect(
      sidebar.querySelector('[data-agent-id="main"] .sidebar-agent-roster__unread')?.textContent,
    ).toBe("1");
    expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull();
  });

  it("switches active agent when a grouped session or main chat is opened", async () => {
    const { sidebar, context } = await mountRoster();
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain("agent:working:recent"));
    sidebar
      .querySelector<HTMLAnchorElement>(
        '[data-session-key="agent:working:recent"] .sidebar-recent-session__link',
      )
      ?.click();
    await vi.waitFor(() =>
      expect(context.agentSelection.state).toEqual({ selectedId: "working", scopeId: "working" }),
    );
    expect(onNavigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/working/recent" }),
    );
    await vi.waitFor(() =>
      expect(sidebar.querySelector(".sidebar-agent-card__main")?.textContent).toContain("Forge"),
    );
    sidebar
      .querySelector<HTMLAnchorElement>('[data-agent-group="recent"] a[aria-label="Open chat"]')
      ?.click();
    await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("recent"));
    expect(onNavigate).toHaveBeenLastCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/recent" }),
    );
  });

  it.each([undefined, "main"])(
    "opens an unprefixed default-agent session from another group (agentId=%s)",
    async (agentId) => {
      const { sidebar, context, sessions } = await mountRoster(roster, [
        session("working", 3, { key: "agent:working:task", isMain: false }),
        {
          key: "legacy-task",
          kind: "direct",
          updatedAt: 2,
          agentId,
          hasActiveRun: true,
          unread: true,
        },
      ]);
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      sidebar.sidebarAgentsMode = "roster";
      await vi.waitFor(() => {
        expect(agentIds(sidebar)).toHaveLength(3);
        expect(sessionKeys(sidebar)).toContain("agent:working:task");
        expect(
          sidebar
            .querySelector('[data-agent-id="main"] .sidebar-agent-roster__status')
            ?.getAttribute("data-working"),
        ).toBe("true");
        expect(
          sidebar.querySelector('[data-agent-id="main"] .sidebar-agent-roster__unread')
            ?.textContent,
        ).toBe("1");
      });
      sidebar
        .querySelector<HTMLAnchorElement>(
          '[data-session-key="agent:working:task"] .sidebar-recent-session__link',
        )
        ?.click();
      await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("working"));
      sidebar.sessionKey = "agent:working:task";
      await sidebar.updateComplete;
      sidebar
        .querySelector<HTMLButtonElement>('[data-session-key="legacy-task"] .session-action--pin')
        ?.click();
      await vi.waitFor(() =>
        expect(sessions.patch).toHaveBeenCalledWith(
          "legacy-task",
          { pinned: true },
          expect.objectContaining({ agentId: "main" }),
        ),
      );
      expect(context.agentSelection.state.selectedId).toBe("working");
      sidebar
        .querySelector<HTMLAnchorElement>(
          '[data-session-key="legacy-task"] .sidebar-recent-session__link',
        )
        ?.click();
      await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("main"));
      expect(onNavigate).toHaveBeenLastCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/main/legacy-task" }),
      );
    },
  );

  it("groups an unprefixed session by its row agent and navigates to that same agent", async () => {
    const { sidebar, context, sessions } = await mountRoster(roster, [
      {
        key: "legacy-task",
        kind: "direct",
        agentId: "working",
        label: "Existing work",
        updatedAt: 2,
      },
      session("working", 1, { key: "agent:working:older", isMain: false }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await selectFilter(sidebar, "sort:updated");
    await vi.waitFor(() => {
      expect(
        sidebar.querySelector('[data-agent-group="working"] [data-session-key="legacy-task"]'),
      ).not.toBeNull();
      expect(
        [
          ...sidebar.querySelectorAll<HTMLElement>(
            '[data-agent-group="working"] [data-session-key]',
          ),
        ].map((row) => row.dataset.sessionKey),
      ).toEqual(["legacy-task", "agent:working:older"]);
      expect(
        sidebar.querySelector('[data-agent-group="main"] [data-session-key="legacy-task"]'),
      ).toBeNull();
    });
    const link = sidebar.querySelector<HTMLAnchorElement>(
      '[data-session-key="legacy-task"] .sidebar-recent-session__link',
    );
    expect(link?.pathname).toBe("/chat/working/legacy-task");
    sidebar
      .querySelector<HTMLButtonElement>('[data-session-key="legacy-task"] .session-action--pin')
      ?.click();
    await vi.waitFor(() =>
      expect(sessions.patch).toHaveBeenCalledWith(
        "legacy-task",
        { pinned: true },
        expect.objectContaining({ agentId: "working" }),
      ),
    );
    expect(context.agentSelection.state.selectedId).toBe("main");
    link?.click();
    await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("working"));
  });

  it("restores each Gateway's own collapsed groups when the context changes", async () => {
    const { sidebar, provider } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    sidebar.querySelector<HTMLButtonElement>('[data-agent-id="working"]')?.click();
    await vi.waitFor(() =>
      expect(loadSettings("ws://gateway.test").sidebarCollapsedAgentIds).toEqual(["working"]),
    );
    patchSettings({ gatewayUrl: "ws://second.test", sidebarCollapsedAgentIds: ["recent"] });
    const replacement = await mountRoster(roster, undefined, "ws://second.test");
    provider.setContext(replacement.context);
    replacement.provider.remove();
    await vi.waitFor(() => {
      expect(
        sidebar.querySelector('[data-agent-id="working"]')?.getAttribute("aria-expanded"),
      ).toBe("true");
      expect(sidebar.querySelector('[data-agent-id="recent"]')?.getAttribute("aria-expanded")).toBe(
        "false",
      );
    });
    sidebar.querySelector<HTMLButtonElement>('[data-agent-id="main"]')?.click();
    await vi.waitFor(() =>
      expect(loadSettings("ws://second.test").sidebarCollapsedAgentIds).toEqual(["recent", "main"]),
    );
    expect(loadSettings("ws://gateway.test").sidebarCollapsedAgentIds).toEqual(["working"]);
  });

  it.each(["outside the window", "archived", "archived child", "child of main"])(
    "keeps a directly opened session visible when %s",
    async (variant) => {
      const key = "agent:working:older";
      const parentKey = variant === "child of main" ? "agent:main:main" : "agent:main:parent";
      const current = session("working", 1, {
        key,
        isMain: false,
        label: "Opened conversation",
        archived: variant === "archived" || variant === "archived child",
        ...(["archived child", "child of main"].includes(variant) ? { spawnedBy: parentKey } : {}),
      });
      const parent = session("main", 0, {
        key: parentKey,
        isMain: variant === "child of main",
        archived: variant !== "child of main",
        childSessions: [key],
      });
      const bounded = [
        session("main", 10, { key: "agent:main:recent", isMain: false }),
        ...(variant === "outside the window" ? [] : [current, parent]),
      ];
      const { sidebar, context } = await mountRoster(roster, bounded, undefined, [current, parent]);
      sidebar.sidebarAgentsMode = "roster";
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key;
      context.agentSelection.set("working");
      await vi.waitFor(() => {
        const rows = sidebar.querySelectorAll(`[data-session-key="${key}"]`);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.classList.contains("sidebar-recent-session--active")).toBe(true);
      });
      expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).toBeNull();
    },
  );

  it("shows every agent beyond six and links from the Sessions toolbar to Agents home", async () => {
    const agents: AgentsListResult = {
      ...roster,
      agents: Array.from({ length: 8 }, (_, index) => ({ id: `agent-${index}` })),
    };
    const { sidebar } = await mountRoster(
      agents,
      agents.agents.map((agent, index) =>
        session(agent.id, index + 1, { hasActiveRun: index === 0 }),
      ),
    );
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() =>
      expect(agentIds(sidebar)).toEqual([
        "agent-0",
        "agent-7",
        "agent-6",
        "agent-5",
        "agent-4",
        "agent-3",
        "agent-2",
        "agent-1",
      ]),
    );
    const link = sidebar.querySelector<HTMLAnchorElement>(
      '.sidebar-agent-roster__link[href="/agents"]',
    );
    expect(link?.textContent?.trim()).toBe("See all");
    expect(link?.closest(".sidebar-agent-roster")).toBeNull();
  });

  it("remembers collapsed agents after remount and keeps chip mode scoped to one agent", async () => {
    const { sidebar, provider } = await mountRoster();
    expect(sidebar.querySelector(".sidebar-agent-roster")).toBeNull();
    expect(sessionKeys(sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
    await toggleRoster(sidebar);
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    expect(loadSettings().sidebarAgentsMode).toBe("roster");
    sidebar.querySelector<HTMLButtonElement>('[data-agent-id="working"]')?.click();
    await vi.waitFor(() => expect(sessionKeys(sidebar)).not.toContain("agent:working:pinned"));
    expect(loadSettings().sidebarCollapsedAgentIds).toEqual(["working"]);
    provider.remove();
    const remounted = await mountRoster();
    remounted.sidebar.sidebarAgentsMode = loadSettings().sidebarAgentsMode ?? "chip";
    await vi.waitFor(() => expect(agentIds(remounted.sidebar)).toHaveLength(3));
    expect(
      remounted.sidebar.querySelector('[data-agent-id="working"]')?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(sessionKeys(remounted.sidebar)).not.toContain("agent:working:recent");
    expect(sessionKeys(remounted.sidebar)).toContain("agent:recent:recent");
    await toggleRoster(remounted.sidebar);
    await vi.waitFor(() =>
      expect(remounted.sidebar.querySelector(".sidebar-agent-roster")).toBeNull(),
    );
    expect(loadSettings().sidebarAgentsMode).toBe("chip");
    expect(sessionKeys(remounted.sidebar)).toEqual(["agent:main:pinned", "agent:main:recent"]);
  });

  it("applies owner and archived filters across all agent groups", async () => {
    const { sidebar } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toHaveLength(6));
    await selectFilter(sidebar, "owner:profile-ada");
    await vi.waitFor(() =>
      expect(sessionKeys(sidebar)).toEqual([
        "agent:working:pinned",
        "agent:main:pinned",
        "agent:recent:pinned",
      ]),
    );
    await selectFilter(sidebar, "status:archived");
    await vi.waitFor(() =>
      expect(sessionKeys(sidebar)).toEqual([
        "agent:working:archived",
        "agent:main:archived",
        "agent:recent:archived",
      ]),
    );
    expect(agentIds(sidebar)).toEqual(["working", "main", "recent"]);
  });

  it("filters archived children and promoted main-session children at the same boundary as roots", async () => {
    const { sidebar } = await mountRoster(roster, [
      session("working", 10, { childSessions: ["agent:working:main-child"] }),
      session("working", 9, {
        key: "agent:working:parent",
        isMain: false,
        childSessions: ["agent:working:archived-child"],
      }),
      session("working", 8, {
        key: "agent:working:archived-child",
        isMain: false,
        spawnedBy: "agent:working:parent",
        category: "Saved work",
        archived: true,
      }),
      session("working", 7, {
        key: "agent:working:main-child",
        isMain: false,
        spawnedBy: "agent:working:main",
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() =>
      expect(sessionKeys(sidebar)).toEqual(["agent:working:parent", "agent:working:main-child"]),
    );
    expect(sidebar.querySelector('[data-child-session-toggle="agent:working:parent"]')).toBeNull();
    await selectFilter(sidebar, "status:archived");
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toEqual(["agent:working:archived-child"]));
  });

  it("keeps a group's expanded page when selecting a session in another group", async () => {
    const count = SIDEBAR_SESSION_PAGE_SIZE + 2;
    const { sidebar, context } = await mountRoster(roster, [
      ...Array.from({ length: count }, (_, index) =>
        session("working", count - index, {
          key: `agent:working:thread-${index}`,
          isMain: false,
        }),
      ),
      session("recent", 1, { key: "agent:recent:notes", isMain: false }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    const group = () => sidebar.querySelector<HTMLElement>('[data-agent-group="working"]');
    await vi.waitFor(() =>
      expect(group()?.querySelectorAll(".sidebar-recent-session")).toHaveLength(
        SIDEBAR_SESSION_PAGE_SIZE,
      ),
    );
    group()?.querySelector<HTMLButtonElement>('[aria-label="Show more"]')?.click();
    await vi.waitFor(() =>
      expect(group()?.querySelectorAll(".sidebar-recent-session")).toHaveLength(count),
    );
    sidebar
      .querySelector<HTMLAnchorElement>(
        '[data-session-key="agent:recent:notes"] .sidebar-recent-session__link',
      )
      ?.click();
    await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("recent"));
    await sidebar.updateComplete;
    expect(group()?.querySelectorAll(".sidebar-recent-session")).toHaveLength(count);
  });
});
