import { expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI sidebar agent roster" });

suite.define(() => {
  it("groups all agents' sessions, switches context, filters groups, and restores collapsed groups", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1280 } },
      async ({ page }) => {
        const agentsList: AgentsListResult = {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
            { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
            { id: "scout", name: "Scout", identity: { emoji: "🔭" } },
            { id: "bloom", name: "Bloom", identity: { emoji: "🌱" } },
          ],
        };
        const now = Date.now();
        const owners = [
          { type: "human", id: "profile-riley", label: "Riley" },
          { type: "human", id: "profile-devon", label: "Devon" },
        ] as const;
        const sessions = {
          ts: now,
          path: "",
          count: agentsList.agents.length * 3,
          defaults: { model: null, modelProvider: null, contextTokens: null },
          owners: [...owners],
          sessions: agentsList.agents.flatMap(
            (agent, index): Array<GatewaySessionRow & { updatedAt: number }> => [
              {
                key: `agent:${agent.id}:main`,
                kind: "direct",
                label: agent.name ?? agent.id,
                updatedAt: now - 600_000,
                agentId: agent.id,
                isMain: true,
                lastMessagePreview:
                  agent.id === "forge"
                    ? "Preparing the sample dashboard."
                    : "Ready for the next task.",
              },
              ...["project", "notes"].map(
                (suffix, sessionIndex): GatewaySessionRow & { updatedAt: number } => ({
                  key: `agent:${agent.id}:${suffix}`,
                  kind: "direct",
                  label: `${agent.name} ${suffix}`,
                  updatedAt: now - (index + 1) * 60_000 - sessionIndex * 1_000,
                  agentId: agent.id,
                  pinned: sessionIndex === 0,
                  owner: { actor: sessionIndex === 0 ? owners[0] : owners[1] },
                  hasActiveRun: agent.id === "forge" && sessionIndex === 0,
                  status: agent.id === "forge" && sessionIndex === 0 ? "running" : "done",
                  unread: agent.id === "scout" && sessionIndex === 1,
                  lastMessagePreview:
                    agent.id === "forge"
                      ? "Preparing the sample dashboard."
                      : "Ready for the next task.",
                }),
              ),
            ],
          ),
        } satisfies SessionsListResult;
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite",
            JSON.stringify({ dismissedAtMs: Date.now() }),
          );
        });
        await installMockGateway(page, {
          sessions: sessions.sessions,
          methodResponses: {
            "agents.list": agentsList,
            "agent.identity.get": {
              cases: agentsList.agents.map((agent) => ({
                match: { agentId: agent.id },
                response: {
                  agentId: agent.id,
                  name: agent.name,
                  emoji: agent.identity?.emoji,
                  avatar: "",
                },
              })),
            },
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "session:agent:main:main",
              thinkingLevel: null,
            },
            "sessions.list": sessions,
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        const chip = sidebar.locator(".sidebar-agent-card__main");
        const sessionRows = sidebar.locator(".sidebar-recent-session");
        await expect.poll(() => chip.isVisible()).toBe(true);
        await expect.poll(() => sessionRows.count()).toBe(2);
        expect(await sidebar.locator('[data-session-key="agent:forge:notes"]').count()).toBe(0);
        await captureSidebarUiProof(suite, page, "sidebar-roster-before.png");
        await chip.click();
        await sidebar.locator('wa-dropdown-item[value="command:sidebar-agents"]').click();

        const headers = sidebar.locator(".sidebar-agent-roster__row");
        await expect.poll(() => headers.count()).toBe(4);
        await expect
          .poll(() =>
            headers.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent-id"))),
          )
          .toEqual(["forge", "main", "scout", "bloom"]);
        await expect.poll(() => sessionRows.count()).toBe(8);
        expect(await chip.isVisible()).toBe(true);
        for (const agent of agentsList.agents) {
          const group = sidebar.locator(`[data-agent-group="${agent.id}"]`);
          expect(await group.locator(".sidebar-recent-session").allTextContents()).toEqual([
            expect.stringContaining(`${agent.name} project`),
            expect.stringContaining(`${agent.name} notes`),
          ]);
          expect(
            await group
              .getByRole("link", { name: "New session", exact: true })
              .getAttribute("href"),
          ).toBe(`/new?agent=${agent.id}`);
          expect(
            await group.getByRole("link", { name: "Open chat", exact: true }).getAttribute("href"),
          ).toBe(`/chat/${agent.id}`);
        }
        expect(
          await sidebar
            .locator('[data-agent-id="scout"] .sidebar-agent-roster__unread')
            .textContent(),
        ).toBe("1");
        expect(await headers.first().textContent()).toContain(
          "Working: Preparing the sample dashboard.",
        );
        await captureSidebarUiProof(suite, page, "sidebar-roster-after.png");

        await sidebar
          .locator('[data-session-key="agent:forge:notes"] .sidebar-recent-session__link')
          .click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/forge/notes" });
        await expect.poll(() => chip.textContent()).toContain("Forge");
        await expect.poll(() => sessionRows.count()).toBe(8);
        await sidebar.locator(".sidebar-session-sort").click();
        expect(
          await sidebar.locator('.sidebar-session-sort-menu [value^="grouping:"]').count(),
        ).toBe(0);
        expect(
          await sidebar.locator('.sidebar-session-sort-menu [value="hide-empty-groups"]').count(),
        ).toBe(0);
        await sidebar.locator(".sidebar-session-sort-menu .sidebar-session-owner-submenu").hover();
        await sidebar.locator('.sidebar-session-sort-menu [value="owner:profile-riley"]').click();
        await expect.poll(() => sessionRows.count()).toBe(4);
        expect(await sessionRows.allTextContents()).toEqual([
          expect.stringContaining("Forge project"),
          expect.stringContaining("Harbor project"),
          expect.stringContaining("Scout project"),
          expect.stringContaining("Bloom project"),
        ]);
        await sidebar.locator(".sidebar-session-sort").click();
        await sidebar.locator('.sidebar-session-sort-menu [value="owner:"]').click();
        await expect.poll(() => sessionRows.count()).toBe(8);

        await sidebar.locator('[data-agent-id="bloom"]').click();
        await expect.poll(() => sessionRows.count()).toBe(6);
        await page.reload();
        await expect.poll(() => headers.count()).toBe(4);
        await expect
          .poll(() => sidebar.locator('[data-agent-id="bloom"]').getAttribute("aria-expanded"))
          .toBe("false");
        await expect.poll(() => sessionRows.count()).toBe(6);
        expect(await chip.isVisible()).toBe(true);
        await sidebar.getByRole("link", { name: "See all", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "agents-home", pathname: "/agents" });
        await expect.poll(() => page.locator(".agents-home__card").count()).toBe(4);
        await chip.click();
        await sidebar.locator('wa-dropdown-item[value="command:sidebar-agents"]').click();
        await expect.poll(() => headers.count()).toBe(0);
        expect(await chip.isVisible()).toBe(true);
      },
    );
  });
});
