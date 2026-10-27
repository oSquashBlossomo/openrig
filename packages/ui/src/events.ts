// One EventSource for the whole app. Keeps a bounded ring of recent events for
// the Activity page and tells react-query to refetch when anything changes.
import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";

export type RigEvent = { seq: number; type: string; rigId?: string; createdAt?: string; [k: string]: unknown };

const RING = 400;
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  const invalidate = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      for (const key of ["ps", "nodes", "attention"]) void qc.invalidateQueries({ queryKey: [key] });
    }, 500);
  };
  source.onopen = () => { connected = true; emit(); invalidate(); };
  source.onerror = () => { if (connected) { connected = false; emit(); } };
  source.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data) as RigEvent;
      if (events.length && events[events.length - 1]!.seq >= ev.seq) return;
      events = events.length >= RING ? [...events.slice(events.length - RING + 1), ev] : [...events, ev];
      emit();
      invalidate();
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
