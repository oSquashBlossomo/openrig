// Data hook for the topology "3D" view-mode.
//
// Reads the same sources as the 2D graph — the rig summary for the rig list
// and the daemon's /api/rigs/:id/graph per rig — under the SAME query keys, so
// switching Graph ⇄ 3D reuses the cache instead of refetching.
//
// Truthfulness rules:
//   - Explicitly override global placeholderData on every read. A previous
//     host/entity's payload is never evidence for the current selection.
//   - Failed refreshes omit prior payloads from the current model; the shared
//     cache still retains last-success data for other consumers.
//   - Graph fetches forward TanStack's AbortSignal, so leaving the 3D tab or
//     switching host/rig cancels in-flight reads instead of letting them pile
//     up.
//   - Host scope fetches at most MAX_SPATIAL_RIGS graphs; the remainder is
//     reported (truncatedRigCount), never silently dropped.

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { isTopologyGraph, isTopologyRigSummary, topologyRead } from "../lib/topology-read.js";
import { useSelectedHostId } from "./useHosts.js";
import type { RigSummary } from "./useRigSummary.js";
import {
  MAX_SPATIAL_RIGS,
  buildSpatialModel,
  parseSpatialRig,
  scopeRigToPod,
  spatialScopeKey,
  type SpatialModel,
  type SpatialRig,
  type SpatialScope,
} from "../lib/spatial-topology.js";

export const SPATIAL_GRAPH_REFETCH_MS = 30_000;

export interface SpatialRigError {
  rigId: string;
  rigName: string;
  message: string;
}

export interface SpatialTopologyState {
  hostId: string;
  scopeKey: string;
  /** loading: nothing truthful to show yet; error: no rig could be read;
   *  ready: model is current (possibly partial — see rigErrors/loadingRigIds). */
  status: "loading" | "error" | "ready";
  model: SpatialModel | null;
  rigErrors: SpatialRigError[];
  loadingRigIds: string[];
  /** Rigs in the summary that the host scope did not fetch (bounded work). */
  truncatedRigCount: number;
  /** Pod scope: the named pod does not exist in the rig's graph. */
  podMissing: boolean;
  errorMessage: string | null;
  isFetching: boolean;
  refetch: () => void;
}

interface RigTarget {
  id: string;
  name: string;
  nodeCount: number | null;
}

export function useSpatialTopology(scope: SpatialScope): SpatialTopologyState {
  const hostId = useSelectedHostId();
  const summary = useQuery({
    queryKey: ["rigs", "summary", hostId],
    queryFn: ({ signal }) => topologyRead<RigSummary[]>("/api/rigs/summary", hostId, signal, isTopologyRigSummary),
    placeholderData: undefined,
    retry: false,
  });
  // Guard shared cache entries too: they may have been written before this
  // observer's validating transport ran (or by an older client owner).
  const summaryMalformed = !summary.isPlaceholderData && summary.data !== undefined && !isTopologyRigSummary(summary.data);
  const summaryCurrent = summary.isPlaceholderData || summary.isError || summaryMalformed ? undefined : summary.data;
  const scopeKey = spatialScopeKey(scope);

  const { targets, truncatedRigCount } = useMemo((): { targets: RigTarget[]; truncatedRigCount: number } => {
    if (scope.kind !== "host") {
      const match = summaryCurrent?.find((r) => r.id === scope.rigId);
      return {
        targets: [{ id: scope.rigId, name: match?.name ?? scope.rigId, nodeCount: match?.nodeCount ?? null }],
        truncatedRigCount: 0,
      };
    }
    if (!summaryCurrent) return { targets: [], truncatedRigCount: 0 };
    const all = summaryCurrent.filter((r) => typeof r.id === "string" && r.id.length > 0);
    return {
      targets: all.slice(0, MAX_SPATIAL_RIGS).map((r) => ({ id: r.id, name: r.name ?? r.id, nodeCount: r.nodeCount ?? null })),
      truncatedRigCount: Math.max(0, all.length - MAX_SPATIAL_RIGS),
    };
    // scope fields are folded into scopeKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, summaryCurrent]);

  const graphQueries = useQueries({
    queries: targets.map((rig) => ({
      queryKey: ["rig", rig.id, "graph", hostId] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => topologyRead<unknown>(`/api/rigs/${encodeURIComponent(rig.id)}/graph`, hostId, signal, isTopologyGraph),
      placeholderData: undefined,
      retry: false,
      refetchInterval: SPATIAL_GRAPH_REFETCH_MS,
      staleTime: 5_000,
    })),
    // TanStack structurally shares combined results. Track data itself as well
    // as timestamps: two successful cache writes can share the same millisecond.
    // Exclude fetching-only changes from the model input to keep scene identity
    // stable while an unchanged graph refresh is in flight.
    combine: queries => ({
      inputs: queries.map(q => ({ data: q.data, error: q.error, isError: q.isError,
        isPlaceholderData: q.isPlaceholderData, dataUpdatedAt: q.dataUpdatedAt, errorUpdatedAt: q.errorUpdatedAt })),
      isFetching: queries.some(q => q.isFetching),
      refetches: queries.map(q => q.refetch),
    }),
  });

  const targetsStamp = targets.map((t) => `${t.id}\u0000${t.name}\u0000${t.nodeCount ?? ""}`).join("|");

  const derived = useMemo(() => {
    const rigs: SpatialRig[] = [];
    const rigErrors: SpatialRigError[] = [];
    const loadingRigIds: string[] = [];
    targets.forEach((target, index) => {
      const query = graphQueries.inputs[index];
      if (!query) return;
      if (query.isError) {
        rigErrors.push({
          rigId: target.id,
          rigName: target.name,
          message: query.error instanceof Error ? query.error.message : "graph unavailable",
        });
      } else if (!query.isPlaceholderData && query.data !== undefined) {
        if (!isTopologyGraph(query.data)) {
          rigErrors.push({ rigId: target.id, rigName: target.name, message: "Invalid topology graph payload." });
        } else {
          rigs.push(parseSpatialRig(hostId, {
            rigId: target.id,
            rigName: target.name,
            summaryNodeCount: target.nodeCount,
            graph: query.data,
          }));
        }
      } else {
        loadingRigIds.push(target.id);
      }
    });

    let podMissing = false;
    let scopedRigs = rigs;
    if (scope.kind === "pod" && rigs[0]) {
      const narrowed = scopeRigToPod(rigs[0], scope.podName);
      podMissing = narrowed === null;
      scopedRigs = narrowed ? [narrowed] : [];
    }
    return { rigs: scopedRigs, rigErrors, loadingRigIds, podMissing };
    // Target fields are represented by their stamp; query inputs retain data identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, scopeKey, targetsStamp, graphQueries.inputs]);

  const model = useMemo(
    () => buildSpatialModel(hostId, derived.rigs),
    [hostId, derived.rigs],
  );

  const summaryPending = scope.kind === "host" && summaryCurrent === undefined && !summary.isError && !summaryMalformed;
  let status: SpatialTopologyState["status"];
  let errorMessage: string | null = null;
  if (scope.kind === "host" && (summary.isError || summaryMalformed)) {
    status = "error";
    errorMessage = summary.error instanceof Error ? summary.error.message : summaryMalformed ? "Invalid topology rig summary payload." : "rig summary unavailable";
  } else if (summaryPending) {
    status = "loading";
  } else if (targets.length > 0 && derived.rigs.length === 0 && derived.loadingRigIds.length > 0) {
    status = "loading";
  } else if (targets.length > 0 && derived.rigErrors.length === targets.length) {
    status = "error";
    errorMessage = derived.rigErrors[0]?.message ?? "graph unavailable";
  } else {
    status = "ready";
  }

  const isFetching = summary.isFetching || graphQueries.isFetching;

  return {
    hostId,
    scopeKey,
    status,
    model: status === "ready" ? model : null,
    rigErrors: derived.rigErrors,
    loadingRigIds: derived.loadingRigIds,
    truncatedRigCount,
    podMissing: derived.podMissing,
    errorMessage,
    isFetching,
    refetch: () => {
      void summary.refetch();
      for (const refetch of graphQueries.refetches) void refetch();
    },
  };
}
