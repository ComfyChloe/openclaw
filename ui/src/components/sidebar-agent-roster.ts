import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { pathForRoute } from "../app-route-paths.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { AgentRosterElement } from "../lib/agents/roster-element.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.ts";
import { renderSessionListFrame, renderSessionSection } from "./app-sidebar-session-list-render.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import type { SessionListHost } from "./app-sidebar-session-row-render.ts";
import { icons } from "./icons.ts";
import { renderNewSessionLink } from "./new-session-link.ts";
import "../styles/sidebar-agent-roster.css";

registerAgentsHomeEnglish();
type RosterHost = AppSidebarRenderHost &
  SessionListHost & { loadMoreSidebarSessions(): Promise<void> };

class SidebarAgentRoster extends AgentRosterElement {
  @property({ attribute: false }) host!: RosterHost;
  @property({ attribute: false }) sections: SidebarVisibleSections["sections"] = [];
  @property({ attribute: false }) involvingMe = false;
  @state() private collapsed = new Set<string>();
  private settingsScope: string | null = null;
  private published: {
    snapshot: ReturnType<typeof rosterActivityStore>["snapshot"];
    collapsed: ReadonlySet<string>;
  } | null = null;

  protected override willUpdate() {
    const gatewayUrl = this.context.gateway.connection.gatewayUrl;
    if (this.settingsScope !== gatewayUrl) {
      this.settingsScope = gatewayUrl;
      this.collapsed = new Set(loadSettings(gatewayUrl).sidebarCollapsedAgentIds ?? []);
    }
    const store = rosterActivityStore(this.context);
    store.setInvolvingMe(this.involvingMe);
    const snapshot = store.snapshot;
    if (this.published?.snapshot !== snapshot || this.published.collapsed !== this.collapsed) {
      this.published = { snapshot, collapsed: this.collapsed };
      this.host.rosterSessionSource = {
        result: snapshot.result,
        agentIds: snapshot.cards.map((card) => card.id),
        collapsedAgentIds: this.collapsed,
      };
    }
  }

  override disconnectedCallback() {
    this.host.rosterSessionSource = null;
    // Agents home keeps the shared window alive after the grouped filter leaves.
    rosterActivityStore(this.context).setInvolvingMe(false);
    super.disconnectedCallback();
  }

  private toggleAgent(id: string) {
    const collapsed = new Set(this.collapsed);
    if (!collapsed.delete(id)) {
      collapsed.add(id);
    }
    patchSettings(
      {
        gatewayUrl: this.context.gateway.connection.gatewayUrl,
        sidebarCollapsedAgentIds: [...collapsed],
      },
      { selectGateway: false },
    );
    this.collapsed = collapsed;
  }

  override render() {
    return this.avatars.withActiveRoutes(() => {
      const cards = this.cards();
      const error = this.roster.error ?? this.roster.subscriptionError;
      const newSessionAccess = this.host.readNewSessionAccess();
      const seeAll = html`<a
        class="sidebar-agent-roster__link"
        href=${pathForRoute("agents-home", this.host.basePath)}
        @click=${(event: MouseEvent) => {
          if (shouldHandleNavigationClick(event)) {
            event.preventDefault();
            this.host.onNavigate?.("agents-home");
          }
        }}
        >${t("agentsHome.seeAll")}</a
      >`;
      return renderSessionListFrame(
        this.host,
        html`<div class="sidebar-agent-roster">
          ${error ? html`<button class="sidebar-agent-roster__link" @click=${() => void this.refresh()}>${t("agentsHome.loadFailed")}</button>` : nothing}
          ${repeat(
            cards,
            (card) => card.id,
            (card) => {
              const collapsed = this.collapsed.has(card.id);
              const unread = card.unreadCount;
              const activity = !this.connected
                ? t("agentsHome.disconnected")
                : card.activeNow
                  ? t("agentsHome.workingPreview", {
                      preview: card.preview || t("agentsHome.noMessage"),
                    })
                  : card.lastActiveAt
                    ? t("agentsHome.lastActive", {
                        time: formatRelativeTimestamp(card.lastActiveAt),
                      })
                    : t("agentsHome.neverActive");
              return html`<section
                class="sidebar-agent-roster__group"
                data-agent-group=${card.id}
                aria-label=${card.name}
              >
                <div class="sidebar-agent-roster__header">
                  <button
                    type="button"
                    class="sidebar-agent-roster__row"
                    data-agent-id=${card.id}
                    aria-expanded=${String(!collapsed)}
                    @click=${() => this.toggleAgent(card.id)}
                  >
                    <span class="sidebar-agent-roster__chevron" aria-hidden="true"
                      >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                    >
                    <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                      ${card.avatar ? html`<img src=${card.avatar} alt="" loading="lazy" />` : card.fallback}
                      <span
                        class="sidebar-agent-roster__status"
                        data-working=${String(this.connected && card.activeNow)}
                      ></span>
                    </span>
                    <span class="sidebar-agent-roster__copy"
                      ><span>${card.name}</span
                      ><span class="sidebar-agent-roster__activity" title=${activity}
                        >${activity}</span
                      ></span
                    >
                    ${unread > 0 ? html`<span class="sidebar-agent-roster__unread" aria-label=${t("sessionsView.unread")}>${unread}</span>` : nothing}
                  </button>
                  <a
                    class="sidebar-agent-roster__action"
                    href=${card.target.href}
                    aria-label=${t("agentsHome.openChat")}
                    title=${t("agentsHome.openChat")}
                    @click=${(event: MouseEvent) => {
                      if (shouldHandleNavigationClick(event)) {
                        event.preventDefault();
                        this.host.openMainSession(card.id);
                      }
                    }}
                    >${icons.messageSquare}</a
                  >
                  ${renderNewSessionLink({
                    basePath: this.host.basePath,
                    agentId: card.id,
                    className: "sidebar-agent-roster__action",
                    label: t("chat.runControls.newSession"),
                    disabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
                    onOpen: (id, target) => this.host.requestOpenNewSession(id, target),
                  })}
                </div>
                ${
                  collapsed
                    ? nothing
                    : this.sections
                        .filter((section) => section.id.startsWith(`agent:${card.id}:`))
                        .map((section) =>
                          renderSessionSection({
                            host: this.host,
                            section,
                            personHeaders: undefined,
                          }),
                        )
                }
              </section>`;
            },
          )}
        </div>`,
        seeAll,
      );
    });
  }
}

customElements.define("openclaw-sidebar-agent-roster", SidebarAgentRoster);

export function renderSidebarAgentRoster(
  host: RosterHost,
  sections: SidebarVisibleSections["sections"],
) {
  return html`<openclaw-sidebar-agent-roster
    .host=${host}
    .sections=${sections}
    .involvingMe=${host.sessionInvolvingMeFilterActive}
  ></openclaw-sidebar-agent-roster>`;
}
