import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { isTopologyGraph, topologyRead } from "../lib/topology-read.js";
import { useSelectedHostId } from "./useHosts.js";

interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

export function useRigGraph(rigId: string) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["rig", rigId, "graph", hostId],
    queryFn: ({ signal }) => topologyRead<GraphData>(`/api/rigs/${encodeURIComponent(rigId)}/graph`, hostId, signal, isTopologyGraph),
    retry: false,
    enabled: !!rigId,
    refetchInterval: 30_000, // Refetch every 30s for context usage updates
    placeholderData: keepPreviousData,
  });
}
