import { useQuery } from "@tanstack/react-query";
import { OperatorReadError } from "../lib/operator-read.js";
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
    queryFn: ({ signal }) => {
      if (!rigId.trim()) throw new OperatorReadError("invalid_request", "Choose an exact rig before reading its graph.");
      return topologyRead<GraphData>(`/api/rigs/${encodeURIComponent(rigId)}/graph`, hostId, signal, isTopologyGraph);
    },
    retry: false,
    enabled: !!rigId.trim(),
    refetchInterval: 30_000, // Refetch every 30s for context usage updates
    placeholderData: undefined,
  });
}
