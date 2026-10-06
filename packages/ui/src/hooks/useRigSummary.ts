import { useQuery } from "@tanstack/react-query";
import { isTopologyRigSummary, topologyRead } from "../lib/topology-read.js";
import { useSelectedHostId } from "./useHosts.js";

export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  hasServices?: boolean;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
  /** OPR.0.4.3.22 — rig-level lifecycle folded from per-node states
   *  (running / recoverable / stopped / degraded / attention_required). The
   *  daemon /api/rigs/summary route already enriches this; carried here so UI
   *  surfaces can choose the right operator action without a second round trip. */
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
}

export function useRigSummary() {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["rigs", "summary", hostId],
    queryFn: ({ signal }) => topologyRead<RigSummary[]>("/api/rigs/summary", hostId, signal, isTopologyRigSummary),
    // Shared with spatial observers: a hung read becomes an error after one
    // five-second attempt, including when this observer starts it first.
    retry: false,
    placeholderData: undefined,
  });
}
