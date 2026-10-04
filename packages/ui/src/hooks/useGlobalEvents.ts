import { useEffect, useRef, useState } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { subscribeTopologyEventStatus, subscribeTopologyEvents } from "../lib/topology-events.js";

/** Connected-instance canonical query family (see lib/operator-read.ts). */
const OPERATOR_FAMILY = ["operator", "local-instance"] as const;
/** Canonical operator reads are heavier than the 150ms chrome keys: a burst
 * of activity collapses into at most one invalidation per window. */
export const OPERATOR_INVALIDATION_WINDOW_MS = 1_000;

/** Canonical families an activity event can change. Gateway, configuration
 * and project catalog reads have no activity events; they refresh on their
 * own poll and on reconnect. */
export function operatorFamiliesForEvent(type: string): Array<"attention" | "health"> {
  if (type.startsWith("queue.") || type.startsWith("proof.") || type.startsWith("workflow.")) return ["attention", "health"];
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
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const pendingInvalidations = new Set<string>();
    const cache = queryClient.getQueryCache();
    // Track actual query objects, rather than family promises: the same query
    // can match both a family window and an all-family reconnect window.
    const afterRead = new Set<Query>();
    const followups = new Map<Query, ReturnType<typeof setTimeout>>();
    const refetch = (query: Query) => {
      // An independently started focus/poll read also satisfies this refresh.
      // Never cancel that read or reset its transport deadline.
      void queryClient.refetchQueries({ queryKey: query.queryKey, exact: true, type: "active" }, { cancelRefetch: false });
    };
    const unsubscribeCache = cache.subscribe(event => {
      const query = event.query;
      if (event.type === "removed") {
        afterRead.delete(query);
        const timer = followups.get(query);
        if (timer !== undefined) clearTimeout(timer);
        followups.delete(query);
      } else if (event.type === "updated" && query.state.fetchStatus === "idle" && afterRead.delete(query)) {
        if (!query.isActive() || followups.has(query)) return;
        // Let settlement finish before starting a new read. Many events during
        // that read become exactly one follow-up; unmount can discard it.
        followups.set(query, setTimeout(() => {
          followups.delete(query);
          if (query.isActive() && cache.get(query.queryHash) === query) refetch(query);
        }, 0));
      }
    });
    const refreshOperatorQueries = (families: Set<"attention" | "health" | "all">) => {
      const affected = new Set<Query>();
      const prefixes = families.has("all") ? [[...OPERATOR_FAMILY]] : [...families].map(family => [...OPERATOR_FAMILY, family]);
      for (const queryKey of prefixes) for (const query of cache.findAll({ queryKey })) affected.add(query);
      for (const query of affected) {
        // Inactive/disabled entries become stale without issuing a request.
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "none" });
        if (!query.isActive() || followups.has(query)) continue;
        if (query.state.fetchStatus === "idle") refetch(query);
        else afterRead.add(query);
      }
    };
    // "all" = the whole connected-instance family (after a reconnect, any
    // canonical read may have missed events).
    const pendingOperator = new Set<"attention" | "health" | "all">();
    let operatorTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleOperator = (families: Array<"attention" | "health" | "all">) => {
      if (!families.length) return;
      for (const family of families) pendingOperator.add(family);
      if (operatorTimer) return;
      operatorTimer = setTimeout(() => {
        operatorTimer = null;
        refreshOperatorQueries(pendingOperator);
        pendingOperator.clear();
      }, OPERATOR_INVALIDATION_WINDOW_MS);
    };
    let everConnected = false;
    let lostConnection = false;

    const unsubscribeStatus = subscribeTopologyEventStatus(status => {
      setConnected(status.connected);
      if (status.connected) for (const key of ["review", "slices", "mission"]) void queryClient.invalidateQueries({ queryKey: [key] });
      // Refresh canonical reads only on a RE-connect: the first connection
      // follows the pages' own initial reads.
      if (status.connected) {
        if (everConnected && lostConnection) scheduleOperator(["all"]);
        everConnected = true;
        lostConnection = false;
      } else if (everConnected) {
        lostConnection = true;
      }
    });
    const unsubscribe = subscribeTopologyEvents((parsed) => {
      const { type, rigId } = parsed;
      if (!type) return;

      if (type.startsWith("proof.")) for (const key of ["review", "slices", "mission"]) void queryClient.invalidateQueries({ queryKey: [key] });
      scheduleOperator(operatorFamiliesForEvent(type));

      // Collect affected query keys
      if (type.startsWith("node.startup_") && rigId) {
        pendingInvalidations.add(`rig:${rigId}:nodes`);
      }
      if (type === "rig.created" || type === "rig.deleted" || type === "rig.stopped" ||
          type === "rig.imported" ||
          type === "bootstrap.completed" || type === "bootstrap.partial") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      if (type === "restore.completed") {
        // slice-04: ps + default-summary are AGGREGATE signals — queue them
        // REGARDLESS of rigId (matching the prior ActivityFeed aggregate
        // behavior). Only the rig-specific nodes key stays conditional on rigId.
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
        if (rigId) pendingInvalidations.add(`rig:${rigId}:nodes`);
      }
      // slice-04: useGlobalEvents (this one AppShell-mounted 150ms Set/timer) is
      // now the SOLE coalesced owner of the ps + default-summary invalidations
      // that ActivityFeed used to fire per-event. Rig-scoped graph/nodes/sessions
      // + discovery invalidations stay in ActivityFeed (distinct-key semantics).
      if (type === "node.claimed" && rigId) {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      if (type === "session.detached" || type === "node.removed" ||
          type === "pod.deleted" || type === "rig.expanded") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      // OPR.0.3.3.19 (AC-7): archive/unarchive move a rig between the default
      // view and the per-host Archive section. Refetch BOTH the default summary
      // AND the archived-only summary (a separate query key) plus ps, so a CLI
      // or other-browser archive/unarchive updates a mounted UI reactively
      // instead of going stale until manual reload.
      if (type === "rig.archived" || type === "rig.unarchived") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("rigs:summary:archived");
        pendingInvalidations.add("ps");
        if (rigId) pendingInvalidations.add(`rig:${rigId}:nodes`);
      }

      // Schedule flush
      if (debounceRef.current) return; // Already scheduled
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;

        // Flush all pending invalidations
        for (const key of pendingInvalidations) {
          if (["review", "slices", "mission"].includes(key)) {
            void queryClient.invalidateQueries({ queryKey: [key] });
          } else if (key === "rigs:summary") {
            queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
          } else if (key === "rigs:summary:archived") {
            // OPR.0.3.3.19: the Archive section's archived-only query (see
            // useArchivedRigs, queryKey ["rigs","summary","archived"]).
            // Invalidated explicitly so it refetches even though the broader
            // ["rigs","summary"] prefix invalidation would also cover it.
            queryClient.invalidateQueries({ queryKey: ["rigs", "summary", "archived"] });
          } else if (key === "ps") {
            queryClient.invalidateQueries({ queryKey: ["ps"] });
          } else if (key.startsWith("rig:")) {
            const parts = key.split(":");
            queryClient.invalidateQueries({ queryKey: ["rig", parts[1], parts[2]] });
          }
        }
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
      unsubscribeCache();
      afterRead.clear();
      for (const timer of followups.values()) clearTimeout(timer);
      followups.clear();
    };
  }, [queryClient]);
  return { connected };
}
