// V1 attempt-3 Phase 3 — Topology scope pages per topology-tree.md.
//
// SC-10 LOAD-BEARING: view-mode tabs IN-PLACE — one PATHNAME per scope
// across tab switches (no /topology/host/3d route family). The active view,
// the 3D Scene/List choice, search and exact selection are URL search state
// (docs/plans/gui-spatial-navigation-contract.md), written by REPLACING the
// current entry, so Back from a drill returns to the same view/query/
// selection and same-route Back/Forward drives the controls.
//
// Every scope body (all target reads and local actions) mounts behind
// TopologySourceGate: the URL's sourceHost must equal a successfully read
// current selection. Legacy links bind once; nothing here writes the global
// host selection except an explicit operator action.

import { useEffect, useMemo, lazy, Suspense } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  TopologyViewModeTabs,
  topologyTabPanelProps,
  HOST_SCOPE_TABS,
  RIG_POD_SCOPE_TABS,
  SEAT_SCOPE_TABS,
  type TopologyHostScopeTab,
  type TopologyRigPodScopeTab,
  type TopologySeatScopeTab,
} from "./TopologyViewModeTabs.js";
import { TopologyTableView } from "./TopologyTableView.js";
import { ErrorBoundary } from "../ui/ErrorBoundary.js";
// OPR.0.4.6.2 (FR-5): the shipped rig-scope "Launch in CMUX" button generalizes
// to a provider + view picker (herdr primary, cmux best-effort). Same tab-bar
// trailing slot; LaunchCmuxButton.tsx stays (its graph/detail affordances are
// untouched), superseded HERE by TerminalLauncher.
import { TerminalLauncher } from "./TerminalLauncher.js";
import { TopologyTerminalView } from "./TopologyTerminalView.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { RigGraph } from "../RigGraph.js";
import { RigSpecDisplay } from "../RigSpecDisplay.js";
import { RigStatusControl } from "../RigStatusControl.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useHosts, useSelectHost, useHostSelection } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { useSpecLibrary, useLibraryReview, type LibraryRigReview } from "../../hooks/useSpecLibrary.js";
import { LiveNodeDetails } from "../LiveNodeDetails.js";
import { useTopologyOverlay } from "./topology-overlay-context.js";
// Below the 1024px shell breakpoint the Graph tab mounts the touch-first
// phone graph (PhoneTopologyGraph) instead of the desktop canvas. This
// supersedes universal-shell.md L143's "graph degrades to table on mobile":
// Graph and Table stay separate, explicit tabs at every width.
import { useShellViewport } from "../../hooks/useShellViewport.js";
import { PhoneTopologyGraph } from "./PhoneTopologyGraph.js";
import { useNodeInventory } from "../../hooks/useNodeInventory.js";
import { computeActivityRollup, formatRollupLabel } from "../../lib/activity-visuals.js";
import type { SpatialScope } from "../../lib/spatial-topology.js";
import type { TopologyScope } from "../../lib/topology-location.js";
import { RecentScopePanel, useTopologyRecentInstance } from "../recent-pulse/RecentView.js";
import { ScopedHealthPanel, ScopedHealthStrip, useHealthAdmission, type HealthDisplayScope } from "./ScopedHealth.js";
import {
  navigateTopology,
  topologyTarget,
  useKnownSelectedHost,
  TopologyLocationNotices,
  TopologySourceGate,
  useTopologyLocation,
  type TopologyNavigation,
} from "./topology-navigation.js";

// 3D view-mode: lazy so the spatial module (and, one level deeper, three.js)
// stays out of the initial payload and only mounts on the 3D tab.
const SpatialTopologyView = lazy(() => import("./spatial/SpatialTopologyView.js"));

function SpatialPanel({ scope }: { scope: SpatialScope }) {
  return (
    <ErrorBoundary label="3D view">
      <Suspense
        fallback={
          <div
            data-testid="topology-spatial-loading"
            role="status"
            className="px-6 py-10 font-mono text-[10px] text-on-surface-variant"
          >
            Loading 3D view…
          </div>
        }
      >
        <SpatialTopologyView scope={scope} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Graph canvas frame. In graph-overlay mode the Explorer floats over the
 *  left of <main>; --header-anchor-offset is the Explorer's right edge
 *  (21rem expanded, 3rem collapsed, 0 on narrow/opaque layouts), so the
 *  frame starts past it and React Flow measures — and fits to — only the
 *  visible canvas instead of drawing nodes underneath the Explorer. */
function GraphFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="topology-graph-frame"
      className="flex-1 min-h-0 relative"
      style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
    >
      {children}
    </div>
  );
}

/** The desktop canvas needs the wide shell and a pointer. A touch tablet
 *  (iPad landscape crosses 1024px) keeps the touch graph in both
 *  orientations; the shell breakpoint itself is unchanged. */
function useDesktopGraph(): boolean {
  const { isWideLayout, isTouchTablet } = useShellViewport();
  return isWideLayout && !isTouchTablet;
}

/** Touch graph frame: the phone graph sizes its own canvas, so this frame
 *  never stretches or shrinks with the page (shrink-0) and the page keeps
 *  scrolling around it. On a wide touch tablet it clears the Explorer
 *  overlay like the desktop frame (the offset is 0 below 1024px). */
function PhoneGraphFrame({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="topology-phone-graph-frame" className="shrink-0" style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}>
      <ErrorBoundary label="Graph view">{children}</ErrorBoundary>
    </div>
  );
}

function ActivityRollupBar({ rigId }: { rigId: string }) {
  const { data: nodes } = useNodeInventory(rigId);
  if (!nodes || nodes.length === 0) return null;
  const rollup = computeActivityRollup(
    nodes.map((n) => ({ activity: n.agentActivity, terminalActive: n.terminalActive })),
  );
  return (
    <div
      data-testid="activity-rollup-bar"
      className="px-6 py-2 font-mono text-[10px] text-on-surface-variant border-b border-outline-variant bg-surface-lowest/30"
      // Same anchoring as the tabs: legible past the Explorer overlay.
      style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
    >
      {formatRollupLabel(rollup)}
    </div>
  );
}
// V1 polish slice Phase 5.2: HostScopePage graph view-mode replaces
// the prior placeholder with the multi-rig single-canvas component
// (rig-collapse affordance; default-all-collapsed; auto-expand on URL).
import { HostMultiRigGraph } from "./HostMultiRigGraph.js";
// OPR.0.4.0.1: one global LiveTerminalProvider per scope page bounds the total
// live terminals across the page's graph + table + terminal tab-surfaces.
import { LiveTerminalProvider, useTerminalCap } from "../terminal/LiveTerminalProvider.js";

/** Set the AppShell's Explorer overlay mode based on the scope page's
 *  active view-mode. Graph view-mode → overlay (vellum-translucent
 *  Explorer over canvas); table/terminal → opaque. Resets to opaque
 *  when the component unmounts so non-topology destinations don't
 *  inherit overlay state. */
function useOverlayForActiveTab(active: string) {
  const { setMode } = useTopologyOverlay();
  useEffect(() => {
    setMode(active === "graph" ? "overlay" : "opaque");
    return () => {
      setMode("opaque");
    };
  }, [active, setMode]);
}

function ScopeShell({
  tabsNav,
  nav,
  panel,
  summary,
  children,
}: {
  /** Eyebrow + title are no longer rendered: tabs only, anchored to
   *  the right of Explorer. The scope
   *  identity reads from the URL + Explorer tree active state, so the
   *  big DISCOVERY.INTAKE-ROUTER style title in the canvas is redundant.
   *  Keeping the prop names for now in case Phase 5 wants to revive a
   *  smaller breadcrumb. */
  eyebrow?: string;
  title?: string;
  tabsNav: React.ReactNode;
  /** Discloses ignored (invalid optional) URL fields under the tabs. */
  nav?: TopologyNavigation;
  /** Names the active view-mode panel after its tab. */
  panel?: ReturnType<typeof topologyTabPanelProps>;
  /** Compact scope summary under the tabs (e.g. scoped Health). */
  summary?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Class B fixed-anchor: tabsNav sits at left = var(--explorer-anchor-left)
  // (set on <main> in AppShell) so position is identical across graph /
  // table / terminal switches. Transparent over the canvas — paper-grid
  // shows through. z-30 keeps tabs above the Explorer overlay in graph
  // mode (the tabs are anchored past the Explorer's right edge so they
  // shouldn't actually overlap, but z-order is the safety net).
  return (
    <div className="flex flex-col h-full">
      <div
        className="relative z-30 px-6 pt-4"
        style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
      >
        {tabsNav}
        {nav ? <TopologyLocationNotices nav={nav} className="pb-2" /> : null}
        {summary}
      </div>
      {/* flex column so the active view-mode panel can fill remaining
          height. min-h-0 lets the flex child shrink correctly inside
          the AppShell main scroll container. */}
      <div className="flex-1 min-h-0 flex flex-col" {...panel}>
        {children}
      </div>
    </div>
  );
}

const HOST_SPATIAL_SCOPE: SpatialScope = { kind: "host" };

// V1 attempt-3 Phase 5 P5-7: TopologyTerminalView replaces the placeholder
// with a real safe-N=12 paginated pinned-card grid + pulsing-ring on active
// terminals (per topology-terminal-view.md L47/L60-65/L70-80).

const HOST_SCOPE: TopologyScope = { kind: "host" };

export function HostScopePage() {
  const nav = useTopologyLocation(HOST_SCOPE);
  return (
    <TopologySourceGate nav={nav}>
      <HostScopeContent nav={nav} />
    </TopologySourceGate>
  );
}

const HOST_HEALTH_SCOPE: HealthDisplayScope = { kind: "host" };

function HostScopeContent({ nav }: { nav: TopologyNavigation }) {
  const health = useScopeHealth(nav, HOST_HEALTH_SCOPE);
  const router = useRouter();
  const active = nav.location.view as TopologyHostScopeTab;
  const setActive = (view: TopologyHostScopeTab) => nav.replace({ view });
  const { data: rigs, error: rigsError, isFetching, isPlaceholderData, refetch } = useRigSummary();
  // Recent describes the connected instance only: null while the selection
  // resolves, unsupported (no read, no local rows) for a remote selection.
  const recentInstance = useTopologyRecentInstance();
  const desktopGraph = useDesktopGraph();
  useOverlayForActiveTab(active);

  // OPR.0.4.6.MH2 FR-3/FR-6 — the page title names the ACTUAL data source
  // (the hardcoded "localhost" is gone): local renders the MH-1 own-name,
  // a remote selection renders its host id. Remote read states are honest:
  // a failed read replaces the canvas with the host-named unreachable
  // panel (retry + back-to-local, per the locked fr6-unreachable twin);
  // an in-flight pull shows a truthful banner over the previous view
  // (keepPreviousData, per fr6-loading). Local never gains either.
  const { data: hostsData } = useHosts();
  const selectHost = useSelectHost();
  const selectedHost = hostsData?.selected ?? LOCAL_HOST_ID;
  const isRemote = selectedHost !== LOCAL_HOST_ID;
  const ownName = hostsData?.ownName && hostsData.ownName.trim() !== "" ? hostsData.ownName : "localhost";

  const liveCap = useTerminalCap();

  const remoteUnreachable = isRemote && !!rigsError;
  const remoteLoading = isRemote && !remoteUnreachable && (isPlaceholderData || (isFetching && rigs === undefined));

  return (
    <LiveTerminalProvider cap={liveCap}>
    <ScopeShell
      eyebrow="Topology · Host"
      title={isRemote ? selectedHost : ownName}
      nav={nav}
      summary={health.strip}
      panel={topologyTabPanelProps("topology-host", active)}
      tabsNav={<TopologyViewModeTabs tabs={HOST_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-host" />}
    >
      {remoteUnreachable ? (
        <div
          className="px-6 py-6"
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="topology-remote-unreachable"
            className="max-w-2xl border-l-2 border-error bg-surface-low px-4 py-4 font-mono text-xs"
          >
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-error">
              {selectedHost} is unreachable
            </div>
            <p className="mb-1 text-on-surface">
              The local daemon could not reach {selectedHost}&apos;s daemon. Its workspace can&apos;t be shown.
            </p>
            <p className="mb-3 text-[10px] text-on-surface-variant">
              Check the host is up and paired (rig host ls), then retry. Other hosts are unaffected.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="topology-remote-retry"
                onClick={() => void refetch()}
                className="border border-outline px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-on-surface hover:bg-surface-low/60"
              >
                Retry
              </button>
              <button
                type="button"
                data-testid="topology-remote-back-local"
                onClick={() =>
                  // Explicit operator choice: select local, then show local's
                  // host scope (this page asserts the unreachable host).
                  selectHost.mutate({ hostId: LOCAL_HOST_ID }, {
                    onSuccess: () => {
                      const target = topologyTarget({ scope: HOST_SCOPE, sourceHost: LOCAL_HOST_ID, view: active });
                      if (target) navigateTopology(router, null, target);
                    },
                  })
                }
                className="border border-outline-variant px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-on-surface-variant hover:text-on-surface"
              >
                Back to {ownName} (local)
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {remoteLoading ? (
        <div
          data-testid="topology-remote-loading"
          className="mr-6 mt-3 border border-outline-variant bg-surface-low px-3 py-2 font-mono text-[10px] text-on-surface-variant"
          style={{ marginLeft: "calc(var(--header-anchor-offset, 0px) + 1.5rem)" }}
        >
          Pulling {selectedHost}&apos;s workspace over the network… showing the previous view until it arrives.
        </div>
      ) : null}
      {!remoteUnreachable && active === "graph" ? (
        desktopGraph ? (
          <GraphFrame>
            <HostMultiRigGraph />
          </GraphFrame>
        ) : (
          <PhoneGraphFrame>
            <PhoneTopologyGraph nav={nav} />
          </PhoneGraphFrame>
        )
      ) : null}
      {!remoteUnreachable && active === "spatial" ? <SpatialPanel scope={HOST_SPATIAL_SCOPE} /> : null}
      {active === "table" ? (
        <div className="px-6 pb-6">
          {/* OPR.0.4.1.13: contain a table render-throw so it can't white-screen the page. */}
          <ErrorBoundary label="Table view">
            <TopologyTableView />
          </ErrorBoundary>
        </div>
      ) : null}
      {active === "terminal" ? <TopologyTerminalView scope="host" /> : null}
      {health.view}
      <RecentPanelFrame>
        <RecentScopePanel instance={recentInstance} filter={{ kind: "instance" }} />
      </RecentPanelFrame>
    </ScopeShell>
    </LiveTerminalProvider>
  );
}

export function RigScopePage() {
  // Router-decoded (raw) param, used verbatim: never decoded again.
  const { rigId } = useParams({ from: "/topology/rig/$rigId" });
  const nav = useTopologyLocation({ kind: "rig", rigId });
  return (
    <TopologySourceGate nav={nav}>
      <RigScopeContent nav={nav} rigId={rigId} />
    </TopologySourceGate>
  );
}

function RigScopeContent({ nav, rigId }: { nav: TopologyNavigation; rigId: string }) {
  const health = useScopeHealth(nav, useMemoHealthScope("rig", rigId));
  // OPR.0.4.6.MH2 guard delta-confirm blocker: lifecycle/action surfaces are
  // TRI-STATE — unknown selection mounts NO local controls and fires NO bare
  // status read (useSelectedHostId defaults local pre-cache, which fails
  // OPEN for a surface whose mount fires a read). ACTIVE observer: the page
  // learns the selection itself.
  const { known: hostSelectionKnown, isLocal: hostSelectionLocal } = useHostSelection();
  const rigScopeIsRemote = hostSelectionKnown && !hostSelectionLocal;
  const rigScopeActionsAllowed = hostSelectionKnown && hostSelectionLocal;
  const { data: rigs, isError: rigsFailed } = useRigSummary();
  const rig = rigs?.find((r) => r.id === rigId);
  const recentInstance = useTopologyRecentInstance();
  // Recent filters by exact rig NAME, taken only from the served summary row
  // whose id is exactly this route's rig; never the id or a guessed name.
  // A failed CURRENT summary read cannot certify a name, including a name
  // retained from an earlier successful read of the same key.
  const recentFilter = rigsFailed
    ? "unavailable" as const
    : rigs === undefined
      ? "pending" as const
    : rig && typeof rig.name === "string" && rig.name.length > 0 ? { kind: "rig" as const, rig: rig.name } : "unavailable" as const;
  const active = nav.location.view as TopologyRigPodScopeTab;
  const setActive = (view: TopologyRigPodScopeTab) => nav.replace({ view });
  const desktopGraph = useDesktopGraph();
  useOverlayForActiveTab(active);

  const liveCap = useTerminalCap();

  return (
    <LiveTerminalProvider cap={liveCap}>
    <ScopeShell
      eyebrow="Topology · Rig"
      title={rig?.name ?? rigId}
      nav={nav}
      summary={health.strip}
      panel={topologyTabPanelProps("topology-rig", active)}
      tabsNav={
        <TopologyViewModeTabs
          tabs={RIG_POD_SCOPE_TABS}
          active={active}
          onSelect={setActive}
          testIdPrefix="topology-rig"
          // OPR.0.4.6.MH2 rev1-r2 B1 — Launch-in-CMUX is a LOCAL action
          // (bare local open-cmux POST); no cross-host mutation affordance
          // on remote views (FR-7).
          trailing={rigScopeActionsAllowed ? <TerminalLauncher rigId={rigId} rigName={rig?.name ?? null} /> : null}
        />
      }
    >
      {/* OPR.0.4.3.22 — rig-status + launch/recovery control near the rig title.
          Terminal-surface actions (Launch in CMUX) render SEPARATELY in the tab
          bar (trailing, above) and never restore or fresh-prime.
          OPR.0.4.6.MH2 rev1-r2 re-verdict B1: the whole control is a LOCAL
          restore/launch surface (bare /api/rigs/:id/status read + launch-plan
          + /up POSTs) — under a remote selection it never mounts; an honest
          read-only marker stands in (FR-7). */}
      {!hostSelectionKnown ? (
        <div
          className="px-6 pt-4 max-w-md"
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="rig-status-selection-pending"
            className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant italic"
          >
            resolving selected host…
          </div>
        </div>
      ) : rigScopeIsRemote ? (
        <div
          className="px-6 pt-4 max-w-md"
          // the same anchoring discipline as the FR-6 surfaces: legible past
          // the explorer overlay in graph-overlay mode; 0px fallback keeps
          // non-overlay modes unchanged.
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="rig-status-remote-readonly"
            data-remote-readonly="true"
            className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant"
          >
            read-only — remote host (launch/recovery is a local action)
          </div>
        </div>
      ) : (
        // OPR.0.4.7.1 — compact control, RIGHT-aligned: the explorer overlay
        // anchors left, so right alignment keeps the launch control fully
        // visible in graph-overlay mode (the reproduced obscured-card bug).
        <div className="px-6 pt-4 flex justify-end">
          <ErrorBoundary label="Rig status">
            <RigStatusControl rigId={rigId} rigName={rig?.name ?? rigId} />
          </ErrorBoundary>
        </div>
      )}
      <ActivityRollupBar rigId={rigId} />
      {active === "graph" ? (
        desktopGraph ? (
          <GraphFrame>
            <RigGraph rigId={rigId} rigName={rig?.name ?? null} showDiscovered={false} />
          </GraphFrame>
        ) : (
          <PhoneGraphFrame>
            <PhoneTopologyGraph nav={nav} />
          </PhoneGraphFrame>
        )
      ) : null}
      {active === "spatial" ? <SpatialPanel scope={{ kind: "rig", rigId }} /> : null}
      {active === "table" ? (
        <div className="px-6 pb-6">
          {/* OPR.0.4.1.13: contain a table render-throw so it can't white-screen the page. */}
          <ErrorBoundary label="Table view">
            <TopologyTableView rigIdScope={rigId} />
          </ErrorBoundary>
        </div>
      ) : null}
      {active === "terminal" ? <TopologyTerminalView scope="rig" rigId={rigId} /> : null}
      {health.view}
      {active === "overview" ? <RigOverviewTab rigId={rigId} rigName={rig?.name ?? null} /> : null}
      <RecentPanelFrame>
        <RecentScopePanel instance={recentInstance} filter={recentFilter} />
      </RecentPanelFrame>
    </ScopeShell>
    </LiveTerminalProvider>
  );
}

/** V1 polish slice Phase 5.1 P5.1-6 — Rig overview tab.
 *
 *  Mounts the existing canonical RigSpecDisplay component (from
 *  /specs/rig/$id) sourced via useSpecLibrary("rig") + useLibraryReview.
 *  Matches the rig name against the library entries (per
 *  LibraryReview.tsx pattern) and renders the spec detail.
 */
function RigOverviewTab({ rigId, rigName }: { rigId: string; rigName: string | null }) {
  const { data: entries = [], isLoading: entriesLoading } = useSpecLibrary("rig");
  // Match by rig name when available; some rigs may have one library
  // entry per name (operator-authored rig spec).
  const matches = rigName ? entries.filter((e) => e.name === rigName) : [];
  const entryId = matches.length === 1 ? matches[0]!.id : null;
  const { data: review, isLoading: reviewLoading } = useLibraryReview(entryId);

  if (entriesLoading || reviewLoading) {
    return (
      <div className="p-6">
        <div className="font-mono text-[10px] text-on-surface-variant">Loading rig spec…</div>
      </div>
    );
  }
  if (matches.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          label="NO RIG SPEC"
          description={`No rig spec entry found for "${rigName ?? rigId}". Author one via /specs.`}
          variant="card"
          testId="topology-rig-overview-no-spec"
        />
      </div>
    );
  }
  if (matches.length > 1) {
    return (
      <div className="p-6">
        <EmptyState
          label="AMBIGUOUS RIG SPEC"
          description={`${matches.length} rig spec entries match "${rigName ?? rigId}". Disambiguate at /specs.`}
          variant="card"
        />
      </div>
    );
  }
  if (!review || review.kind !== "rig") {
    return (
      <div className="p-6">
        <EmptyState
          label="RIG SPEC UNAVAILABLE"
          description="Rig spec failed to load."
          variant="card"
        />
      </div>
    );
  }
  const rigReview = review as LibraryRigReview;
  return (
    <div className="px-6 pb-6" data-testid="topology-rig-overview">
      <RigSpecDisplay
        review={rigReview}
        yaml={rigReview.raw}
        testIdPrefix="topology-rig-overview-"
      />
    </div>
  );
}

export function PodScopePage() {
  // V1 polish slice Phase 5.1 P5.1-5: pod-scope graph wires through
  // RigGraph's new podScope prop (filters nodes + edges + pod groups
  // to the matching pod only). Default tab moved to "graph" so the
  // graph view-mode is the landing surface (matches host/rig scope
  // pattern; pod scope should honor the same graph/table/terminal
  // grammar as other scopes.
  const { rigId, podName } = useParams({ from: "/topology/pod/$rigId/$podName" });
  const nav = useTopologyLocation({ kind: "pod", rigId, podName });
  return (
    <TopologySourceGate nav={nav}>
      <PodScopeContent nav={nav} rigId={rigId} podName={podName} />
    </TopologySourceGate>
  );
}

function PodScopeContent({ nav, rigId, podName }: { nav: TopologyNavigation; rigId: string; podName: string }) {
  const health = useScopeHealth(nav, useMemoHealthScope("pod", rigId, podName));
  const active = nav.location.view as TopologyRigPodScopeTab;
  const setActive = (view: TopologyRigPodScopeTab) => nav.replace({ view });
  const desktopGraph = useDesktopGraph();
  useOverlayForActiveTab(active);

  return (
    <ScopeShell
      eyebrow="Topology · Pod"
      title={`${rigId} / ${podName}`}
      nav={nav}
      summary={health.strip}
      panel={topologyTabPanelProps("topology-pod", active)}
      tabsNav={<TopologyViewModeTabs tabs={RIG_POD_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-pod" />}
    >
      {active === "graph" ? (
        desktopGraph ? (
          <GraphFrame>
            <RigGraph rigId={rigId} rigName={null} showDiscovered={false} podScope={podName} />
          </GraphFrame>
        ) : (
          <PhoneGraphFrame>
            <PhoneTopologyGraph nav={nav} />
          </PhoneGraphFrame>
        )
      ) : null}
      {active === "spatial" ? <SpatialPanel scope={{ kind: "pod", rigId, podName }} /> : null}
      {active === "table" ? (
        <div className="px-6 pb-6">
          {/* OPR.0.4.1.13: contain a table render-throw so it can't white-screen the page. */}
          <ErrorBoundary label="Table view">
            <TopologyTableView rigIdScope={rigId} podNameScope={podName} />
          </ErrorBoundary>
        </div>
      ) : null}
      {health.view}
      {active === "terminal" ? (
        <TopologyTerminalView scope="pod" rigId={rigId} podName={podName} />
      ) : null}
      {active === "overview" ? (
        <div className="p-6">
          <EmptyState label="POD OVERVIEW" description="Pod detail (Phase 5)." variant="card" />
        </div>
      ) : null}
    </ScopeShell>
  );
}

export function SeatScopePage() {
  // V1 polish slice Phase 5.1 P5.1-1 + DRIFT P5.1-D1: outer scope tabs
  // (detail / transcript / terminal) RETIRED at V1 polish.
  // LiveNodeDetails owns the canonical 5-tab body row inline
  // (Identity / Agent Spec / Startup / Transcript / Terminal). The
  // ScopeShell wrapper is dropped too — LiveNodeDetails is the page.
  //
  // Params are RAW (router-decoded exactly once): every producer passes the
  // exact logical id through the shared link builder, so decoding here again
  // would turn a literal "%2F" into "/" and open a different seat. The source
  // gate keeps LiveNodeDetails (its reads, preview and local actions) from
  // resolving this rig/logical id on a host the link was not made for.
  const { rigId, logicalId } = useParams({ from: "/topology/seat/$rigId/$logicalId" });
  const nav = useTopologyLocation({ kind: "seat", rigId, logicalId });
  return (
    <div data-testid="seat-scope-page" className="flex flex-col h-full">
      <TopologySourceGate nav={nav}>
        <SeatScopeContent nav={nav} rigId={rigId} logicalId={logicalId} />
      </TopologySourceGate>
    </div>
  );
}

/** Seat Overview/Details is URL state (`view`, default overview) like the
 *  other scopes' view tabs: choosing a tab REPLACES the current entry, so Back
 *  leaves the seat (to where it was opened from) and every seat entry restores
 *  its own tab; another seat (a pushed entry) starts at its own URL's view. */
function SeatScopeContent({ nav, rigId, logicalId }: { nav: TopologyNavigation; rigId: string; logicalId: string }) {
  // Mounted only behind the source gate, so this is the admitted source.
  const sourceHost = useKnownSelectedHost() ?? undefined;
  const view = nav.location.view === "details" ? "details" : "overview";
  return (
    <LiveNodeDetails
      rigId={rigId}
      logicalId={logicalId}
      activeTab={view}
      onTabChange={(next) => nav.replace({ view: next })}
      sourceHost={sourceHost}
    />
  );
}

/** Recent sits under the active view, anchored past the Explorer overlay and
 *  bounded so canvas views (graph/3D) keep most of the page height. */
function RecentPanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="topology-recent-frame"
      className="shrink-0 max-h-[40vh] overflow-auto"
      style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
    >
      {children}
    </div>
  );
}

/** Health summary strip (hidden while the Health view itself is open) and the
 *  in-place Health view body for host/rig/pod scopes. One shared bounded
 *  connected-instance read; the source admission is the gated page's current
 *  source, so remote/unknown sources read nothing and show nothing local. */
function useScopeHealth(nav: TopologyNavigation, scope: HealthDisplayScope) {
  const admission = useHealthAdmission(nav.location.sourceHost);
  const strip = nav.location.view === "health"
    ? null
    : <ScopedHealthStrip scope={scope} admission={admission} onOpen={() => nav.replace({ view: "health" })} />;
  const view = nav.location.view === "health"
    ? (
      <div data-testid="topology-health-view" className="px-6 pb-6 pt-2">
        <ScopedHealthPanel scope={scope} admission={admission} from={nav.scope} />
      </div>
    )
    : null;
  return { strip, view };
}

function useMemoHealthScope(kind: "rig" | "pod", rigId: string, podName = ""): HealthDisplayScope {
  return useMemo<HealthDisplayScope>(
    () => (kind === "rig" ? { kind: "rig", rigId } : { kind: "pod", rigId, podName }),
    [kind, rigId, podName],
  );
}
