import { useEffect, useRef, useState } from "react";
import { useSseQueryRefresh } from "../lib/sse-query-refresh.js";
import { subscribeTopologyEventStatus, subscribeTopologyEvents } from "../lib/topology-events.js";

/** Connected-instance canonical query family (see lib/operator-read.ts). */
const OPERATOR_FAMILY = ["operator", "local-instance"] as const;
/** Canonical operator reads are heavier than the 150ms chrome keys: a burst
 * of activity collapses into at most one invalidation per window. */
export const OPERATOR_INVALIDATION_WINDOW_MS = 1_000;

/** Canonical families an activity event can change. Project scopes and
 * execution consume queue/proof/workflow facts. Gateway and configuration
 * refresh on their own poll and on reconnect. */
export function operatorFamiliesForEvent(type: string): Array<"attention" | "health" | "projects"> {
  if (type.startsWith("queue.") || type.startsWith("proof.") || type.startsWith("workflow.")) return ["attention", "health", "projects"];
  if (type.startsWith("node.") || type.startsWith("session.") || type.startsWith("rig.") || type.startsWith("pod.")
    || type.startsWith("restore.") || type.startsWith("bootstrap.")) return ["attention", "health"];
  return [];
}

/**
 * Global event listener. Subscribes to the shared /api/events hub and
 * invalidates relevant queries when state-changing events arrive.
 * Mounted once in AppShell.
 */
export function useGlobalEvents(): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const refresh = useSseQueryRefresh();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const pendingInvalidations = new Map<string, { queryKey: readonly unknown[]; receipts: Set<object> }>();
    const mark = (queryKey: readonly unknown[], receipt: object) => {
      // IDs are opaque: never join/split them with a delimiter such as ':'.
      const key = JSON.stringify(queryKey);
      const pending = pendingInvalidations.get(key) ?? { queryKey, receipts: new Set<object>() };
      pending.receipts.add(receipt);
      pendingInvalidations.set(key, pending);
    };
    // "all" = the whole connected-instance family (after a reconnect, any
    // canonical read may have missed events).
    const pendingOperator = new Set<"attention" | "health" | "projects" | "all">();
    const operatorReceipts = new Set<object>();
    let operatorTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleOperator = (families: Array<"attention" | "health" | "projects" | "all">, receipt: object) => {
      if (!families.length) return;
      for (const family of families) pendingOperator.add(family);
      operatorReceipts.add(receipt);
      if (operatorTimer) return;
      operatorTimer = setTimeout(() => {
        operatorTimer = null;
        if (pendingOperator.has("all")) refresh([...OPERATOR_FAMILY], operatorReceipts);
        else for (const family of pendingOperator) refresh([...OPERATOR_FAMILY, family], operatorReceipts);
        operatorReceipts.clear();
        pendingOperator.clear();
      }, OPERATOR_INVALIDATION_WINDOW_MS);
    };
    let everConnected = false;
    let lostConnection = false;

    const unsubscribeStatus = subscribeTopologyEventStatus(status => {
      setConnected(status.connected);
      if (status.connected) for (const key of ["review", "slices", "mission"]) refresh([key], [status]);
      // Refresh canonical reads only on a RE-connect: the first connection
      // follows the pages' own initial reads.
      if (status.connected) {
        if (everConnected && lostConnection) scheduleOperator(["all"], status);
        everConnected = true;
        lostConnection = false;
      } else if (everConnected) {
        lostConnection = true;
      }
    });
    const unsubscribe = subscribeTopologyEvents((parsed) => {
      const { type, rigId } = parsed;
      if (!type) return;

      if (type.startsWith("proof.")) for (const key of ["review", "slices", "mission"]) refresh([key], [parsed]);
      scheduleOperator(operatorFamiliesForEvent(type), parsed);

      // Collect affected query keys
      if (type.startsWith("node.startup_") && rigId) {
        mark(["rig", rigId, "nodes"], parsed);
      }
      if (type === "rig.created" || type === "rig.deleted" || type === "rig.stopped" ||
          type === "rig.imported" ||
          type === "bootstrap.completed" || type === "bootstrap.partial") {
        mark(["rigs", "summary"], parsed);
        mark(["ps"], parsed);
      }
      if (type === "restore.completed") {
        // slice-04: ps + default-summary are AGGREGATE signals — queue them
        // REGARDLESS of rigId (matching the prior ActivityFeed aggregate
        // behavior). Only the rig-specific nodes key stays conditional on rigId.
        mark(["rigs", "summary"], parsed);
        mark(["ps"], parsed);
        if (rigId) mark(["rig", rigId, "nodes"], parsed);
      }
      // slice-04: useGlobalEvents (this one AppShell-mounted 150ms Set/timer) is
      // now the SOLE coalesced owner of the ps + default-summary invalidations
      // that ActivityFeed used to fire per-event. Rig-scoped graph/nodes/sessions
      // + discovery invalidations stay in ActivityFeed (distinct-key semantics).
      if (type === "node.claimed" && rigId) {
        mark(["rigs", "summary"], parsed);
        mark(["ps"], parsed);
      }
      if (type === "session.detached" || type === "node.removed" ||
          type === "pod.deleted" || type === "rig.expanded") {
        mark(["rigs", "summary"], parsed);
        mark(["ps"], parsed);
      }
      // OPR.0.3.3.19 (AC-7): archive/unarchive move a rig between the default
      // view and the per-host Archive section. Refetch BOTH the default summary
      // AND the archived-only summary (a separate query key) plus ps, so a CLI
      // or other-browser archive/unarchive updates a mounted UI reactively
      // instead of going stale until manual reload.
      if (type === "rig.archived" || type === "rig.unarchived") {
        mark(["rigs", "summary"], parsed);
        mark(["rigs", "summary", "archived"], parsed);
        mark(["ps"], parsed);
        if (rigId) mark(["rig", rigId, "nodes"], parsed);
      }

      // Schedule flush
      if (debounceRef.current) return; // Already scheduled
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;

        // Flush all pending invalidations
        for (const { queryKey, receipts } of pendingInvalidations.values()) refresh(queryKey, receipts);
        pendingInvalidations.clear();
      }, 150);
    });

    return () => {
      unsubscribe();
      unsubscribeStatus();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (operatorTimer) clearTimeout(operatorTimer);
    };
  }, [refresh]);
  return { connected };
}
