import { useQuery } from "@tanstack/react-query";
import { readPsEntries } from "../lib/fleet-inventory-reads.js";
import { useSelectedHostId } from "./useHosts.js";

export interface PsEntry {
  rigId: string;
  name: string;
  nodeCount: number;
  /** Process-alive count (legacy; unchanged semantics). */
  runningCount: number;
  /**
   * Slice 15 — terminal-active count: subset of nodes producing tmux
   * output within the silence window. Sourced from the daemon's
   * SeatActivityService. UI active stats (e.g., Dashboard "Active")
   * read this instead of runningCount.
   */
  activeCount?: number;
  /**
   * Slice 15 — has-work count: subset of nodes with at least one
   * pending qitem assigned to their canonical session name. Rendered
   * distinctly from activeCount (non-inference contract).
   */
  hasWorkCount?: number;
  status: "running" | "partial" | "stopped";
  /** OPR.0.4.3.22 — rig-level lifecycle folded from per-node states. The daemon
   *  /api/ps projection already populates this; carried here so surfaces can
   *  distinguish recoverable from plain stopped. */
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
  uptime: string | null;
  latestSnapshot: string | null;
}

export function usePsEntries() {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["ps", hostId],
    queryFn: ({ signal }) => readPsEntries(hostId, { signal }),
    retry: false,
    refetchInterval: 3_000,
    placeholderData: undefined,
  });
}
