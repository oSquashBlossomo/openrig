// OPR.0.4.6.WF4 (C3) — the PRIMARY workflow liveness feed (arch Q5-P1).
//
// Workflow queries invalidate off `/api/workflow/sse` (the daemon streams the
// workflow.* event kinds with seq ids; EventSource resumes via Last-Event-ID
// on reconnect). Refetch is SSE-invalidation-driven with a debounce FLOOR — no
// fixed-rate tight polling (the FS-1 enablement constraint honored at birth).
//
// Q5-P1 NAMED NEGATIVE (binding): workflow.* events persist rig_id=NULL
// (event-bus stores NULL; /api/events?rigId=X filters them OUT). So a
// rig-SCOPED subscription silently drops the ENTIRE workflow spine. This feed
// is therefore UNSCOPED BY CONTRACT — WORKFLOW_SSE_URL carries NO `?rigId=`,
// ever (asserted in useWorkflowSse.test.ts + the source grep-negative).
//
// Q5-P2: exception/gate ITEM liveness (the FR-3 attention rows) rides QUEUE
// events + the review band's existing refetch — NOT this feed (workflow.*
// events carry no item state). This hook invalidates only the ["workflow"]
// query family (instances / show / trace / specs / revision / operation).

import { useEffect, useRef } from "react";
import { useSseQueryRefresh } from "../lib/sse-query-refresh.js";
import { LOCAL_OPERATOR_INSTANCE, operatorScopeState, type OperatorInstanceScope } from "../lib/operator-read.js";

/** The workflow SSE endpoint — UNSCOPED by contract (Q5-P1): never `?rigId=`. */
export const WORKFLOW_SSE_URL = "/api/workflow/sse";

/** Debounce floor for invalidation flushes (matches the global hub's 150ms). */
const INVALIDATE_FLOOR_MS = 150;

// Refcounted singleton so N mounted consumers share ONE connection (the
// shipped topology-events hub pattern), rather than opening a stream per hook.
let eventSource: EventSource | null = null;
let refCount = 0;
const listeners = new Set<(receipt: object) => void>();

/** One fresh receipt per delivered stream occurrence, shared by every mounted
 *  consumer so the refresh owner coalesces it into one read. */
function deliver(): void {
  const receipt = {};
  for (const l of [...listeners]) l(receipt);
}

function ensureConnected(): void {
  if (eventSource || typeof EventSource === "undefined") return;
  // NO `?rigId=` — the Q5-P1 rig-unscoped contract (see file header).
  const es = new EventSource(WORKFLOW_SSE_URL);
  eventSource = es;
  // Canonical readback on every open (first handshake AND browser reconnect):
  // a workflow query may have settled before the stream attached, and a
  // reconnect without a prior event id has no replay to resume from. This is
  // the same debounced ["workflow"] GET refresh an event triggers — read-only,
  // never a mutation.
  es.addEventListener("open", deliver);
  es.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (typeof data !== "string") return;
    // The stream is workflow-filtered server-side; a well-formed event means
    // some instance/trail changed → invalidate. Skip heartbeats / non-JSON.
    try {
      JSON.parse(data);
    } catch {
      return;
    }
    deliver();
  });
}

function releaseIfIdle(): void {
  if (refCount > 0 || listeners.size > 0) return;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

/** Mount once (or a few times) at the workflow surfaces: subscribes to the
 *  primary workflow SSE feed and invalidates the ["workflow"] query family on
 *  every workflow.* event and every stream open/reopen, debounced to the floor. */
export function useWorkflowSse(scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const refresh = useSseQueryRefresh(scope.kind === "remote-instance" ? `remote-instance:${scope.hostId}` : "local-instance");
  const receiptsRef = useRef(new Set<object>());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeState = operatorScopeState(scope);

  useEffect(() => {
    if (!scopeState.scopeSupported) return;
    const onEvent = (receipt: object) => {
      receiptsRef.current.add(receipt);
      if (debounceRef.current) return; // a flush is already scheduled
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refresh(["workflow"], receiptsRef.current);
        receiptsRef.current.clear();
      }, INVALIDATE_FLOOR_MS);
    };
    listeners.add(onEvent);
    refCount += 1;
    ensureConnected();
    return () => {
      listeners.delete(onEvent);
      refCount -= 1;
      receiptsRef.current.clear();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      releaseIfIdle();
    };
  }, [refresh, scopeState.scopeSupported]);
  return scopeState;
}

export const __test_internals = {
  WORKFLOW_SSE_URL,
  INVALIDATE_FLOOR_MS,
  reset() {
    if (eventSource) eventSource.close();
    eventSource = null;
    refCount = 0;
    listeners.clear();
  },
};
