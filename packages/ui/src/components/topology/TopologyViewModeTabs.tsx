// V1 attempt-3 Phase 3 — Topology view-mode tabs per topology-tree.md L46–L60 + SC-5 + SC-10.
//
// **LOAD-BEARING SC-10:** view-mode tabs at top of center for SINGLE URL.
// Tabs switch IN-PLACE — NOT separate routes. (Attempt-2 violated this
// by using `/topology/host/table` etc; the canon explicitly forbids that.)
//
// The active tab is URL search state owned by the scope page (`view=`, see
// topology-navigation.tsx); the PATHNAME stays at the scope path
// (/topology, /topology/rig/$rigId, etc). Keyboard: roving tabindex with
// Left/Right/Home/End moving and activating tabs; the active panel is named
// by its tab (aria-controls / aria-labelledby via topologyTabPanelProps).

import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

// "spatial" is the 3D view-mode (label "3D"). It stays an in-place tab like
// the others — never a route segment (SC-10).
export type TopologyHostScopeTab = "graph" | "spatial" | "table" | "terminal" | "health";
export type TopologyRigPodScopeTab = "graph" | "spatial" | "table" | "terminal" | "health" | "overview";
export type TopologySeatScopeTab = "detail" | "transcript" | "terminal";
export type AnyTopologyTab =
  | TopologyHostScopeTab
  | TopologyRigPodScopeTab
  | TopologySeatScopeTab;

interface TopologyViewModeTabsProps<T extends string> {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
  testIdPrefix?: string;
  /**
   * Slice 24 — optional trailing slot rendered with ml-auto inside the
   * tab-bar flex container. Used by RigScopePage to render the
   * "Launch in CMUX" button at the tab-bar far right per README §Button
   * placement Option C (persistent across all rig-scope view-mode tabs).
   */
  trailing?: ReactNode;
}

export function topologyTabId(testIdPrefix: string, id: string): string {
  return `${testIdPrefix}-tab-${id}`;
}

/** Props for the element that holds the active view-mode panel. */
export function topologyTabPanelProps(testIdPrefix: string, active: string) {
  return {
    id: `${testIdPrefix}-panel`,
    role: "tabpanel" as const,
    "aria-labelledby": topologyTabId(testIdPrefix, active),
  };
}

export function TopologyViewModeTabs<T extends string>({
  tabs,
  active,
  onSelect,
  testIdPrefix = "topology-view-mode",
  trailing,
}: TopologyViewModeTabsProps<T>) {
  // Slice 24.D repair (velocity-guard secondary concern):
  // keep tablist children scoped to tabs only — outer flex wrapper
  // hosts both the tablist AND the trailing slot as siblings.
  // Internal tablist — div, not <nav>, so SC-1 left-chrome count
  // (querySelectorAll("nav, aside")) stays at exactly 2. No wrapper
  // line border — only the active tab carries an underline; the rest
  // of the tablist breathes over the canvas.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === active);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === null || !tabs[next]) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    onSelect(id);
    Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role='tab']"))
      .find((tab) => tab.getAttribute("data-tab-id") === id)
      ?.focus();
  };
  const tablist = (
    <div
      role="tablist"
      aria-label="Topology view modes"
      data-testid={`${testIdPrefix}-tabs`}
      onKeyDown={onKeyDown}
      className="flex gap-6 items-center"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={topologyTabId(testIdPrefix, t.id)}
          aria-selected={active === t.id}
          aria-controls={`${testIdPrefix}-panel`}
          tabIndex={active === t.id ? 0 : -1}
          data-tab-id={t.id}
          data-testid={`${testIdPrefix}-tab-${t.id}`}
          data-active={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "py-3 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-surface",
            active === t.id
              ? "border-on-surface text-on-surface"
              : "border-transparent text-on-surface-variant hover:text-on-surface",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  if (!trailing) return tablist;

  return (
    <div
      data-testid={`${testIdPrefix}-tab-bar`}
      className="flex items-center"
    >
      {tablist}
      <div data-testid={`${testIdPrefix}-trailing`} className="ml-auto">
        {trailing}
      </div>
    </div>
  );
}

export const HOST_SCOPE_TABS: { id: TopologyHostScopeTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "spatial", label: "3D" },
  { id: "table", label: "Table" },
  { id: "terminal", label: "Terminal" },
  { id: "health", label: "Health" },
];

export const RIG_POD_SCOPE_TABS: { id: TopologyRigPodScopeTab; label: string }[] = [
  { id: "graph", label: "Graph" },
  { id: "spatial", label: "3D" },
  { id: "table", label: "Table" },
  { id: "terminal", label: "Terminal" },
  { id: "health", label: "Health" },
  { id: "overview", label: "Overview" },
];

export const SEAT_SCOPE_TABS: { id: TopologySeatScopeTab; label: string }[] = [
  { id: "detail", label: "Detail" },
  { id: "transcript", label: "Transcript" },
  { id: "terminal", label: "Terminal" },
];
