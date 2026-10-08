// V1 polish slice: multi-rig hybrid /topology graph.
//
// Uses shared dagre helpers to lay out each expanded rig as a soft frame
// containing pod sub-frames and compact agent leaves, then lays out rig
// frames on the host canvas. V1 contracts remain load-bearing: lazy
// per-rig graph fetches, cross-rig node ID prefixing, collapse persistence,
// URL auto-expand, and graph/tree/table navigate parity.
//
// Default state: rigs expanded so the topology opens as the full fleet
// canvas. Explicit collapse state is still persisted in TopologyOverlayProvider,
// and the operator can collapse / expand every rig from the canvas controls.
// Auto-expand rule (parity with Phase 5.1 TopologyTreeView):
// when route is /topology/rig/$rigId or /topology/seat/$rigId/* or
// /topology/pod/$rigId/*, the matching rig is auto-expanded on mount /
// route change. Click rig card body -> toggle collapse. Click arrow Link
// on rig card name -> navigate to /topology/rig/$rigId (drill-in).
//
// Performance: per-rig graph data is lazy-fetched (useQueries enabled
// only when rig is expanded). The V1 operator default now intentionally
// fetches expanded rigs up front; explicit Collapse All restores the prior
// low-fan-out behavior.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ReactFlow,
  Controls,
  Panel,
  useReactFlow,
  useNodesInitialized,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQueries } from "@tanstack/react-query";
import { Maximize2, Minimize2 } from "lucide-react";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { RigGroupNode, type RigGroupNodeData } from "./RigGroupNode.js";
import { HybridAgentNode, HybridPodGroupNode } from "./HybridTopologyNodes.js";
import { HotPotatoEdge } from "./HotPotatoEdge.js";
import { useTopologyOverlay } from "./topology-overlay-context.js";
import { useTopologyActivity } from "../../hooks/useTopologyActivity.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { isTopologyGraph, topologyRead } from "../../lib/topology-read.js";
import { projectRigGraph, type RigGraphIssue } from "./rig-graph-projection.js";
import { GraphPartialNotice } from "./GraphPartialNotice.js";
import { freshTopologyVisitState, topologyTarget, useKnownSelectedHost } from "./topology-navigation.js";
import {
  HYBRID_COLLAPSED_RIG_HEIGHT,
  HYBRID_COLLAPSED_RIG_WIDTH,
  layoutHybridOuterRigs,
  layoutHybridRig,
  prefixedHybridNodeId,
} from "../../lib/hybrid-layout.js";
import type { GraphSeatSelection } from "./GraphSeatDock.js";
import {
  applyHotPotatoEdges,
  buildTopologySessionIndex,
  type TopologyActivityBaseline,
} from "../../lib/topology-activity.js";

interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

const nodeTypes: NodeTypes = {
  rigGroup: RigGroupNode as unknown as NodeTypes[string],
  podGroup: HybridPodGroupNode as unknown as NodeTypes[string],
  rigNode: HybridAgentNode as unknown as NodeTypes[string],
};

const edgeTypes: EdgeTypes = {
  hotPotato: HotPotatoEdge,
};

const DEFAULT_RIG_EXPANDED = true;
const HOST_GRAPH_MIN_ZOOM = 0.03;
const HOST_GRAPH_MAX_ZOOM = 2;
const HOST_GRAPH_FIT_PADDING = 0.08;

export function HostMultiRigGraph({ onSeatSelect }: {
  /** Tablet Graph: an agent tap reports its exact seat here (the host page
   *  docks its terminal under the graph) instead of navigating away. */
  onSeatSelect?: (seat: GraphSeatSelection) => void;
} = {}) {
  const navigate = useNavigate();
  const { data: psEntries, isError: psFailed, error: psError, refetch: refetchPs } = usePsEntries();
  const hostId = useSelectedHostId();
  const linkSource = useKnownSelectedHost();
  const reducedMotion = usePrefersReducedMotion();

  // V1 polish slice Phase 5.2 bounce-fix: rig-expanded state lifted to
  // TopologyOverlayProvider scope. Direct-URL entry to /topology/rig/$id
  // (which mounts RigScopePage, NOT HostMultiRigGraph because topology
  // routes are SIBLING) still updates the context's expandedRigs map
  // via the provider's auto-expand useEffect; when the operator returns
  // to /topology, this component reads the persisted state via
  // useTopologyOverlay() and renders the matching rig expanded.
  const { expandedRigs: expanded, setRigExpanded } = useTopologyOverlay();
  const isRigExpanded = useCallback(
    (rigId: string) => expanded.get(rigId) ?? DEFAULT_RIG_EXPANDED,
    [expanded],
  );
  const toggleRig = useCallback((rigId: string) => {
    setRigExpanded(rigId, !isRigExpanded(rigId));
  }, [isRigExpanded, setRigExpanded]);

  // P5.2-2 + P5.2-3: useQueries for per-rig graph data; enabled only
  // when the rig is expanded. Stable hook-call count (single useQueries
  // call) regardless of how psEntries grows from undefined to [N], so
  // no rules-of-hooks regression (P0-1 pattern preserved).
  const rigList = psEntries ?? [];
  const graphQueries = useQueries({
    queries: rigList.map((rig) => ({
      queryKey: ["rig", rig.rigId, "graph", hostId] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => topologyRead<GraphData>(`/api/rigs/${encodeURIComponent(rig.rigId)}/graph`, hostId, signal, isTopologyGraph),
      retry: false,
      enabled: isRigExpanded(rig.rigId),
      refetchInterval: 30_000,
    })),
  });
  const expandedCount = useMemo(
    () => rigList.filter((rig) => isRigExpanded(rig.rigId)).length,
    [rigList, isRigExpanded],
  );
  const expandAllRigs = useCallback(() => {
    for (const rig of rigList) setRigExpanded(rig.rigId, true);
  }, [rigList, setRigExpanded]);
  const collapseAllRigs = useCallback(() => {
    for (const rig of rigList) setRigExpanded(rig.rigId, false);
  }, [rigList, setRigExpanded]);

  // Build per-rig nested subgraphs and lay out rig frames on the host canvas.
  const { mergedNodes, mergedEdges, partialIssues, unavailableRigs } = useMemo(() => {
    type RawN = Node & { data?: Record<string, unknown>; initialWidth?: number; initialHeight?: number };
    type RawE = Edge & { source: string; target: string; data?: Record<string, unknown>; label?: unknown };

    const perRig: Array<{
      rigId: string;
      rigName: string;
      status: "running" | "partial" | "stopped";
      nodeCount: number;
      runningCount: number;
      /** Slice 15 — terminal-active count piped through from PsEntry. */
      activeCount?: number;
      podCount?: number;
      isExpanded: boolean;
      childNodes: Node[];
      childEdges: Edge[];
      width: number;
      height: number;
    }> = [];
    const partialIssues: RigGraphIssue[] = [];
    const unavailableRigs: Array<{ rigName: string; message: string }> = [];

    for (let i = 0; i < rigList.length; i++) {
      const rig = rigList[i]!;
      const isExpanded = isRigExpanded(rig.rigId);
      const queryResult = graphQueries[i];

      let childNodes: Node[] = [];
      let childEdges: Edge[] = [];
      let width = HYBRID_COLLAPSED_RIG_WIDTH;
      let height = HYBRID_COLLAPSED_RIG_HEIGHT;
      let podCount: number | undefined;

      // Untrusted entries: keep usable siblings, disclose the rest.
      const projection = projectRigGraph(queryResult?.data);
      const rawNodes = projection.nodes as RawN[];
      const rawEdges = projection.edges as RawE[];
      if (isExpanded) {
        for (const issue of projection.issues) partialIssues.push({ ...issue, detail: `${rig.name}: ${issue.detail}` });
        if (queryResult?.isError) {
          unavailableRigs.push({ rigName: rig.name, message: queryResult.error instanceof Error ? queryResult.error.message : "graph unavailable" });
        }
      }
      const layout = layoutHybridRig({
        rigId: rig.rigId,
        rigName: rig.name,
        nodes: rawNodes,
        edges: rawEdges,
        collapsed: !isExpanded,
      });
      width = layout.width;
      height = layout.height;
      if (isExpanded) {
        childNodes = layout.nodes;
        childEdges = layout.edges;
        podCount = layout.podCount;
      }

      perRig.push({
        rigId: rig.rigId,
        rigName: rig.name,
        status: rig.status,
        nodeCount: rig.nodeCount,
        runningCount: rig.runningCount,
        activeCount: (rig as { activeCount?: number }).activeCount,
        podCount,
        isExpanded,
        childNodes,
        childEdges,
        width,
        height,
      });
    }

    const packed = layoutHybridOuterRigs(
      perRig.map((p) => ({ rigId: p.rigId, width: p.width, height: p.height })),
    );

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < perRig.length; i++) {
      const p = perRig[i]!;
      const pack = packed[i]!;
      const data: RigGroupNodeData = {
        rigId: p.rigId,
        rigName: p.rigName,
        collapsed: !p.isExpanded,
        status: p.status,
        nodeCount: p.nodeCount,
        runningCount: p.runningCount,
        activeCount: p.activeCount,
        podCount: p.podCount,
        onToggle: toggleRig,
      };
      nodes.push({
        id: `rig-${p.rigId}`,
        type: "rigGroup",
        position: pack.position,
        data: data as unknown as Record<string, unknown>,
        style: { width: pack.width, height: pack.height },
        draggable: false,
        zIndex: 0,
      });
      if (p.isExpanded) {
        nodes.push(...p.childNodes);
        edges.push(...p.childEdges);
      }
    }

    return { mergedNodes: nodes, mergedEdges: edges, partialIssues, unavailableRigs };
    // toggleRig is stable per-render but useMemo doesn't know; safe to
    // include rigList + expanded + graphQueries as deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigList, isRigExpanded, graphQueries]);

  const sessionIndex = useMemo(() => buildTopologySessionIndex(
    mergedNodes
      .filter((node) => node.type === "rigNode")
      .map((node) => {
        const data = node.data as {
          rigId?: string | null;
          rigName?: string | null;
          logicalId?: string | null;
          canonicalSessionName?: string | null;
          agentActivity?: TopologyActivityBaseline["agentActivity"];
          currentQitems?: TopologyActivityBaseline["currentQitems"];
          startupStatus?: string | null;
          terminalActive?: boolean | null;
          hasAssignedWork?: boolean;
          pendingWorkCount?: number;
        } | undefined;
        return {
          nodeId: node.id,
          rigId: data?.rigId ?? null,
          rigName: data?.rigName ?? null,
          logicalId: data?.logicalId ?? null,
          canonicalSessionName: data?.canonicalSessionName ?? null,
          agentActivity: data?.agentActivity ?? null,
          currentQitems: data?.currentQitems ?? null,
          startupStatus: data?.startupStatus ?? null,
          terminalActive: data?.terminalActive,
          hasAssignedWork: data?.hasAssignedWork ?? false,
          pendingWorkCount: data?.pendingWorkCount ?? 0,
        };
      }),
  ), [mergedNodes]);
  const topologyActivity = useTopologyActivity(sessionIndex);

  const activeNodes = useMemo(() => mergedNodes.map((node) => {
    if (node.type === "rigGroup") {
      const data = node.data as unknown as RigGroupNodeData;
      return {
        ...node,
        data: {
          ...data,
          recentActivity: topologyActivity.isRigRecentlyActive(data.rigId),
        } as unknown as Record<string, unknown>,
      };
    }
    if (node.type !== "rigNode") return node;
    const data = node.data as TopologyActivityBaseline & {
      logicalId?: string | null;
    };
    return {
      ...node,
      data: {
        ...(node.data ?? {}),
        activityRing: topologyActivity.getNodeActivity(node.id, data),
        reducedMotion,
      },
    };
  }), [mergedNodes, topologyActivity, reducedMotion]);

  const activeEdges = useMemo(
    () => applyHotPotatoEdges(mergedEdges, topologyActivity.packets, { reducedMotion }),
    [mergedEdges, topologyActivity.packets, reducedMotion],
  );
  const layoutSignature = useMemo(() => mergedNodes.map((node) => {
    const style = node.style as { width?: string | number; height?: string | number } | undefined;
    return [
      node.id,
      Math.round(node.position.x),
      Math.round(node.position.y),
      style?.width ?? "",
      style?.height ?? "",
      node.parentId ?? "",
    ].join(":");
  }).join("|"), [mergedNodes]);

  // P5.2-7 click handlers: agent -> seat URL; pod group -> pod URL;
  // rig group -> toggle (handled inside RigGroupNode onClick; this
  // handler is a no-op for rigGroup type to avoid double-fire).
  const onNodeClick: NodeMouseHandler = (_evt, node) => {
    const data = node.data as { rigId?: string; logicalId?: string; podId?: string | null; podNamespace?: string | null } | undefined;
    const rigId = data?.rigId;
    if (!rigId) return;
    if (node.type === "rigGroup") return; // body click handled by RigGroupNode
    if (node.type === "podGroup" || node.type === "group") {
      const podName = data?.podNamespace ?? data?.podId;
      if (typeof podName !== "string" || !podName) return;
      const target = topologyTarget({ scope: { kind: "pod", rigId, podName }, sourceHost: linkSource });
      if (target) navigate({ to: target.to, params: target.params, search: target.search, state: freshTopologyVisitState } as never);
      return;
    }
    if (typeof data?.logicalId === "string" && data.logicalId) {
      if (onSeatSelect) {
        // Canvas ids are rig-prefixed; the seat is the served node id.
        const prefix = prefixedHybridNodeId(rigId, "");
        if (node.id.startsWith(prefix)) onSeatSelect({ hostId, rigId, nodeId: node.id.slice(prefix.length), logicalId: data.logicalId });
        return;
      }
      // Raw params through the shared builder (encoded once by the router).
      const target = topologyTarget({ scope: { kind: "seat", rigId, logicalId: data.logicalId }, sourceHost: linkSource });
      if (target) navigate({ to: target.to, params: target.params, search: target.search, state: freshTopologyVisitState } as never);
    }
  };

  // Pending or failed inventory is not an empty fleet.
  if (psEntries === undefined) {
    return psFailed ? (
      <div
        data-testid="host-multi-rig-graph-unavailable"
        role="alert"
        className="flex flex-col items-center justify-center gap-2 h-full font-mono text-[10px] text-error"
      >
        <span>Rig inventory unavailable: {psError instanceof Error ? psError.message : "read failed"}.</span>
        <button type="button" onClick={() => void refetchPs()} className="border border-outline px-3 py-1 uppercase tracking-wide text-on-surface">
          Retry
        </button>
      </div>
    ) : (
      <div
        data-testid="host-multi-rig-graph-loading"
        role="status"
        className="flex flex-col items-center justify-center h-full font-mono text-[10px] text-on-surface-variant"
      >
        Reading rigs…
      </div>
    );
  }

  if (rigList.length === 0) {
    return (
      <div
        data-testid="host-multi-rig-graph-empty"
        className="flex flex-col items-center justify-center h-full font-mono text-[10px] text-on-surface-variant"
      >
        No rigs registered. Run <code className="ml-1 text-on-surface">rig up</code> to start one.
      </div>
    );
  }

  return (
    <div
      data-testid="host-multi-rig-graph"
      className="w-full h-full relative"
    >
      <ReactFlow
        nodes={activeNodes}
        edges={activeEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        fitView
        fitViewOptions={{ padding: HOST_GRAPH_FIT_PADDING, includeHiddenNodes: false }}
        minZoom={HOST_GRAPH_MIN_ZOOM}
        maxZoom={HOST_GRAPH_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <HostGraphAutoFit layoutSignature={layoutSignature} />
        {partialIssues.length > 0 || unavailableRigs.length > 0 || psFailed ? (
          <Panel position="bottom-left" className="!m-3 max-w-md border border-outline-variant bg-background/90 px-2 py-1.5">
            {psFailed ? (
              <div data-testid="host-multi-rig-graph-stale" className="mb-1 font-mono text-[10px] text-error">
                Rig inventory refresh failed; showing the last successful list.
              </div>
            ) : null}
            <GraphPartialNotice issues={partialIssues} unavailable={unavailableRigs} />
          </Panel>
        ) : null}
        <Panel position="top-right" className="!m-3">
          <div className="flex items-center gap-1 border border-outline-variant bg-background/80 px-1.5 py-1 shadow-[2px_2px_0_rgba(46,52,46,0.10)] backdrop-blur-sm">
            <button
              type="button"
              data-testid="topology-expand-all-rigs"
              onClick={expandAllRigs}
              disabled={expandedCount === rigList.length}
              title="Expand all rigs"
              className="inline-flex h-7 items-center gap-1 border border-transparent px-2 font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface hover:border-outline-variant hover:bg-surface-lowest/70 hover:text-on-surface disabled:pointer-events-none disabled:opacity-35"
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              Expand all
            </button>
            <button
              type="button"
              data-testid="topology-collapse-all-rigs"
              onClick={collapseAllRigs}
              disabled={expandedCount === 0}
              title="Collapse all rigs"
              className="inline-flex h-7 items-center gap-1 border border-transparent px-2 font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface hover:border-outline-variant hover:bg-surface-lowest/70 hover:text-on-surface disabled:pointer-events-none disabled:opacity-35"
            >
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
              Collapse all
            </button>
          </div>
        </Panel>
        <Controls
          position="bottom-right"
          showInteractive={false}
          className="!bg-surface-lowest/40 !border !border-outline-variant"
        />
      </ReactFlow>
    </div>
  );
}

function HostGraphAutoFit({ layoutSignature }: { layoutSignature: string }) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    // OPR.0.4.2.17 — gate fitView on nodesInitialized (xyflow has MEASURED the
    // nodes), not a fixed 50ms timeout. On the 30s refetch the nodes re-measure;
    // the old 50ms fired before re-measurement and faithfully fit a
    // collapsed/unmeasured layout. When measurement completes nodesInitialized
    // flips true and this effect re-runs, fitting the real (distinct) layout.
    if (!layoutSignature || !nodesInitialized) return;
    if (lastSignatureRef.current === layoutSignature) return;
    lastSignatureRef.current = layoutSignature;
    void fitView({
      padding: HOST_GRAPH_FIT_PADDING,
      includeHiddenNodes: false,
      duration: 250,
    });
  }, [fitView, layoutSignature, nodesInitialized]);

  return null;
}
