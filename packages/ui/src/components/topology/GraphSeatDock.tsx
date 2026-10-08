// Tablet Graph: the live terminal of the agent tapped in the desktop graph,
// docked directly beneath the graph panel. The graph stays mounted (no route
// change), so its camera and rig expansion are kept; one dock per scope page,
// and tapping another agent switches it.
//
// Identity is exact: the tap carries the graph's own host, rig and served
// node id (plus its logical id), and the seat resolves from the spatial model
// of that rig — the same ["rig", id, "graph", host] read the graph drew,
// narrowed to the pod on a pod page — only when host, rig, node and logical
// id all match. The terminal is the 3D
// workspace's guarded SeatLiveTerminal with its own fresh detail read
// (pinned pane, fail-closed refresh, reconnect revalidation, shared cap):
// opening sends nothing, focuses no cmux surface and launches nothing; a
// stopped, remote or unverifiable seat shows the dock's refusal. Closing
// frees the socket; the seat keeps running. A host, scope or view change
// drops the dock, so it never outlives the graph it was opened from.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { useSpatialTopology } from "../../hooks/useSpatialTopology.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { spatialKey, type SpatialAgent, type SpatialScope } from "../../lib/spatial-topology.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import type { TopologyScope } from "../../lib/topology-location.js";
import { SeatLiveTerminal, useSeatDetailQuery } from "./spatial/SpatialAgentWorkspace.js";
// The guarded dock's frame/button styles (class-scoped; no three.js).
import "./spatial/spatial.css";
import { TopologyLink, topologyTarget, useKnownSelectedHost } from "./topology-navigation.js";

/** An agent tapped in a desktop graph, in that graph's exact identity. */
export interface GraphSeatSelection {
  hostId: string;
  rigId: string;
  /** The served graph node id (not a display name or a prefixed canvas id). */
  nodeId: string;
  logicalId: string;
}

/** Dock state for one scope page. `scopeKey` names the scope and view; any
 *  change of it, of the selected host or of `enabled` clears the dock. */
export function useGraphSeatDock(scopeKey: string, enabled: boolean) {
  const hostId = useSelectedHostId();
  const key = enabled ? `${hostId}\u0000${scopeKey}` : null;
  // reveal: bumped by every tap, so re-tapping the open seat reveals it again.
  const [state, setState] = useState<{ key: string; seat: GraphSeatSelection; reveal: number } | null>(null);
  if (state && state.key !== key) setState(null);
  const current = state && state.key === key && state.seat.hostId === hostId ? state : null;
  const open = useCallback((next: GraphSeatSelection) => {
    if (key) setState((prev) => ({ key, seat: next, reveal: (prev?.reveal ?? 0) + 1 }));
  }, [key]);
  const close = useCallback(() => setState(null), []);
  return { seat: current?.seat ?? null, reveal: current?.reveal ?? 0, open: key ? open : undefined, close };
}

export function GraphSeatDock({ seat, reveal, from, onClose }: {
  seat: GraphSeatSelection;
  /** Changes on every tap (including the open seat). */
  reveal: number;
  from: TopologyScope;
  onClose: () => void;
}) {
  // A pod page shows only that pod's seats: resolve through the same pod
  // narrowing (scopeRigToPod), so a seat moved to another pod detaches.
  const podName = from.kind === "pod" && from.rigId === seat.rigId ? from.podName : null;
  const spatialScope = useMemo<SpatialScope>(
    () => (podName !== null ? { kind: "pod", rigId: seat.rigId, podName } : { kind: "rig", rigId: seat.rigId }),
    [seat.rigId, podName],
  );
  const data = useSpatialTopology(spatialScope);
  const linkSource = useKnownSelectedHost();
  const reducedMotion = usePrefersReducedMotion();
  const candidate = data.model && data.hostId === seat.hostId
    ? data.model.agentsByKey.get(spatialKey(seat.hostId, seat.rigId, "agent", seat.nodeId)) ?? null
    : null;
  const agent = candidate && candidate.logicalId === seat.logicalId ? candidate : null;
  const pending = !agent && (data.status === "loading" || data.loadingRigIds.includes(seat.rigId));
  const seatKey = `${seat.hostId}|${seat.rigId}|${seat.nodeId}`;

  // Reveal the dock on every tap (open, switch, re-tap) by aligning its top
  // with the page scroller's (just below the top bar), so the terminal that
  // mounts after the read has room below; focus stays where it was, so no
  // soft keyboard opens.
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }, [seatKey, reveal, reducedMotion]);

  const seatTarget = topologyTarget({ scope: { kind: "seat", rigId: seat.rigId, logicalId: seat.logicalId }, sourceHost: linkSource });
  const name = agent?.displayName ?? seat.logicalId;
  const rigName = agent?.rigName ?? data.model?.rigs[0]?.rigName ?? seat.rigId;
  const pod = agent?.podNamespace ?? null;

  return (
    <section
      ref={ref}
      data-testid="graph-seat-dock"
      data-seat-key={seatKey}
      aria-label={`Terminal: ${name}`}
      // Reserve the stacked frame plus dock chrome while detail is pending,
      // so the explicit reveal can reach its final position before it mounts.
      className="shrink-0 scroll-mb-4 min-h-[calc(max(13rem,44svh)+6rem)] border-t border-outline-variant bg-background"
      // The dock's terminal ground normally comes from the 3D atelier theme.
      style={{ marginLeft: "var(--header-anchor-offset, 0px)", "--spatial-terminal-ground": "24 10% 4.5%" } as CSSProperties}
    >
      <header className="flex min-h-11 items-center gap-2 pl-4">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-mono text-[12px] font-bold text-on-surface">{name}</h3>
          <div className="truncate font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
            {rigName}{pod ? ` / ${pod}` : ""}
          </div>
        </div>
        {seatTarget ? (
          <TopologyLink target={seatTarget} from={from} data-testid="graph-seat-dock-details"
            className="inline-flex min-h-11 items-center px-3 font-mono text-[10px] uppercase tracking-[0.06em] text-on-surface hover:bg-surface-low/70">
            Seat details
          </TopologyLink>
        ) : null}
        <button type="button" aria-label="Close terminal" data-testid="graph-seat-dock-close" onClick={onClose}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center border-l border-outline-variant text-on-surface hover:bg-surface-low/70 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      {agent ? (
        <div className="pb-3">
          <DockTerminal key={seatKey} agent={agent} hostId={seat.hostId} />
        </div>
      ) : (
        <p data-testid="graph-seat-dock-unresolved" role="status" className="px-4 pb-3 font-mono text-[11px] text-on-surface-variant">
          {pending
            ? `Reading rig ${rigName}'s graph for this seat…`
            : `This seat is not in ${podName !== null ? `pod ${podName} of ` : ""}rig ${rigName}'s current graph; no terminal is attached.`}
        </p>
      )}
    </section>
  );
}

function DockTerminal({ agent, hostId }: { agent: SpatialAgent; hostId: string }) {
  const { detailKey, detailQuery } = useSeatDetailQuery(agent, hostId);
  return (
    <SeatLiveTerminal
      agent={agent}
      hostId={hostId}
      isRemote={hostId !== LOCAL_HOST_ID}
      detailKey={detailKey}
      detailQuery={detailQuery}
      layout="stacked"
    />
  );
}
