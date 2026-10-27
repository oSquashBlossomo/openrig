// One EventSource for the whole app. Keeps a bounded ring of recent events for
// the Activity page and tells react-query to refetch when anything changes.
import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";

export type RigEvent = { seq: number; type: string; rigId?: string; createdAt?: string; [k: string]: unknown };

const RING = 400;
const REFRESH_MS = 4000;
/** Event families that change the fleet or attention pages; snapshots and transcript chatter do not. */
export const REFRESH_TYPES = /^(rig|node|session|restore|bootstrap|seat|pod|health|queue|attention)\./;
let events: RigEvent[] = [];
let connected = false;
let source: EventSource | null = null;
const listeners = new Set<() => void>();
let snapshot = { events, connected };

function emit() {
  snapshot = { events, connected };
  for (const l of listeners) l();
}

export function startEvents(qc: QueryClient): () => void {
  if (source) return () => {};
  source = new EventSource("/api/events?replay=80");
  // A busy fleet emits several events a second. Refetch at most once every
  // REFRESH_MS, only for events that change what the pages show, and never
  // cancel a fetch already in flight (that is what floods the connection pool).
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const invalidate = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      for (const key of ["ps", "nodes", "attention"]) void qc.invalidateQueries({ queryKey: [key] }, { cancelRefetch: false });
    }, Math.max(0, last + REFRESH_MS - Date.now()));
  };
  source.onopen = () => { connected = true; emit(); invalidate(); };
  source.onerror = () => { if (connected) { connected = false; emit(); } };
  source.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data) as RigEvent;
      if (events.length && events[events.length - 1]!.seq >= ev.seq) return;
      events = events.length >= RING ? [...events.slice(events.length - RING + 1), ev] : [...events, ev];
      emit();
      if (REFRESH_TYPES.test(ev.type)) invalidate();
    } catch { /* ignore malformed */ }
  };
  return () => { source?.close(); source = null; connected = false; emit(); };
}

export function useEvents() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => snapshot,
    () => snapshot,
  );
}
