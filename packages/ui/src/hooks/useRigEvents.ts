import { useEffect, useRef, useState, useCallback } from "react";
import { useSseQueryRefresh } from "../lib/sse-query-refresh.js";
import {
  subscribeTopologyEvents,
  subscribeTopologyEventStatus,
} from "../lib/topology-events.js";

const DEBOUNCE_MS = 100;

export interface UseRigEventsResult {
  connected: boolean;
  reconnecting: boolean;
}

export function useRigEvents(rigId: string | null): UseRigEventsResult {
  const refresh = useSseQueryRefresh(rigId);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const hasErroredRef = useRef(false);
  const receiptsRef = useRef(new Set<object>());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidateGraph = useCallback((receipt: object) => {
    if (!rigId) return;
    receiptsRef.current.add(receipt);
    if (debounceTimerRef.current) return;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      // Only invalidate the graph query; this matches previous behavior.
      refresh(["rig", rigId, "graph"], receiptsRef.current);
      receiptsRef.current.clear();
    }, DEBOUNCE_MS);
  }, [rigId, refresh]);

  useEffect(() => {
    if (!rigId) {
      setConnected(false);
      setReconnecting(false);
      return;
    }

    hasErroredRef.current = false;
    setConnected(false);
    setReconnecting(false);
    const unsubscribeStatus = subscribeTopologyEventStatus((status) => {
      setConnected(status.connected);
      setReconnecting(status.reconnecting);
      if (status.reconnecting) {
        hasErroredRef.current = true;
        return;
      }
      if (status.connected && hasErroredRef.current) {
        hasErroredRef.current = false;
        invalidateGraph(status);
      }
    });

    const unsubscribeEvents = subscribeTopologyEvents((event) => {
      if (event.rigId !== rigId) return;
      invalidateGraph(event);
    });

    return () => {
      unsubscribeEvents();
      unsubscribeStatus();
      receiptsRef.current.clear();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [rigId, invalidateGraph]);

  return { connected, reconnecting };
}
