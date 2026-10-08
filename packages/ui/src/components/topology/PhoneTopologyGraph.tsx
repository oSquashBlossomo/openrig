// Phone / narrow-tablet 2D topology graph (below the 1024px shell breakpoint).
//
// Replaces the old "graph degrades to table on narrow viewports" fallback with
// an interactive graph designed for touch (owner requirement, PR14):
//   - Progressive hierarchy: rig tiles → pods → seat chips, with per-rig and
//     per-pod collapse so a dense fleet stays legible without hiding any rig
//     (unreadable, loading and beyond-the-bound rigs keep their own tiles).
//   - Drag with one finger scrolls the graph vertically (horizontal drift is
//     locked while the graph fits the width, bounded once zoomed in), pinch
//     to zoom, explicit 44px Fit / − / + controls
//     in a reserved header row (and the selection peek in a reserved footer),
//     never overlaid on the drawable surface where they could cover nodes.
//     The canvas has a bounded height and wheel/trackpad input is left to the
//     page, so the page around it always scrolls; native page zoom is
//     untouched outside the canvas.
//   - Tablet page flow (both sides >= 600px: iPad portrait and, via the
//     touch-tablet check in ScopePages, landscape past 1024px): the graph is
//     drawn full width at a readable zoom and the canvas is as tall as the
//     graph, so ordinary page scrolling reaches every rig and the panels
//     below. The canvas takes no drag or pinch (no nested pan area; native
//     page pinch-zoom works); − / + / Reset step a page zoom between a
//     legible floor and the full width, and the controls stay sticky.
//   - A seat tap (canvas chip, seat row or the details action) selects the
//     seat and opens its terminal over the graph: the 3D workspace's guarded
//     SeatLiveTerminal dock, unchanged (fresh exact-identity read, pinned
//     pane, fail-closed refresh, reconnect revalidation, shared cap). Opening
//     sends nothing and launches nothing; a stopped, remote or unverifiable
//     seat shows that dock's refusal. Only the tap opens it: a URL selection
//     arriving any other way (Back/Forward, reload, 3D) never does. A rig or
//     pod tap only selects; opening one is an explicit details action.
//   - Seat selection is the shared URL selection (selectedRig/selectedNode,
//     the same exact served node identity the 3D view uses), so it survives
//     rotation, Back/Forward, a Graph⇄3D switch and the 1024px crossing.
//     Rig/pod focus and pod collapse are local to this mounted graph; rig
//     collapse is the provider-wide choice the desktop graph shares.
// Reads are the spatial model's (same query keys as the desktop graph and
// 3D view); this component never writes the host selection or any daemon
// state, and drills carry the exact source host through topologyTarget.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Crosshair, Maximize, Minus, Plus, SquareTerminal, X } from "lucide-react";
import { useSpatialTopology } from "../../hooks/useSpatialTopology.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { useShellViewport } from "../../hooks/useShellViewport.js";
import {
  MAX_SPATIAL_RIGS,
  deriveSeatStatus,
  spatialKey,
  type SpatialAgent,
  type SpatialModel,
  type SpatialScope,
  type SpatialSeatStatus,
} from "../../lib/spatial-topology.js";
import {
  centerPhoneViewport,
  defaultPhoneCollapsedPodKeys,
  boundPhoneViewport,
  defaultPhoneExpandedRigIds,
  emptyTally,
  layoutPhoneGraph,
  pagePhoneViewport,
  phoneGraphColumns,
  phoneTranslateExtent,
  readablePhoneViewport,
  type PhoneExtent,
  tallyTones,
  type PhoneEdge,
  type PhoneNode,
  type PhonePodNodeData,
  type PhoneRigEntry,
  type PhoneRigNodeData,
  type PhoneSeatNodeData,
} from "../../lib/phone-graph-layout.js";
import { getEdgeStyle } from "../../lib/edge-styles.js";
import { formatRuntimeModel } from "../../lib/runtime-brand.js";
import { topologySelectionMatches, type TopologyScope } from "../../lib/topology-location.js";
import { cn } from "../../lib/utils.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { GraphPartialNotice } from "./GraphPartialNotice.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../ui/dialog.js";
import { SeatLiveTerminal, useSeatDetailQuery } from "./spatial/SpatialAgentWorkspace.js";
// The guarded dock's frame/button styles (class-scoped; no three.js).
import "./spatial/spatial.css";
import { useTopologyOverlay } from "./topology-overlay-context.js";
import {
  TopologyLink,
  topologyTarget,
  useKnownSelectedHost,
  type TopologyNavigation,
} from "./topology-navigation.js";
import {
  PHONE_TONE_LABEL,
  PhonePodNode,
  PhoneRigNode,
  PhoneSeatNode,
  PhoneTruncatedNode,
  TallyRow,
  ToneDot,
} from "./PhoneGraphNodes.js";

const nodeTypes: NodeTypes = {
  phoneRig: PhoneRigNode,
  phonePod: PhonePodNode,
  phoneSeat: PhoneSeatNode,
  phoneTruncated: PhoneTruncatedNode,
};
const edgeTypes: EdgeTypes = {};

const PHONE_MIN_ZOOM = 0.15;
const PHONE_MAX_ZOOM = 2;
const HIGHLIGHT_STROKE = "hsl(var(--primary))";

type Focus = { kind: "rig"; rigId: string } | { kind: "pod"; podKey: string } | { kind: "truncated" };

type SelectionIssue = "pending" | "unreadable" | "absent" | "not-loaded" | "not-in-inventory";

function toSpatialScope(scope: TopologyScope): SpatialScope {
  if (scope.kind === "rig") return { kind: "rig", rigId: scope.rigId };
  if (scope.kind === "pod") return { kind: "pod", rigId: scope.rigId, podName: scope.podName };
  return { kind: "host" };
}

const ACTION = "inline-flex min-h-11 items-center justify-center gap-1.5 border px-3 font-mono text-[11px] uppercase tracking-[0.06em]";
const ACTION_PRIMARY = cn(ACTION, "border-on-surface bg-on-surface text-background");
const ACTION_SECONDARY = cn(ACTION, "border-outline-variant bg-background text-on-surface hover:bg-surface-low/70 disabled:opacity-40");
const ACTION_DISABLED = cn(ACTION, "border-outline-variant/60 text-on-surface-variant/70 cursor-not-allowed");

export function PhoneTopologyGraph({ nav }: { nav: TopologyNavigation }) {
  return (
    <ReactFlowProvider>
      <PhoneTopologyGraphBody nav={nav} />
    </ReactFlowProvider>
  );
}

function PhoneTopologyGraphBody({ nav }: { nav: TopologyNavigation }) {
  const scope = nav.scope;
  const scopeKind = scope.kind === "seat" ? "host" : scope.kind;
  // nav.scope is stable per scope key (useTopologyLocation).
  const spatialScope = useMemo(() => toSpatialScope(scope), [scope]);
  const data = useSpatialTopology(spatialScope);
  const summary = useRigSummary();
  const knownHost = useKnownSelectedHost();
  const linkSource = nav.location.sourceHost ?? knownHost;
  const reducedMotion = usePrefersReducedMotion();
  const { isTablet: pageFlow } = useShellViewport();
  const flow = useReactFlow();
  const { expandedRigs, setRigExpanded } = useTopologyOverlay();
  const model = data.model;
  const hostId = data.hostId;

  // ---- Rig entries in served summary order (ready / unreadable / loading).
  const entries = useMemo<PhoneRigEntry[]>(() => {
    if (!model) return [];
    const ready = new Map(model.rigs.map((r) => [r.rigId, r]));
    const errors = new Map(data.rigErrors.map((e) => [e.rigId, e]));
    const toEntry = (rigId: string, rigName: string): PhoneRigEntry => {
      const rig = ready.get(rigId);
      if (rig) return { kind: "ready", rig };
      const err = errors.get(rigId);
      if (err) return { kind: "error", rigId, rigName: err.rigName, message: err.message };
      return { kind: "loading", rigId, rigName };
    };
    if (scope.kind !== "host") {
      const rigId = scope.kind === "rig" || scope.kind === "pod" ? scope.rigId : "";
      const entry = toEntry(rigId, model.rigs[0]?.rigName ?? rigId);
      // Pod scope with no such pod: nothing to draw (disclosed separately).
      return data.podMissing ? [] : [entry];
    }
    const rows = Array.isArray(summary.data) ? summary.data.filter((r) => typeof r.id === "string" && r.id.length > 0) : [];
    if (rows.length === 0) return model.rigs.map((rig) => ({ kind: "ready", rig }) as PhoneRigEntry);
    return rows.slice(0, MAX_SPATIAL_RIGS).map((r) => toEntry(r.id, r.name ?? r.id));
  }, [model, data.rigErrors, data.podMissing, scope, summary.data]);

  const statusByKey = useMemo(() => {
    const map = new Map<string, SpatialSeatStatus>();
    if (model) for (const agent of model.agentsByKey.values()) map.set(agent.key, deriveSeatStatus(agent));
    return map;
  }, [model]);

  // ---- Selection: URL seat selection (exact) or local rig/pod focus.
  const urlSelection = nav.location.selection ?? null;
  const [focus, setFocus] = useState<Focus | null>(null);
  const urlSelectionKey = urlSelection ? `${urlSelection.rigId}\u0000${urlSelection.nodeId}` : null;
  useEffect(() => {
    // A seat selection arriving from anywhere (tap, Back/Forward, 3D) wins.
    if (urlSelectionKey) setFocus(null);
  }, [urlSelectionKey]);

  const selectedAgent = useMemo<SpatialAgent | null>(() => {
    if (!urlSelection || !model) return null;
    const agent = model.agentsByKey.get(spatialKey(hostId, urlSelection.rigId, "agent", urlSelection.nodeId)) ?? null;
    return agent && topologySelectionMatches(scope, hostId, urlSelection, agent) ? agent : null;
  }, [urlSelection, model, hostId, scope]);

  const selectionIssue = useMemo<SelectionIssue | null>(() => {
    if (!urlSelection || selectedAgent) return null;
    if (data.status === "loading") return "pending";
    if (data.status === "error") return "unreadable";
    if (data.rigErrors.some((e) => e.rigId === urlSelection.rigId)) return "unreadable";
    if (data.loadingRigIds.includes(urlSelection.rigId)) return "pending";
    if (model?.rigs.some((r) => r.rigId === urlSelection.rigId)) return "absent";
    if (scope.kind === "host" && data.truncatedRigCount > 0) return "not-loaded";
    return "not-in-inventory";
  }, [urlSelection, selectedAgent, data.status, data.rigErrors, data.loadingRigIds, data.truncatedRigCount, model, scope.kind]);

  // ---- Progressive expansion.
  const expandedRigIds = useMemo(
    () => defaultPhoneExpandedRigIds(entries, expandedRigs, selectedAgent?.rigId ?? null),
    [entries, expandedRigs, selectedAgent?.rigId],
  );
  const [podOverrides, setPodOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const collapsedPodKeys = useMemo(() => {
    const rigs = entries.flatMap((e) => (e.kind === "ready" ? [e.rig] : []));
    const out = defaultPhoneCollapsedPodKeys(rigs, selectedAgent?.podKey ?? null);
    for (const [key, collapsed] of podOverrides) {
      if (collapsed) out.add(key);
      else out.delete(key);
    }
    return out;
  }, [entries, podOverrides, selectedAgent?.podKey]);
  const setPodCollapsed = useCallback((podKey: string, collapsed: boolean) => {
    setPodOverrides((prev) => {
      if (prev.get(podKey) === collapsed) return prev;
      const next = new Map(prev);
      next.set(podKey, collapsed);
      return next;
    });
  }, []);

  // ---- Drawable surface size (columns + viewport decisions). This is the
  // area React Flow draws nodes in — the canvas minus its reserved control
  // header and peek footer — so fit/readable/centre never place nodes under
  // the controls. Callback ref: it mounts only once a read has settled.
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = surfaceEl;
    if (!el) return;
    const read = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [surfaceEl]);
  const fallbackWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const columns = phoneGraphColumns(size.width || fallbackWidth);

  const layout = useMemo(
    () => layoutPhoneGraph({
      entries,
      truncatedRigCount: scope.kind === "host" ? data.truncatedRigCount : 0,
      statusByKey,
      expandedRigIds,
      collapsedPodKeys,
      columns,
      scopeKind,
    }),
    [entries, data.truncatedRigCount, statusByKey, expandedRigIds, collapsedPodKeys, columns, scopeKind, scope.kind],
  );

  const translateExtent = useMemo(() => phoneTranslateExtent(layout.bounds), [layout.bounds]);
  // Tablet page flow: null = the readable full-width view (Reset).
  const [pageZoom, setPageZoom] = useState<number | null>(null);
  const pageView = useMemo(
    () => (pageFlow ? pagePhoneViewport(layout.bounds, size.width, pageZoom) : null),
    [pageFlow, layout.bounds, size.width, pageZoom],
  );
  const scrollMarkRef = useRef<HTMLDivElement | null>(null);

  // ---- Relationships of the selected seat (canvas highlight only).
  const relations = useMemo(() => {
    if (!selectedAgent || !model) return { outgoing: [], incoming: [] } as { outgoing: Array<{ kind: string; agent: SpatialAgent }>; incoming: Array<{ kind: string; agent: SpatialAgent }> };
    const outgoing: Array<{ kind: string; agent: SpatialAgent }> = [];
    const incoming: Array<{ kind: string; agent: SpatialAgent }> = [];
    for (const edge of model.edges) {
      if (edge.sourceKey === selectedAgent.key) {
        const other = model.agentsByKey.get(edge.targetKey);
        if (other) outgoing.push({ kind: edge.kind, agent: other });
      } else if (edge.targetKey === selectedAgent.key) {
        const other = model.agentsByKey.get(edge.sourceKey);
        if (other) incoming.push({ kind: edge.kind, agent: other });
      }
    }
    return { outgoing, incoming };
  }, [selectedAgent, model]);

  const selectedNodeId = selectedAgent
    ? layout.representativeOf.get(selectedAgent.key) ?? null
    : focus?.kind === "rig"
      ? layout.nodes.find((n) => n.type === "phoneRig" && (n.data as PhoneRigNodeData).rigId === focus.rigId)?.id ?? null
      : focus?.kind === "pod"
        ? focus.podKey
        : focus?.kind === "truncated" ? "phone-graph/truncated" : null;
  const relatedNodeIds = useMemo(() => {
    if (!selectedAgent) return null;
    const ids = new Set<string>();
    const own = layout.representativeOf.get(selectedAgent.key);
    if (own) ids.add(own);
    for (const r of [...relations.outgoing, ...relations.incoming]) {
      const id = layout.representativeOf.get(r.agent.key);
      if (id) ids.add(id);
    }
    return ids;
  }, [selectedAgent, relations, layout.representativeOf]);

  const toggleRig = useCallback((rigId: string) => {
    setRigExpanded(rigId, !expandedRigIds.has(rigId));
  }, [expandedRigIds, setRigExpanded]);
  const togglePod = useCallback((podKey: string) => {
    setPodCollapsed(podKey, !collapsedPodKeys.has(podKey));
  }, [collapsedPodKeys, setPodCollapsed]);

  const viewNodes = useMemo(() => layout.nodes.map((node) => {
    const d = node.data;
    const isSelected = node.id === selectedNodeId;
    const dimmed = relatedNodeIds !== null && node.type !== "phoneRig" && node.type !== "phonePod" && !relatedNodeIds.has(node.id);
    const extra: Record<string, unknown> = { selected: isSelected, dimmed };
    if (d.kind === "rig" && d.collapsible) extra.onToggle = () => toggleRig(d.rigId);
    if (d.kind === "pod" && !d.loose) extra.onToggle = () => togglePod(d.podKey);
    return { ...node, selectable: false, draggable: false, data: { ...d, ...extra } };
  }), [layout.nodes, selectedNodeId, relatedNodeIds, toggleRig, togglePod]);

  const viewEdges = useMemo(() => layout.edges.map((edge: PhoneEdge) => {
    const base = getEdgeStyle(edge.data.kinds[0] ?? "delegates_to");
    const touches = selectedAgent ? edge.data.agentKeys.includes(selectedAgent.key) : selectedNodeId !== null && (edge.source === selectedNodeId || edge.target === selectedNodeId);
    const anySelection = selectedNodeId !== null;
    const stroke = touches ? HIGHLIGHT_STROKE : (base.style.stroke as string | undefined);
    return {
      ...edge,
      type: "default",
      animated: false,
      markerEnd: { ...base.markerEnd, color: touches ? HIGHLIGHT_STROKE : base.markerEnd.color },
      label: edge.data.count > 1 ? `×${edge.data.count}` : undefined,
      labelStyle: { fontFamily: "monospace", fontSize: 10 },
      labelBgPadding: [3, 1] as [number, number],
      style: {
        ...base.style,
        stroke,
        strokeWidth: touches ? 2.5 : edge.data.merged ? 1.75 : 1.25,
        opacity: anySelection && !touches ? 0.25 : 1,
      },
      zIndex: touches ? 3 : 1,
    };
  }), [layout.edges, selectedAgent, selectedNodeId]);

  // ---- Viewport: readable opening view, refit on rotation/column change,
  // keep the operator's pan/zoom across expand/collapse and data refreshes.
  const orientation = size.width >= size.height ? "landscape" : "portrait";
  const fitKey = !pageFlow && layout.nodes.length > 0 && size.width > 0 && size.height > 0
    ? `${columns}|${orientation}|${Math.round(size.width / 48)}`
    : null;
  const appliedFitKey = useRef<string | null>(null);
  const duration = reducedMotion ? 0 : 200;
  // Expand/collapse changes the extent but keeps the operator's camera: bound
  // it now rather than letting the next touch jump. Runs before the refit and
  // centre effects, so their own (bounded) viewport wins in the same commit.
  const boundedFor = useRef<{ extent: PhoneExtent; fitKey: string | null } | null>(null);
  useEffect(() => {
    const prev = boundedFor.current;
    boundedFor.current = { extent: translateExtent, fitKey };
    if (pageFlow || !prev || prev.extent === translateExtent || prev.fitKey !== fitKey || size.width <= 0) return;
    const now = flow.getViewport();
    const next = boundPhoneViewport(now, translateExtent, size);
    if (Math.abs(next.x - now.x) > 0.5 || Math.abs(next.y - now.y) > 0.5) void flow.setViewport(next, { duration });
  }, [translateExtent, fitKey, size, flow, duration, pageFlow]);
  useEffect(() => {
    if (!fitKey || appliedFitKey.current === fitKey) return;
    const first = appliedFitKey.current === null;
    appliedFitKey.current = fitKey;
    const target = selectedNodeId ? layout.nodes.find((n) => n.id === selectedNodeId) : undefined;
    const next = target
      ? centerPhoneViewport(target, size, 1)
      : readablePhoneViewport(layout.bounds, size);
    if (next) void flow.setViewport(boundPhoneViewport(next, translateExtent, size), { duration: first ? 0 : duration });
  }, [fitKey, layout, selectedNodeId, size, flow, duration, translateExtent]);
  // Page flow: the camera follows the layout, width and page zoom exactly
  // (the surface is resized to match in the same commit). Leaving page flow
  // refits through the effect above.
  useEffect(() => {
    if (!pageView) return;
    appliedFitKey.current = null;
    void flow.setViewport(pageView.viewport);
  }, [pageView, flow]);

  // Centre requests (neighbor rows, Center button) resolve after the layout
  // has re-expanded whatever held the target.
  const [centerRequest, setCenterRequest] = useState<{ nodeKey: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!centerRequest) return;
    const id = layout.representativeOf.get(centerRequest.nodeKey) ?? centerRequest.nodeKey;
    const node = layout.nodes.find((n) => n.id === id);
    setCenterRequest(null);
    if (!node) return;
    if (pageView) {
      // The page scrolls, not the camera: bring the node's drawn box into view.
      const mark = scrollMarkRef.current;
      if (!mark) return;
      const { y, zoom } = pageView.viewport;
      mark.style.top = `${y + node.position.y * zoom}px`;
      mark.style.height = `${node.height * zoom}px`;
      mark.scrollIntoView?.({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      return;
    }
    const zoom = Math.max(flow.getZoom(), 1);
    const next = centerPhoneViewport(node, size, zoom);
    if (next) void flow.setViewport(boundPhoneViewport(next, translateExtent, size), { duration });
  }, [centerRequest, layout, size, flow, duration, translateExtent, pageView, reducedMotion]);

  const selectSeat = useCallback((agent: SpatialAgent, opts: { center?: boolean } = {}) => {
    // Make the seat visible first: open its rig and pod if they are collapsed.
    if (scope.kind === "host" && !expandedRigIds.has(agent.rigId)) setRigExpanded(agent.rigId, true);
    if (agent.podKey && collapsedPodKeys.has(agent.podKey)) setPodCollapsed(agent.podKey, false);
    setFocus(null);
    nav.replace({ selection: { rigId: agent.rigId, nodeId: agent.nodeId } });
    if (opts.center) setCenterRequest({ nodeKey: agent.key, nonce: Date.now() });
  }, [scope.kind, expandedRigIds, setRigExpanded, collapsedPodKeys, setPodCollapsed, nav]);

  // ---- Seat terminal overlay: opened only by a seat tap, for exactly the
  // seat that tap selected. Any later change of the URL selection (another
  // seat, a rig/pod focus, Clear, Back/Forward) closes it, and a selection
  // that stops resolving closes it for good, so a refreshed graph can never
  // reopen it on its own.
  const [terminalFor, setTerminalFor] = useState<{ agentKey: string; selectionKey: string } | null>(null);
  useEffect(() => {
    setTerminalFor((t) => (t && t.selectionKey !== urlSelectionKey ? null : t));
  }, [urlSelectionKey]);
  useEffect(() => {
    if (terminalFor && urlSelectionKey === terminalFor.selectionKey && selectionIssue && selectionIssue !== "pending") setTerminalFor(null);
  }, [terminalFor, urlSelectionKey, selectionIssue]);
  const terminalAgent = terminalFor && selectedAgent?.key === terminalFor.agentKey ? selectedAgent : null;

  // Every seat entry point (canvas chip, seat row, details action) agrees.
  const openSeat = useCallback((agent: SpatialAgent) => {
    selectSeat(agent, { center: true });
    setTerminalFor({ agentKey: agent.key, selectionKey: `${agent.rigId}\u0000${agent.nodeId}` });
  }, [selectSeat]);

  const selectFocus = useCallback((next: Focus | null) => {
    setFocus(next);
    if (urlSelection) nav.replace({ selection: null });
  }, [nav, urlSelection]);

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    const d = node.data as unknown as PhoneNode["data"];
    if (d.kind === "seat") {
      const agent = model?.agentsByKey.get((d as PhoneSeatNodeData).agentKey);
      if (agent) openSeat(agent);
      return;
    }
    if (d.kind === "pod") {
      if ((d as PhonePodNodeData).loose) return;
      selectFocus({ kind: "pod", podKey: (d as PhonePodNodeData).podKey });
      return;
    }
    if (d.kind === "rig") {
      selectFocus({ kind: "rig", rigId: (d as PhoneRigNodeData).rigId });
      return;
    }
    if (d.kind === "truncated") selectFocus({ kind: "truncated" });
  }, [model, openSeat, selectFocus]);

  const clearSelection = useCallback(() => {
    setFocus(null);
    if (urlSelection) nav.replace({ selection: null });
  }, [nav, urlSelection]);

  const detailsRef = useRef<HTMLDivElement | null>(null);

  // ---- Read states (truthful: pending/failed is not an empty fleet).
  if (data.status === "loading" && !model) {
    return (
      <PhoneGraphShell>
        <div data-testid="phone-graph-loading" role="status" className="px-4 py-10 text-center font-mono text-[11px] text-on-surface-variant">
          Reading {scope.kind === "host" ? "rigs" : "the rig graph"}…
        </div>
      </PhoneGraphShell>
    );
  }
  if (data.status === "error") {
    return (
      <PhoneGraphShell>
        <div data-testid="phone-graph-error" role="alert" className="flex flex-col items-start gap-3 px-4 py-6 font-mono text-[11px] text-error">
          <span>
            {scope.kind === "host" ? "Rig inventory unavailable" : "This rig's graph is unavailable"}: {data.errorMessage ?? "read failed"}.
          </span>
          <button type="button" onClick={data.refetch} className={ACTION_SECONDARY}>Retry</button>
        </div>
      </PhoneGraphShell>
    );
  }
  if (scope.kind === "pod" && data.podMissing) {
    return (
      <PhoneGraphShell>
        <div data-testid="phone-graph-pod-missing" role="status" className="px-4 py-6 font-mono text-[11px] text-on-surface-variant">
          Pod <span className="text-on-surface">{scope.podName}</span> is not in this rig&apos;s current graph.
        </div>
      </PhoneGraphShell>
    );
  }
  if (entries.length === 0 && data.truncatedRigCount === 0) {
    return (
      <PhoneGraphShell>
        <div data-testid="phone-graph-empty" className="px-4 py-10 text-center font-mono text-[11px] text-on-surface-variant">
          {scope.kind === "host"
            ? <>No rigs registered. Run <code className="text-on-surface">rig up</code> to start one.</>
            : "This rig has no seats in its graph."}
        </div>
      </PhoneGraphShell>
    );
  }

  const unavailable = data.rigErrors.map((e) => ({ rigName: e.rigName, message: e.message }));
  const partial = (model?.issues ?? []).map((i) => ({ detail: `${model?.rigs.find((r) => r.rigId === i.rigId)?.rigName ?? i.rigId}: ${i.detail}` }));
  const peekName = selectedAgent?.displayName
    ?? (focus?.kind === "rig" ? entryName(entries, focus.rigId) : null)
    ?? (focus?.kind === "pod" ? (model?.podsByKey.get(focus.podKey)?.label ?? null) : null);

  return (
    <PhoneGraphShell>
      {unavailable.length > 0 || partial.length > 0 ? (
        <div className="mx-3 mb-2 border border-outline-variant bg-surface-lowest/80 px-2 py-1.5">
          <GraphPartialNotice issues={partial} unavailable={unavailable} />
        </div>
      ) : null}
      {/* Phone landscape (short viewport) puts details beside the canvas; a
          tablet keeps page flow with details below even when its viewport is
          short (keyboard open), so every short-landscape rule is phone-only. */}
      <div className={cn("flex flex-col gap-3 px-3 pb-3", !pageFlow && "[@media(orientation:landscape)_and_(max-height:540px)]:flex-row")}>
        <div
          data-testid="phone-graph-canvas"
          data-columns={columns}
          data-flow={pageFlow ? "page" : "bounded"}
          className={cn(
            "flex min-w-0 flex-col border border-outline-variant bg-surface-lowest/30",
            pageFlow
              ? null
              : "h-[clamp(300px,58svh,760px)] [@media(orientation:landscape)_and_(max-height:540px)]:h-[max(240px,calc(100svh-7.5rem))] [@media(orientation:landscape)_and_(max-height:540px)]:flex-[3]",
          )}
        >
          {/* Reserved control header: camera controls live in their own row,
              outside the drawable surface, so they can never cover a node's
              own controls (rig/pod collapse) at any pan or zoom. */}
          <div
            role="toolbar"
            aria-label="Graph view controls"
            data-testid="phone-graph-controls"
            className={cn(
              "flex h-11 shrink-0 items-stretch border-b border-outline-variant bg-background/90",
              // Page flow: the controls follow the page while the graph scrolls by.
              pageFlow && "sticky top-0 z-10",
            )}
          >
            <span className="flex min-w-0 flex-1 items-center truncate px-3 font-mono text-[10px] text-on-surface-variant">
              {pageFlow ? "Scroll the page · − / + to zoom" : "Drag to scroll · pinch to zoom"}
            </span>
            <button type="button" data-testid="phone-graph-fit"
              aria-label={pageFlow ? "Reset to readable width" : "Fit whole graph"} title={pageFlow ? "Reset to readable width" : "Fit whole graph"}
              onClick={() => (pageFlow ? setPageZoom(null) : void flow.fitView({ padding: 0.06, duration, minZoom: PHONE_MIN_ZOOM }))}
              className="inline-flex h-11 w-11 items-center justify-center border-l border-outline-variant text-on-surface hover:bg-surface-low/70">
              <Maximize className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" data-testid="phone-graph-zoom-out" aria-label="Zoom out" title="Zoom out"
              disabled={pageView ? pageView.viewport.zoom <= pageView.minZoom : false}
              onClick={() => {
                if (!pageFlow) void flow.zoomOut({ duration });
                else if (pageView) setPageZoom(Math.max(pageView.minZoom, pageView.viewport.zoom / 1.2));
              }}
              className="inline-flex h-11 w-11 items-center justify-center border-l border-outline-variant text-on-surface hover:bg-surface-low/70 disabled:opacity-40">
              <Minus className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" data-testid="phone-graph-zoom-in" aria-label="Zoom in" title="Zoom in"
              disabled={pageView ? pageView.viewport.zoom >= pageView.readableZoom : false}
              onClick={() => {
                if (!pageFlow) void flow.zoomIn({ duration });
                else if (pageView) setPageZoom(pageView.viewport.zoom * 1.2 >= pageView.readableZoom ? null : pageView.viewport.zoom * 1.2);
              }}
              className="inline-flex h-11 w-11 items-center justify-center border-l border-outline-variant text-on-surface hover:bg-surface-low/70 disabled:opacity-40">
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div
            ref={setSurfaceEl}
            data-testid="phone-graph-surface"
            className={cn("relative", !pageFlow && "min-h-0 flex-1")}
            style={pageFlow ? { height: pageView?.height ?? 300 } : undefined}
          >
            <ReactFlow
              nodes={viewNodes}
              edges={viewEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={onNodeClick}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              // Page flow takes no gestures at all (React Flow then filters
              // every touch), so drags scroll the page and pinch zooms it.
              panOnDrag={!pageFlow}
              zoomOnPinch={!pageFlow}
              // One-finger drags move vertically: the horizontal extent is the
              // graph itself, so while it fits the width d3 keeps it centred
              // (no sideways drift); zoomed in, panning stays inside it.
              translateExtent={translateExtent}
              zoomOnScroll={false}
              panOnScroll={false}
              zoomOnDoubleClick={false}
              // Wheel/trackpad scroll belongs to the page: the canvas never traps it.
              preventScrolling={false}
              minZoom={PHONE_MIN_ZOOM}
              maxZoom={PHONE_MAX_ZOOM}
              proOptions={{ hideAttribution: true }}
              // Gestures inside the canvas belong to the graph (no Safari
              // double-tap page zoom mid-pan); the header, footer and
              // everything outside the canvas keep native scroll and page zoom.
              className={pageFlow ? "touch-manipulation" : "touch-none"}
            />
            {pageFlow ? <div ref={scrollMarkRef} aria-hidden="true" className="pointer-events-none absolute inset-x-0" /> : null}
          </div>
          {/* Reserved peek footer (portrait; phone landscape shows the details
              column beside the canvas instead). Always present so selecting
              does not resize the surface, and never over a node. */}
          <div
            data-testid="phone-graph-footer"
            className={cn(
              "flex h-11 shrink-0 items-stretch border-t border-outline-variant bg-background/95 font-mono text-[11px]",
              // Page flow: the peek stays above the bottom nav while the graph scrolls.
              pageFlow ? "sticky bottom-[var(--shell-bottom)] z-10" : "[@media(orientation:landscape)_and_(max-height:540px)]:hidden",
            )}
          >
            {peekName ? (
              <div data-testid="phone-graph-peek" className="flex min-w-0 flex-1 items-center gap-1 pl-3">
                <span className="min-w-0 flex-1 truncate font-bold text-on-surface">{peekName}</span>
                <button
                  type="button"
                  onClick={() => detailsRef.current?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" })}
                  className="inline-flex min-h-11 items-center px-3 uppercase tracking-[0.06em] text-on-surface hover:bg-surface-low/70"
                >
                  Details
                </button>
                <button type="button" aria-label="Clear selection" onClick={clearSelection}
                  className="inline-flex h-11 w-11 items-center justify-center text-on-surface-variant hover:bg-surface-low/70">
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <span className="flex min-w-0 flex-1 items-center truncate px-3 text-[10px] text-on-surface-variant">
                Tap a seat for its terminal · a rig or pod for details
              </span>
            )}
          </div>
        </div>
        <div
          ref={detailsRef}
          data-testid="phone-graph-details"
          className={cn(
            "min-w-0 scroll-mt-2 border border-outline-variant bg-background/80",
            !pageFlow && "[@media(orientation:landscape)_and_(max-height:540px)]:flex-[2] [@media(orientation:landscape)_and_(max-height:540px)]:h-[max(240px,calc(100svh-7.5rem))] [@media(orientation:landscape)_and_(max-height:540px)]:overflow-y-auto",
          )}
        >
          <PhoneGraphDetails
            nav={nav}
            scope={scope}
            model={model}
            entries={entries}
            focus={focus}
            selectedAgent={selectedAgent}
            selectionIssue={selectionIssue}
            selectionRigId={urlSelection?.rigId ?? null}
            statusByKey={statusByKey}
            linkSource={linkSource}
            truncatedRigCount={scope.kind === "host" ? data.truncatedRigCount : 0}
            expandedRigIds={expandedRigIds}
            collapsedPodKeys={collapsedPodKeys}
            onOpenSeat={openSeat}
            onSelectRig={(rigId) => { selectFocus({ kind: "rig", rigId }); setCenterRequest({ nodeKey: rigNodeId(layout.nodes, rigId) ?? "", nonce: Date.now() }); }}
            onSelectPod={(podKey) => { selectFocus({ kind: "pod", podKey }); setCenterRequest({ nodeKey: podKey, nonce: Date.now() }); }}
            onToggleRig={toggleRig}
            onTogglePod={togglePod}
            onSetAllRigs={(expanded) => { for (const e of entries) if (e.kind === "ready") setRigExpanded(e.rig.rigId, expanded); }}
            onCenter={() => { if (selectedNodeId) setCenterRequest({ nodeKey: selectedNodeId, nonce: Date.now() }); }}
            onClear={clearSelection}
          />
        </div>
      </div>
      {terminalAgent ? (
        <PhoneSeatTerminal
          agent={terminalAgent}
          hostId={hostId}
          tone={(statusByKey.get(terminalAgent.key) ?? deriveSeatStatus(terminalAgent)).tone}
          seatTarget={terminalAgent.logicalId
            ? topologyTarget({ scope: { kind: "seat", rigId: terminalAgent.rigId, logicalId: terminalAgent.logicalId }, sourceHost: linkSource })
            : null}
          from={nav.scope}
          onClose={() => setTerminalFor(null)}
        />
      ) : null}
    </PhoneGraphShell>
  );
}

/** Full-screen terminal for the tapped seat, in the app's Radix dialog: it
 *  portals above the shell's top bar and bottom nav, makes the page behind it
 *  inert, traps focus and restores it on close. The dock is the 3D
 *  workspace's SeatLiveTerminal with its own fresh detail read, keyed by the
 *  exact host/rig/node so another seat always closes this one first. Closing
 *  frees the socket and cap slot; the graph, selection and camera stay. */
function PhoneSeatTerminal({ agent, hostId, tone, seatTarget, from, onClose }: {
  agent: SpatialAgent;
  hostId: string;
  tone: SpatialSeatStatus["tone"];
  seatTarget: ReturnType<typeof topologyTarget>;
  from: TopologyScope;
  onClose: () => void;
}) {
  const { detailKey, detailQuery } = useSeatDetailQuery(agent, hostId);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Radix restores focus only to a DialogTrigger; this dialog has none, so
  // return focus to whatever opened it (a seat row or the Terminal action).
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement));
  const pod = agent.podNamespace ?? null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        data-testid="phone-graph-terminal"
        data-agent-key={agent.key}
        // Focus the Close button, not the terminal: no soft keyboard pops up.
        onOpenAutoFocus={(e) => { e.preventDefault(); closeRef.current?.focus(); }}
        onCloseAutoFocus={(e) => {
          if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
            e.preventDefault();
            opener.focus();
          }
        }}
        // Escape typed into the terminal belongs to the pane (xterm still
        // receives it); Escape anywhere else closes.
        onEscapeKeyDown={(e) => { if (e.target instanceof Element && e.target.closest(".xterm")) e.preventDefault(); }}
        // The dock's terminal ground normally comes from the 3D atelier theme.
        style={{ "--spatial-terminal-ground": "24 10% 4.5%" } as CSSProperties}
        className="inset-0 left-0 top-0 flex h-[100dvh] max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 border-0 !bg-background p-0 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-none [&_.spatial-terminal-frame--stacked]:h-[max(13rem,calc(100dvh-9rem))]"
      >
        <header className="sticky top-0 z-10 flex min-h-12 shrink-0 items-center gap-2 border-b border-outline-variant bg-background pl-3">
          <ToneDot tone={tone} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-mono text-[12px] font-bold leading-normal tracking-normal text-on-surface">{agent.displayName}</DialogTitle>
            <div className="truncate font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
              {agent.rigName}{pod ? ` / ${pod}` : ""}
            </div>
          </div>
          {seatTarget ? (
            <TopologyLink target={seatTarget} from={from} className="inline-flex min-h-11 items-center px-3 font-mono text-[10px] uppercase tracking-[0.06em] text-on-surface hover:bg-surface-low/70" data-testid="phone-graph-terminal-seat">
              Seat page
            </TopologyLink>
          ) : null}
          <DialogClose ref={closeRef} aria-label="Close terminal" data-testid="phone-graph-terminal-close"
            className="inline-flex h-12 w-12 shrink-0 items-center justify-center border-l border-outline-variant text-on-surface hover:bg-surface-low/70 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface">
            <X className="h-5 w-5" aria-hidden="true" />
          </DialogClose>
        </header>
        <div className="pb-3">
          <SeatLiveTerminal
            key={`${hostId}|${agent.rigId}|${agent.nodeId}`}
            agent={agent}
            hostId={hostId}
            isRemote={hostId !== LOCAL_HOST_ID}
            detailKey={detailKey}
            detailQuery={detailQuery}
            layout="stacked"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function rigNodeId(nodes: readonly PhoneNode[], rigId: string): string | null {
  return nodes.find((n) => n.type === "phoneRig" && (n.data as PhoneRigNodeData).rigId === rigId)?.id ?? null;
}

function entryName(entries: readonly PhoneRigEntry[], rigId: string): string | null {
  const e = entries.find((x) => (x.kind === "ready" ? x.rig.rigId : x.rigId) === rigId);
  if (!e) return null;
  return e.kind === "ready" ? e.rig.rigName : e.rigName;
}

function PhoneGraphShell({ children }: { children: ReactNode }) {
  return (
    <div data-testid="phone-topology-graph" className="w-full pt-1">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details panel
// ---------------------------------------------------------------------------

const SELECTION_ISSUE_TEXT: Record<SelectionIssue, (rig: string) => string> = {
  pending: (rig) => `Reading rig ${rig}'s graph for the selected seat…`,
  unreadable: (rig) => `Selection unavailable while rig ${rig}'s graph cannot be read.`,
  absent: (rig) => `The selected seat is not in rig ${rig}'s current graph.`,
  "not-loaded": (rig) => `Rig ${rig} is beyond the rigs drawn here. Open the rig to see the selected seat.`,
  "not-in-inventory": (rig) => `Rig ${rig} is not in this host's current inventory.`,
};

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="border-t border-outline-variant/60 px-3 py-2 first:border-t-0">
      <h4 className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">{title}</h4>
      {children}
    </section>
  );
}

function RowButton({ onClick, children, testId }: { onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-2 border-b border-outline-variant/40 px-1 text-left font-mono text-[11px] text-on-surface last:border-b-0 hover:bg-surface-low/60"
    >
      {children}
    </button>
  );
}

interface DetailsProps {
  nav: TopologyNavigation;
  scope: TopologyScope;
  model: SpatialModel | null;
  entries: PhoneRigEntry[];
  focus: Focus | null;
  selectedAgent: SpatialAgent | null;
  selectionIssue: SelectionIssue | null;
  selectionRigId: string | null;
  statusByKey: ReadonlyMap<string, SpatialSeatStatus>;
  linkSource: string | null;
  truncatedRigCount: number;
  expandedRigIds: ReadonlySet<string>;
  collapsedPodKeys: ReadonlySet<string>;
  onOpenSeat: (agent: SpatialAgent) => void;
  onSelectRig: (rigId: string) => void;
  onSelectPod: (podKey: string) => void;
  onToggleRig: (rigId: string) => void;
  onTogglePod: (podKey: string) => void;
  onSetAllRigs: (expanded: boolean) => void;
  onCenter: () => void;
  onClear: () => void;
}

function PhoneGraphDetails(props: DetailsProps) {
  const { nav, scope, model, entries, focus, selectedAgent, selectionIssue, selectionRigId, statusByKey, linkSource } = props;

  if (selectionIssue && selectionRigId) {
    return (
      <div data-testid="phone-graph-selection-issue" role="status" className="px-3 py-3 font-mono text-[11px] text-on-surface-variant">
        <p>{SELECTION_ISSUE_TEXT[selectionIssue](entryName(entries, selectionRigId) ?? selectionRigId)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={props.onClear} className={ACTION_SECONDARY}>Clear selection</button>
          {selectionIssue === "not-loaded" ? (
            <TopologyLink target={topologyTarget({ scope: { kind: "rig", rigId: selectionRigId }, sourceHost: linkSource })} from={nav.scope} className={ACTION_PRIMARY}>
              Open rig
            </TopologyLink>
          ) : null}
        </div>
      </div>
    );
  }

  if (selectedAgent && model) {
    const agent = selectedAgent;
    const status = statusByKey.get(agent.key) ?? deriveSeatStatus(agent);
    const seatTarget = agent.logicalId
      ? topologyTarget({ scope: { kind: "seat", rigId: agent.rigId, logicalId: agent.logicalId }, sourceHost: linkSource })
      : null;
    const pod = agent.podKey ? model.podsByKey.get(agent.podKey) : undefined;
    return (
      <div data-testid="phone-graph-seat-details" data-agent-key={agent.key}>
        <div className="px-3 pt-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">
            {agent.rigName}{pod ? ` / ${pod.label}` : " / no pod"}
          </div>
          <h3 data-testid="phone-graph-details-name" className="mt-0.5 break-words font-headline text-lg font-bold leading-tight text-on-surface">
            {agent.displayName}
          </h3>
          <div className="break-all font-mono text-[10px] text-on-surface-variant">
            {agent.logicalId ?? `node ${agent.nodeId} (no logical id)`}
          </div>
          <div className="mt-2 flex items-start gap-2 font-mono text-[11px] text-on-surface">
            <ToneDot tone={status.tone} className="mt-1" />
            <div className="min-w-0">
              <div>
                {status.label}
                {status.stale ? " (stale)" : ""}
                {status.sampleAge ? ` · ${status.sampleAge}` : ""}
              </div>
              <div className="text-[10px] text-on-surface-variant">{status.evidence}</div>
              {status.problems.map((p) => <div key={p} className="text-[10px] text-error">{p}</div>)}
            </div>
          </div>
          <div className="mt-1 font-mono text-[10px] text-on-surface-variant">
            {formatRuntimeModel(agent.runtime, agent.model)}
            {agent.pendingWorkCount > 0 ? ` · ${agent.pendingWorkCount} queued` : ""}
            {agent.currentQitems.length > 0 ? ` · ${agent.currentQitems.length} in progress` : ""}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 pb-3">
            <button type="button" onClick={() => props.onOpenSeat(agent)} className={ACTION_PRIMARY} data-testid="phone-graph-open-terminal">
              <SquareTerminal className="h-4 w-4" aria-hidden="true" /> Terminal
            </button>
            {seatTarget ? (
              <TopologyLink target={seatTarget} from={nav.scope} className={ACTION_SECONDARY} data-testid="phone-graph-open-seat">
                Open seat
              </TopologyLink>
            ) : (
              <span className={ACTION_DISABLED} title="The graph omitted this seat's logical id, so it has no detail page." data-testid="phone-graph-open-seat-unavailable">
                No seat page
              </span>
            )}
            <button type="button" onClick={props.onCenter} className={ACTION_SECONDARY}>
              <Crosshair className="h-4 w-4" aria-hidden="true" /> Center
            </button>
            <button type="button" onClick={props.onClear} className={ACTION_SECONDARY}>Clear</button>
          </div>
        </div>
      </div>
    );
  }

  if (focus?.kind === "pod" && model) {
    const pod = model.podsByKey.get(focus.podKey);
    if (pod) {
      const rig = model.rigs.find((r) => r.rigId === pod.rigId);
      const ambiguous = (rig?.pods.filter((p) => p.namespace === pod.namespace).length ?? 0) > 1;
      const agents = pod.agentKeys.map((k) => model.agentsByKey.get(k)).filter((a): a is SpatialAgent => Boolean(a));
      const target = ambiguous ? null : topologyTarget({ scope: { kind: "pod", rigId: pod.rigId, podName: pod.namespace }, sourceHost: linkSource });
      const isCurrentScope = scope.kind === "pod" && scope.rigId === pod.rigId && scope.podName === pod.namespace;
      const collapsed = props.collapsedPodKeys.has(pod.key);
      return (
        <div data-testid="phone-graph-pod-details" data-pod-key={pod.key}>
          <div className="px-3 py-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">{rig?.rigName ?? pod.rigId} / pod</div>
            <h3 className="mt-0.5 break-words font-headline text-lg font-bold leading-tight text-on-surface">{pod.label}</h3>
            <div className="break-all font-mono text-[10px] text-on-surface-variant">{pod.namespace}</div>
            <TallyRow tally={tallyTones(pod.agentKeys, statusByKey)} className="mt-2 font-mono text-[10px] text-on-surface" />
            <div className="mt-3 flex flex-wrap gap-2">
              {isCurrentScope ? null : target ? (
                <TopologyLink target={target} from={nav.scope} className={ACTION_PRIMARY} data-testid="phone-graph-open-pod">Open pod</TopologyLink>
              ) : (
                <span className={ACTION_DISABLED} title={ambiguous ? "Another pod in this rig has the same namespace, so no exact pod page exists." : "This pod cannot be represented in a link."}>
                  {ambiguous ? "Ambiguous pod" : "No pod page"}
                </span>
              )}
              <button type="button" onClick={() => props.onTogglePod(pod.key)} className={ACTION_SECONDARY} aria-expanded={!collapsed}>
                {collapsed ? "Show seats" : "Hide seats"}
              </button>
              <button type="button" onClick={props.onClear} className={ACTION_SECONDARY}>Clear</button>
            </div>
          </div>
          <Section title={`Seats (${agents.length})`}>
            {agents.map((a) => (
              <RowButton key={a.key} onClick={() => props.onOpenSeat(a)} testId="phone-graph-seat-row">
                <ToneDot tone={statusByKey.get(a.key)?.tone ?? "unknown"} />
                <span className="min-w-0 flex-1 truncate">{a.displayName}</span>
                <span className="shrink-0 text-[10px] text-on-surface-variant">{statusByKey.get(a.key)?.label ?? "unknown"}</span>
              </RowButton>
            ))}
          </Section>
        </div>
      );
    }
  }

  if (focus?.kind === "rig") {
    const entry = entries.find((e) => (e.kind === "ready" ? e.rig.rigId : e.rigId) === focus.rigId);
    if (entry) {
      const rigId = focus.rigId;
      const rig = entry.kind === "ready" ? entry.rig : null;
      const name = entry.kind === "ready" ? entry.rig.rigName : entry.rigName;
      const target = scope.kind === "host" ? topologyTarget({ scope: { kind: "rig", rigId }, sourceHost: linkSource }) : null;
      const expanded = props.expandedRigIds.has(rigId);
      return (
        <div data-testid="phone-graph-rig-details" data-rig-id={rigId}>
          <div className="px-3 py-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">Rig</div>
            <h3 className="mt-0.5 break-words font-headline text-lg font-bold leading-tight text-on-surface">{name}</h3>
            <div className="break-all font-mono text-[10px] text-on-surface-variant">{rigId}</div>
            {entry.kind === "error" ? (
              <p className="mt-2 font-mono text-[11px] text-error">Graph unavailable: {entry.message}</p>
            ) : entry.kind === "loading" ? (
              <p className="mt-2 font-mono text-[11px] text-on-surface-variant">Reading this rig&apos;s graph…</p>
            ) : (
              <TallyRow tally={rig ? tallyTones(rig.agents.map((a) => a.key), statusByKey) : emptyTally()} className="mt-2 font-mono text-[10px] text-on-surface" />
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {target ? <TopologyLink target={target} from={nav.scope} className={ACTION_PRIMARY} data-testid="phone-graph-open-rig">Open rig</TopologyLink> : null}
              {scope.kind === "host" && rig ? (
                <button type="button" onClick={() => props.onToggleRig(rigId)} className={ACTION_SECONDARY} aria-expanded={expanded} data-testid="phone-graph-rig-details-toggle">
                  {expanded ? "Hide pods" : "Show pods"}
                </button>
              ) : null}
              <button type="button" onClick={props.onClear} className={ACTION_SECONDARY}>Clear</button>
            </div>
          </div>
          {rig && rig.pods.length > 0 ? (
            <Section title={`Pods (${rig.pods.length})`}>
              {rig.pods.map((p) => (
                <RowButton key={p.key} onClick={() => props.onSelectPod(p.key)} testId="phone-graph-pod-row">
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  <TallyRow tally={tallyTones(p.agentKeys, statusByKey)} className="shrink-0 text-[10px]" />
                </RowButton>
              ))}
            </Section>
          ) : null}
        </div>
      );
    }
  }

  if (focus?.kind === "truncated") {
    return (
      <div data-testid="phone-graph-truncated-details" className="px-3 py-3 font-mono text-[11px] text-on-surface-variant">
        <p>
          {props.truncatedRigCount} more rig{props.truncatedRigCount === 1 ? " is" : "s are"} registered but not drawn here: the graph reads at most {MAX_SPATIAL_RIGS} rig graphs at once.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => nav.replace({ view: "table" })} className={ACTION_PRIMARY}>Show all in Table</button>
          <button type="button" onClick={props.onClear} className={ACTION_SECONDARY}>Clear</button>
        </div>
      </div>
    );
  }

  // Nothing selected: scope overview with an accessible path into the graph.
  const ready = entries.filter((e): e is Extract<PhoneRigEntry, { kind: "ready" }> => e.kind === "ready");
  const seatKeys = ready.flatMap((e) => e.rig.agents.map((a) => a.key));
  return (
    <div data-testid="phone-graph-overview">
      <div className="px-3 py-3">
        <p className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
          Tap a seat to open its terminal, or a rig or pod for its details. Drag to scroll, pinch to zoom.
        </p>
        <div className="mt-2 font-mono text-[11px] text-on-surface">
          {scope.kind === "host" ? `${entries.length + props.truncatedRigCount} rig${entries.length + props.truncatedRigCount === 1 ? "" : "s"} · ` : ""}
          {seatKeys.length} seat{seatKeys.length === 1 ? "" : "s"}
        </div>
        <TallyRow tally={tallyTones(seatKeys, statusByKey)} className="mt-1 font-mono text-[10px] text-on-surface" />
        {scope.kind === "host" && ready.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" data-testid="phone-graph-expand-all" onClick={() => props.onSetAllRigs(true)} className={ACTION_SECONDARY}
              disabled={ready.every((e) => props.expandedRigIds.has(e.rig.rigId))}>
              Expand all
            </button>
            <button type="button" data-testid="phone-graph-collapse-all" onClick={() => props.onSetAllRigs(false)} className={ACTION_SECONDARY}
              disabled={ready.every((e) => !props.expandedRigIds.has(e.rig.rigId))}>
              Collapse all
            </button>
          </div>
        ) : null}
      </div>
      {scope.kind === "host" ? (
        <Section title="Rigs">
          {entries.map((e) => {
            const rigId = e.kind === "ready" ? e.rig.rigId : e.rigId;
            const name = e.kind === "ready" ? e.rig.rigName : e.rigName;
            return (
              <RowButton key={rigId} onClick={() => props.onSelectRig(rigId)} testId="phone-graph-rig-row">
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="shrink-0 text-[10px] text-on-surface-variant">
                  {e.kind === "ready" ? `${e.rig.agents.length} seats` : e.kind === "loading" ? "reading…" : "unavailable"}
                </span>
              </RowButton>
            );
          })}
        </Section>
      ) : model && model.rigs[0] ? (
        <Section title={`Pods (${model.rigs[0].pods.length})`}>
          {model.rigs[0].pods.map((p) => (
            <RowButton key={p.key} onClick={() => props.onSelectPod(p.key)} testId="phone-graph-pod-row">
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              <TallyRow tally={tallyTones(p.agentKeys, statusByKey)} className="shrink-0 text-[10px]" />
            </RowButton>
          ))}
        </Section>
      ) : null}
      <Section title="Legend">
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-on-surface-variant">
          {(["active", "needs_input", "blocked", "idle", "unknown", "offline"] as const).map((tone) => (
            <span key={tone} className="inline-flex items-center gap-1"><ToneDot tone={tone} />{PHONE_TONE_LABEL[tone]}</span>
          ))}
        </div>
      </Section>
    </div>
  );
}
