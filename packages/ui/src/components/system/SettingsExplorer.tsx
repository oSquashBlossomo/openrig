// Slice 26 — Settings destination Explorer sidebar.
//
// Renders the Settings destinations as a flat sidebar list (peer to
// Topology / Project / Library / For-You destinations per dispatch).
// Each item is a TanStack Router Link to its sub-route. The active
// item is derived from the current router pathname so the sidebar
// stays in sync regardless of how the user navigated.
//
// Two groups: editable/operational Settings (Settings / Policies / Log)
// and System views of the connected instance. Status (daemon process
// health) stays distinct from Health (canonical findings), and the
// read-only Configuration browser stays distinct from editable Settings.

import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";

interface SettingsExplorerItem {
  id: "settings" | "policies" | "log" | "status" | "health" | "configuration" | "connections" | "startup" | "restore" | "terminals" | "help";
  label: string;
  /** Short distinguishing hint rendered under the label. */
  hint?: string;
  href: string;
  /**
   * Predicate matching the current pathname to "active" state.
   * The Settings root is the exact match `/settings`; sub-routes
   * match their full path.
   */
  isActive: (pathname: string) => boolean;
}

const SETTINGS_ITEMS: SettingsExplorerItem[] = [
  {
    id: "settings",
    label: "Settings",
    hint: "Edit instance settings",
    href: "/settings",
    // Active for the bare /settings only — not for /settings/<sub>.
    isActive: (path) => path === "/settings",
  },
  {
    id: "policies",
    label: "Policies",
    href: "/settings/policies",
    isActive: (path) => path.startsWith("/settings/policies"),
  },
  {
    id: "log",
    label: "Log",
    href: "/settings/log",
    isActive: (path) => path.startsWith("/settings/log"),
  },
];

const SYSTEM_ITEMS: SettingsExplorerItem[] = [
  {
    id: "health",
    label: "Health",
    hint: "Canonical findings",
    href: "/settings/health",
    isActive: (path) => path.startsWith("/settings/health"),
  },
  {
    id: "configuration",
    label: "Configuration",
    hint: "Read-only inventory",
    href: "/settings/configuration",
    isActive: (path) => path.startsWith("/settings/configuration"),
  },
  {
    id: "connections",
    label: "Connections",
    hint: "Slack gateway & people",
    href: "/settings/connections",
    isActive: (path) => path.startsWith("/settings/connections"),
  },
  {
    id: "status",
    label: "Status",
    hint: "Daemon process",
    href: "/settings/status",
    isActive: (path) => path.startsWith("/settings/status"),
  },
];

function ExplorerGroup({ heading, testId, items, pathname }: { heading: string; testId: string; items: SettingsExplorerItem[]; pathname: string }) {
  return (
    <>
      <div className="px-2 mb-2">
        <span
          data-testid={testId}
          className="block font-mono text-[11px] uppercase tracking-wide text-on-surface px-2 py-1"
        >
          {"> "}{heading}
        </span>
      </div>
      <ul className="px-2 space-y-0.5">
        {items.map((item) => {
          const active = item.isActive(pathname);
          return (
            <li key={item.id}>
              <Link
                to={item.href}
                data-testid={`settings-explorer-item-${item.id}`}
                data-active={active}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block font-mono text-[11px] uppercase tracking-wide px-2 py-1",
                  active
                    ? "bg-inverse-surface text-background"
                    : "text-on-surface hover:text-on-surface hover:bg-surface-low",
                )}
              >
                {item.label}
                {item.hint ? (
                  <span className={cn("block text-[9px] normal-case tracking-normal", active ? "text-background/80" : "text-on-surface-variant")}>
                    {item.hint}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// Operations on the connected instance (startup/restore cohort) and the
// rig-independent terminal catalog (works with zero rigs).
const OPERATIONS_ITEMS: SettingsExplorerItem[] = [
  {
    id: "startup",
    label: "Seat startup",
    hint: "Resume, start or continue one seat",
    href: "/settings/startup",
    isActive: (path) => path.startsWith("/settings/startup"),
  },
  {
    id: "restore",
    label: "Fleet restore",
    hint: "Restore every rig on this instance",
    href: "/settings/restore",
    isActive: (path) => path.startsWith("/settings/restore"),
  },
  {
    id: "terminals",
    label: "Terminal views",
    hint: "Saved & derived views · preview, Open",
    href: "/terminals",
    isActive: (path) => path === "/terminals",
  },
];

const HELP_ITEMS: SettingsExplorerItem[] = [
  {
    id: "help",
    label: "Help & actions",
    hint: "Every TUI command, here or by CLI",
    href: "/help",
    isActive: (path) => path === "/help",
  },
];

export function SettingsExplorer() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  return (
    <div data-testid="settings-explorer" className="flex-1 overflow-y-auto py-2">
      <ExplorerGroup heading="Settings" testId="settings-explorer-heading" items={SETTINGS_ITEMS} pathname={pathname} />
      <div className="mt-3">
        <ExplorerGroup heading="System · connected instance" testId="settings-explorer-system-heading" items={SYSTEM_ITEMS} pathname={pathname} />
      </div>
      <div className="mt-3">
        <ExplorerGroup heading="Operations" testId="settings-explorer-operations-heading" items={OPERATIONS_ITEMS} pathname={pathname} />
      </div>
      <div className="mt-3">
        <ExplorerGroup heading="Help" testId="settings-explorer-help-heading" items={HELP_ITEMS} pathname={pathname} />
      </div>
    </div>
  );
}
