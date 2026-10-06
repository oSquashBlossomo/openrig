// Spatial activity — a pure, spatial-only projection of durable queue events
// onto the 3D topology. Nothing here touches the Graph's shared activity
// behavior, the event hub, or three.js; useSpatialActivity owns the
// subscription and this module owns every truth rule, so both are testable
// without a browser.
//
// Truth rules (load-bearing; see docs/plans/spatial-redesign-terminal-contract.md):
//   - Only three durable event types carry two exact endpoints, and each keeps
//     its own honest meaning. None of them proves the receiver read, consumed
//     or answered anything:
//       queue.created          sourceSession       → destinationSession
//       queue.handed_off       fromSession         → toSession
//       qitem.fallback_routed  originalDestination → rerouteDestination
//     (for a reroute the "from" end is the old destination, not a sender).
//     queue.updated is a closure/transition, chat.message has no destination,
//     and agent/terminal activity is single-seat: none of them become arcs.
//   - Identity is source + safe event seq. Time is the served canonical
//     createdAt (exactInstant), never arrival, replay or subscription time.
//     A missing/invalid seq, timestamp or endpoint is rejected outright.
//   - Endpoints resolve by exact, unique canonical session name within the
//     current model for the same source. No case-folding, address rebuilding
//     or label/directory inference; an ambiguous or unknown endpoint is
//     counted as unplaced, never guessed.
//   - Retained history is bounded. Pulses are bounded, short-lived, and only
//     for observations that arrived live (not as replay), whose canonical
//     time is strictly after the connection baseline, and inside the
//     declared freshness window.

import { exactInstant } from "./display-time.js";
import type { SpatialAgent, SpatialModel } from "./spatial-topology.js";

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

export interface SpatialTrafficRecord {
  id: string;
  sourceKey: string;
  targetKey: string;
  type: string;
  label: string;
  /** Canonical event time, epoch ms (served createdAt). */
  occurredAt: number;
  qitemId?: string;
}

export interface SpatialTrafficState {
  /** Readable history, newest first, bounded. Includes replayed history. */
  records: readonly SpatialTrafficRecord[];
  /** Records that may animate right now. Empty while hidden, reduced motion,
   *  disconnected/reconnecting, or when nothing fresh arrived live. */
  pulses: readonly SpatialTrafficRecord[];
  connected: boolean;
  reconnecting: boolean;
  /** Why live traffic cannot be shown at all for this view, else null. */
  unavailableReason: string | null;
  /** Retained traffic events that touch this view but have an endpoint that
   *  is not exactly and uniquely placed in it. */
  unplacedCount: number;
}

// ---------------------------------------------------------------------------
// Declared bounds
// ---------------------------------------------------------------------------

/** Canonical-time window inside which a live event may pulse. */
export const SPATIAL_TRAFFIC_FRESH_MS = 12_000;
/** A canonical time this far ahead of the browser clock cannot be "just now". */
export const SPATIAL_TRAFFIC_FUTURE_SKEW_MS = 2_000;
/** Traffic observations retained (resolved or not) for dedupe/history. */
export const MAX_SPATIAL_TRAFFIC_OBSERVATIONS = 200;
/** Placed records exposed as readable history. */
export const MAX_SPATIAL_TRAFFIC_RECORDS = 50;
/** Concurrent pulses (after coalescing per directed pair). */
export const MAX_SPATIAL_TRAFFIC_PULSES = 6;

export const SPATIAL_TRAFFIC_TYPES = ["queue.created", "queue.handed_off", "qitem.fallback_routed"] as const;
export type SpatialTrafficType = (typeof SPATIAL_TRAFFIC_TYPES)[number];

/** Operator-facing meaning per type. Explicit that queue records are not
 *  reading, consumption or response. */
export const SPATIAL_TRAFFIC_MEANINGS: Readonly<Record<SpatialTrafficType, string>> = {
  "queue.created": "Work was queued and addressed to the destination. This is a queue record, not evidence it was read or acted on.",
  "queue.handed_off": "A queue item was recorded as handed off to the destination. This is a handoff record, not evidence it was read or acted on.",
  "qitem.fallback_routed": "A queue item was rerouted from its original destination to a fallback seat. The original destination is not the sender.",
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface SpatialTrafficObservation {
  /** Opaque source + seq identity; never split. */
  id: string;
  sourceHost: string;
  seq: number;
  type: SpatialTrafficType;
  fromSession: string;
  toSession: string;
  occurredAt: number;
  qitemId?: string;
  /** Arrived after the live baseline as a live delivery (not hub/stream replay). */
  live: boolean;
}

export type SpatialTrafficParse =
  | { kind: "traffic"; observation: Omit<SpatialTrafficObservation, "live"> }
  | { kind: "ignored" }
  | { kind: "invalid"; reason: string };

const ENDPOINT_FIELDS: Readonly<Record<SpatialTrafficType, readonly [string, string]>> = {
  "queue.created": ["sourceSession", "destinationSession"],
  "queue.handed_off": ["fromSession", "toSession"],
  "qitem.fallback_routed": ["originalDestination", "rerouteDestination"],
};

function isTrafficType(type: unknown): type is SpatialTrafficType {
  return typeof type === "string" && (SPATIAL_TRAFFIC_TYPES as readonly string[]).includes(type);
}

function endpoint(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function spatialTrafficId(sourceHost: string, seq: number): string {
  return JSON.stringify([sourceHost, seq]);
}

/** Canonical served createdAt → epoch ms, or null when not an exact instant. */
export function canonicalEventTime(createdAt: unknown): number | null {
  const stamp = exactInstant(createdAt);
  if (stamp === null) return null;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse one /api/events payload (flat: event fields + seq + createdAt). */
export function parseSpatialTrafficEvent(sourceHost: string, raw: unknown): SpatialTrafficParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "ignored" };
  const event = raw as Record<string, unknown>;
  if (!isTrafficType(event.type)) return { kind: "ignored" };
  const type = event.type;
  const seq = event.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return { kind: "invalid", reason: "missing or unsafe seq" };
  const occurredAt = canonicalEventTime(event.createdAt);
  if (occurredAt === null) return { kind: "invalid", reason: "missing or non-canonical createdAt" };
  const [fromField, toField] = ENDPOINT_FIELDS[type];
  const fromSession = endpoint(event[fromField]);
  const toSession = endpoint(event[toField]);
  if (!fromSession || !toSession) return { kind: "invalid", reason: "missing endpoint" };
  const qitemId = endpoint(event.qitemId);
  return {
    kind: "traffic",
    observation: {
      id: spatialTrafficId(sourceHost, seq),
      sourceHost,
      seq,
      type,
      fromSession,
      toSession,
      occurredAt,
      ...(qitemId ? { qitemId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Bounded, deduplicated retention
// ---------------------------------------------------------------------------

/** Insert into a seq-ascending, bounded list. Returns the same array when the
 *  observation is a duplicate (same id) or older than everything a full list
 *  retains — so an evicted event replayed later cannot re-enter. The first
 *  delivery wins: replayed history can never be upgraded to live. */
export function retainSpatialTraffic(
  current: readonly SpatialTrafficObservation[],
  next: SpatialTrafficObservation,
  max: number = MAX_SPATIAL_TRAFFIC_OBSERVATIONS,
): readonly SpatialTrafficObservation[] {
  if (current.some((o) => o.id === next.id)) return current;
  if (current.length >= max && current.length > 0 && next.seq < current[0]!.seq) return current;
  let index = current.length;
  while (index > 0 && current[index - 1]!.seq > next.seq) index -= 1;
  const merged = [...current.slice(0, index), next, ...current.slice(index)];
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/** May this observation pulse at `now`? Live delivery and canonical time in
 *  the freshness window are both required. */
export function isSpatialTrafficFresh(observation: SpatialTrafficObservation, now: number): boolean {
  if (!observation.live) return false;
  const age = now - observation.occurredAt;
  return age <= SPATIAL_TRAFFIC_FRESH_MS && age >= -SPATIAL_TRAFFIC_FUTURE_SKEW_MS;
}

/** Live delivery rule: not a synchronous hub replay, a connection baseline
 *  exists, and the canonical time is STRICTLY after that baseline.
 *
 *  SQLite datetime('now') floors to whole seconds, so a stamp only bounds the
 *  true time from below. A stream (re)connect replays rows persisted before
 *  it, and those can carry the same or an earlier second than the baseline;
 *  nothing in the payload separates them from a genuine event in that
 *  second. Only `occurredAt > liveSince` proves the row was written after
 *  the baseline. Genuine events within the baseline's own second therefore
 *  stay history: losing them is preferred to animating replay as fresh. */
export function isLiveDelivery(occurredAt: number, liveSince: number | null, replaying: boolean): boolean {
  return !replaying && liveSince !== null && occurredAt > liveSince;
}

/** Ms until the soonest of these (currently fresh) pulses leaves the window,
 *  or null when there are none — so no timer needs to run while idle. */
export function nextSpatialTrafficExpiry(fresh: readonly Pick<SpatialTrafficRecord, "occurredAt">[], now: number): number | null {
  let soonest: number | null = null;
  for (const record of fresh) {
    const remaining = record.occurredAt + SPATIAL_TRAFFIC_FRESH_MS - now;
    if (soonest === null || remaining < soonest) soonest = remaining;
  }
  return soonest === null ? null : Math.max(0, soonest);
}

// ---------------------------------------------------------------------------
// Projection onto the current model
// ---------------------------------------------------------------------------

export type SpatialSessionIndex = ReadonlyMap<string, readonly SpatialAgent[]>;

/** Exact canonical session → agents, for the model's own host only. */
export function indexSpatialSessions(model: SpatialModel): SpatialSessionIndex {
  const index = new Map<string, SpatialAgent[]>();
  for (const agent of model.agentsByKey.values()) {
    const session = agent.canonicalSessionName;
    if (!session) continue;
    const list = index.get(session);
    if (list) list.push(agent);
    else index.set(session, [agent]);
  }
  return index;
}

type Resolution = { kind: "placed"; agent: SpatialAgent } | { kind: "ambiguous" } | { kind: "absent" };

function resolve(index: SpatialSessionIndex, session: string): Resolution {
  const matches = index.get(session);
  if (!matches || matches.length === 0) return { kind: "absent" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "placed", agent: matches[0]! };
}

export function spatialTrafficLabel(type: SpatialTrafficType, fromSession: string, toSession: string): string {
  switch (type) {
    case "queue.created":
      return `Queued for ${toSession} by ${fromSession} (queue record, not a read receipt)`;
    case "queue.handed_off":
      return `Handed off ${fromSession} → ${toSession} (handoff record, not a read receipt)`;
    case "qitem.fallback_routed":
      return `Rerouted from ${fromSession} to fallback ${toSession} (original destination, not sender)`;
  }
}

export interface SpatialTrafficProjection {
  records: SpatialTrafficRecord[];
  /** Fresh, live, placed, non-self records, coalesced per directed pair. */
  fresh: SpatialTrafficRecord[];
  unplacedCount: number;
}

/** Project retained observations onto the current model. Re-running this on
 *  a refreshed model never changes freshness: that is canonical-time based. */
export function projectSpatialTraffic(
  observations: readonly SpatialTrafficObservation[],
  model: SpatialModel,
  sourceHost: string,
  now: number,
): SpatialTrafficProjection {
  if (model.hostId !== sourceHost) return { records: [], fresh: [], unplacedCount: 0 };
  const index = indexSpatialSessions(model);
  const records: SpatialTrafficRecord[] = [];
  const fresh: SpatialTrafficRecord[] = [];
  const pulsedPairs = new Set<string>();
  let unplacedCount = 0;
  // Newest first by canonical seq order.
  for (let i = observations.length - 1; i >= 0; i -= 1) {
    const observation = observations[i]!;
    if (observation.sourceHost !== sourceHost) continue;
    const from = resolve(index, observation.fromSession);
    const to = resolve(index, observation.toSession);
    if (from.kind !== "placed" || to.kind !== "placed") {
      // Only events that touch this view count; an event between seats that
      // are wholly outside it (another rig/scope) is not "unplaced" here.
      if (from.kind !== "absent" || to.kind !== "absent") unplacedCount += 1;
      continue;
    }
    const record: SpatialTrafficRecord = {
      id: observation.id,
      sourceKey: from.agent.key,
      targetKey: to.agent.key,
      type: observation.type,
      label: spatialTrafficLabel(observation.type, observation.fromSession, observation.toSession),
      occurredAt: observation.occurredAt,
      ...(observation.qitemId ? { qitemId: observation.qitemId } : {}),
    };
    if (records.length < MAX_SPATIAL_TRAFFIC_RECORDS) records.push(record);
    if (record.sourceKey === record.targetKey || !isSpatialTrafficFresh(observation, now)) continue;
    const pair = JSON.stringify([record.sourceKey, record.targetKey]);
    if (pulsedPairs.has(pair) || fresh.length >= MAX_SPATIAL_TRAFFIC_PULSES) continue;
    pulsedPairs.add(pair);
    fresh.push(record);
  }
  return { records, fresh, unplacedCount };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export const SPATIAL_TRAFFIC_REMOTE_REASON =
  "Live message traffic is only streamed for this daemon's local seats. A registered remote host does not expose its event stream here; structural links are still shown.";
export const SPATIAL_TRAFFIC_SOURCE_MISMATCH_REASON =
  "The loaded scene belongs to a different source than the one selected, so live traffic is paused until it matches.";
export const SPATIAL_TRAFFIC_UNSUPPORTED_REASON =
  "This browser cannot open the live event stream, so message traffic is unavailable.";
