// Spatial-only projection of real queue traffic for the 3D topology.
//
// Subscribes to the shared local /api/events hub without changing it or the
// Graph's own edge-activity behavior. All truth rules live in
// lib/spatial-activity.ts; this hook only decides what counts as a live
// delivery and when to re-derive.
//
// Lifecycle rules:
//   - Local source only. A registered remote host (or a model that belongs to
//     a different source) never subscribes; it reports an honest reason and
//     clears everything previously observed.
//   - The hub replays its cached events synchronously on subscribe, and a
//     fresh/reconnected stream replays retained history. Neither is live:
//     replays during subscribe are history, and anything not stamped strictly
//     after the current connection's baseline is history (whole-second
//     stamps cannot separate replay from a same-second live event, so that
//     second is conservatively history). Remounting, reopening the
//     dock or a model refresh therefore cannot re-animate old traffic.
//   - Pulses stop while reduced motion, a hidden document, or an offline /
//     reconnecting stream; readable records remain.
//   - No interval. One bounded timeout runs only while a fresh pulse exists,
//     to retire it when it leaves the canonical freshness window; another
//     only while replayed history is waiting to be applied in a batch.

import { useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_HOST_ID } from "../lib/host-param.js";
import {
  SPATIAL_TRAFFIC_REMOTE_REASON,
  SPATIAL_TRAFFIC_SOURCE_MISMATCH_REASON,
  SPATIAL_TRAFFIC_UNSUPPORTED_REASON,
  isLiveDelivery,
  nextSpatialTrafficExpiry,
  parseSpatialTrafficEvent,
  projectSpatialTraffic,
  retainSpatialTraffic,
  type SpatialTrafficObservation,
  type SpatialTrafficRecord,
  type SpatialTrafficState,
} from "../lib/spatial-activity.js";
import type { SpatialModel } from "../lib/spatial-topology.js";
import { subscribeTopologyEventStatus, subscribeTopologyEvents } from "../lib/topology-events.js";

const EMPTY_OBSERVATIONS: readonly SpatialTrafficObservation[] = [];
const EMPTY_RECORDS: readonly SpatialTrafficRecord[] = [];
/** Replayed history is applied in batches of this window. */
const HISTORY_BATCH_MS = 100;

interface ObservationStore {
  scope: string | null;
  observations: readonly SpatialTrafficObservation[];
}

interface StreamStatus {
  scope: string | null;
  connected: boolean;
  reconnecting: boolean;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Keep the previous array when the ids are unchanged, so a re-derivation
 *  (expiry tick, model refresh) does not hand the renderer a "new" set. */
function useStableRecords(next: readonly SpatialTrafficRecord[]): readonly SpatialTrafficRecord[] {
  const ref = useRef<readonly SpatialTrafficRecord[]>(EMPTY_RECORDS);
  const prev = ref.current;
  const same = prev.length === next.length && prev.every((record, i) => {
    const other = next[i]!;
    return record.id === other.id && record.sourceKey === other.sourceKey && record.targetKey === other.targetKey;
  });
  if (!same) ref.current = next.length === 0 ? EMPTY_RECORDS : next;
  return ref.current;
}

export function useSpatialActivity(model: SpatialModel, sourceHost: string, reducedMotion: boolean): SpatialTrafficState {
  const local = sourceHost === LOCAL_HOST_ID;
  const sameSource = model.hostId === sourceHost;
  const supported = typeof EventSource !== "undefined";
  const streamScope = local && sameSource && supported ? sourceHost : null;
  const unavailableReason = !local
    ? SPATIAL_TRAFFIC_REMOTE_REASON
    : !sameSource
      ? SPATIAL_TRAFFIC_SOURCE_MISMATCH_REASON
      : !supported
        ? SPATIAL_TRAFFIC_UNSUPPORTED_REASON
        : null;

  const [store, setStore] = useState<ObservationStore>({ scope: null, observations: EMPTY_OBSERVATIONS });
  const [status, setStatus] = useState<StreamStatus>({ scope: null, connected: false, reconnecting: false });
  const [hidden, setHidden] = useState(documentHidden);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setHidden(documentHidden());
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (streamScope === null) {
      setStore({ scope: null, observations: EMPTY_OBSERVATIONS });
      setStatus({ scope: null, connected: false, reconnecting: false });
      return;
    }
    const scope = streamScope;
    let active = true;
    // Baseline of the current connection; null while not connected.
    let liveSince: number | null = null;
    let replaying = false;
    setStore({ scope, observations: EMPTY_OBSERVATIONS });

    const unsubscribeStatus = subscribeTopologyEventStatus((next) => {
      if (!active) return;
      if (next.connected && !next.reconnecting) {
        if (liveSince === null) liveSince = Date.now();
      } else {
        liveSince = null;
      }
      setStatus({ scope, connected: next.connected, reconnecting: next.reconnecting });
    });

    // A fresh stream can replay a long history; batch it so that costs one
    // render per window instead of one per event. Live deliveries flush now.
    let pending: SpatialTrafficObservation[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      const batch = pending;
      pending = [];
      if (!active || batch.length === 0) return;
      setStore((prev) => {
        const base = prev.scope === scope ? prev.observations : EMPTY_OBSERVATIONS;
        let next = base;
        for (const observation of batch) next = retainSpatialTraffic(next, observation);
        return prev.scope === scope && next === base ? prev : { scope, observations: next };
      });
      if (batch.some((observation) => observation.live)) setTick((value) => value + 1);
    };

    replaying = true;
    const unsubscribeEvents = subscribeTopologyEvents((event) => {
      if (!active) return;
      const parsed = parseSpatialTrafficEvent(scope, event);
      if (parsed.kind !== "traffic") return;
      const live = isLiveDelivery(parsed.observation.occurredAt, liveSince, replaying);
      pending.push({ ...parsed.observation, live });
      if (replaying) return;
      if (live) flush();
      else if (flushTimer === null) flushTimer = setTimeout(flush, HISTORY_BATCH_MS);
    });
    replaying = false;
    flush();

    return () => {
      active = false;
      if (flushTimer !== null) clearTimeout(flushTimer);
      pending = [];
      unsubscribeEvents();
      unsubscribeStatus();
    };
  }, [streamScope]);

  const observations = streamScope !== null && store.scope === streamScope ? store.observations : EMPTY_OBSERVATIONS;
  const connected = streamScope !== null && status.scope === streamScope && status.connected;
  const reconnecting = streamScope !== null && status.scope === streamScope && status.reconnecting;
  const suppressPulses = reducedMotion || hidden || !connected || reconnecting;

  // `tick` and `suppressPulses` force a re-derivation against the current
  // clock; freshness itself comes only from canonical event time.
  const projection = useMemo(
    () => projectSpatialTraffic(observations, model, sourceHost, Date.now()),
    [observations, model, sourceHost, tick, suppressPulses],
  );
  const records = useStableRecords(projection.records);
  const pulses = useStableRecords(suppressPulses ? EMPTY_RECORDS : projection.fresh);

  useEffect(() => {
    if (pulses.length === 0) return;
    const delay = nextSpatialTrafficExpiry(pulses, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => setTick((value) => value + 1), delay + 1);
    return () => clearTimeout(timer);
  }, [pulses, tick]);

  return useMemo<SpatialTrafficState>(
    () => ({
      records: streamScope === null ? EMPTY_RECORDS : records,
      pulses: streamScope === null ? EMPTY_RECORDS : pulses,
      connected,
      reconnecting,
      unavailableReason,
      unplacedCount: streamScope === null ? 0 : projection.unplacedCount,
    }),
    [streamScope, records, pulses, connected, reconnecting, unavailableReason, projection.unplacedCount],
  );
}
