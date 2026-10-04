// OPR.0.3.2.20 — For You priority windowing.
//
// useAttentionItems wraps the daemon attention read — the durable source
// of truth — so the For You Action-required + Approval lenses don't
// depend on the lossy ephemeral client event FIFO at
// `useActivityFeed.MAX_ACTIVITY_EVENTS=100`.
//
// OPR.0.4.4.15: when the operator has ≥1 remote host subscription enabled
// the hook polls GET /api/queue/attention-aggregate (the shared P4
// contract: items stamped with origin hostId + a per-host structured
// status array) — aggregation is DAEMON-SIDE; this hook still only ever
// talks to the local daemon (no bearer, no cross-origin — the FR-1
// negative AC). Zero-config keeps TODAY'S endpoint and wire untouched;
// the hook normalizes both paths to {items, hosts} (hosts empty on the
// legacy path).
//
// HG-8 freshness: react-query refetchOnWindowFocus is set to the
// string variant 'always' (NOT boolean `true`). With a non-trivial
// staleTime, boolean `true` is gated by the staleness predicate and
// can skip refetches inside the stale window (banked
// feedback_refetchOnWindowFocus_staleness_gated_use_always_string).
// 'always' bypasses the gate so the attention surface refreshes on
// every focus.

import { useQuery } from "@tanstack/react-query";
import { boundedJsonRead } from "../lib/bounded-json-read.js";
import { OperatorReadError } from "../lib/operator-read.js";

export interface AttentionQueueItem {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string[] | null;
  blockedOn: string | null;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  body: string;
  /** Plain-language title (queue summary column) when present. */
  summary?: string | null;
  /** OPR.0.4.4.20 FR-9 win #2 (Packet-1 C3): the judge-this pointer.
   *  Optional/defensive — absent on pre-P1 daemons. */
  evidenceRef?: string | null;
  /** OPR.0.4.4.15: origin host id on aggregated items ('local' or a
   *  registered host id). Absent on the legacy single-host path. */
  hostId?: string;
}

/** Mirror of the daemon fanout-contract PerHostStatus (closed enum). */
export interface AttentionHostStatus {
  hostId: string;
  status: "ok" | "unreachable" | "unsupported-transport" | "auth-failed";
  error?: string;
  failedStep?: string;
}

export interface AttentionData {
  items: AttentionQueueItem[];
  hosts: AttentionHostStatus[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nullableText(value: unknown): boolean {
  return value === null || typeof value === "string";
}
/** Validate the fields this legacy surface consumes without stripping newer
 * queue facts or closing extensible state/priority vocabularies. */
function isAttentionItem(value: unknown): value is AttentionQueueItem {
  if (!isRecord(value)) return false;
  return typeof value.qitemId === "string" && value.qitemId.length > 0
    && ["tsCreated", "tsUpdated", "sourceSession", "destinationSession", "state", "priority", "body"]
      .every(key => typeof value[key] === "string")
    && ["tier", "blockedOn", "handedOffTo", "handedOffFrom"].every(key => nullableText(value[key]))
    && (value.tags === null || (Array.isArray(value.tags) && value.tags.every(tag => typeof tag === "string")))
    && ["summary", "evidenceRef"].every(key => value[key] === undefined || nullableText(value[key]))
    && (value.hostId === undefined || (typeof value.hostId === "string" && value.hostId.length > 0));
}
function isHostStatus(value: unknown): value is AttentionHostStatus {
  return isRecord(value) && typeof value.hostId === "string" && value.hostId.length > 0
    && ["ok", "unreachable", "unsupported-transport", "auth-failed"].includes(value.status as string)
    && ["error", "failedStep"].every(key => value[key] === undefined || typeof value[key] === "string");
}

async function fetchAttentionItems(limit: number, signal: AbortSignal): Promise<AttentionQueueItem[]> {
  const params = new URLSearchParams({ attention: "1", limit: String(limit) });
  const payload = await boundedJsonRead<unknown>(`/api/queue/list?${params.toString()}`, { signal });
  if (!Array.isArray(payload) || !payload.every(isAttentionItem)) {
    throw new OperatorReadError("invalid_contract", "Attention list did not serve a valid queue-item array.");
  }
  return payload;
}

async function fetchAggregatedAttention(limit: number, signal: AbortSignal): Promise<AttentionData> {
  const payload = await boundedJsonRead<unknown>("/api/queue/attention-aggregate", { signal });
  if (!isRecord(payload) || !Array.isArray(payload.items) || !Array.isArray(payload.hosts)
    || !payload.items.every(value => isAttentionItem(value) && typeof value.hostId === "string")
    || !payload.hosts.every(isHostStatus)) {
    throw new OperatorReadError("invalid_contract", "Aggregated attention did not serve valid items and host statuses.");
  }
  // Preserve source host metadata, nullable/additive queue facts, and any
  // future envelope facts. The render limit never truncates host failures.
  return { ...payload, items: (payload.items as AttentionQueueItem[]).slice(0, limit), hosts: payload.hosts };
}

/**
 * Open attention-class qitems (tier="human-gate" OR destination is
 * human-CLASS via isHumanSeatSessionRef — human-seat
 * /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/ OR the A2 virtual-domain
 * leg <local>@external). State default
 * is pending|in-progress|blocked — closed/done items are NOT surfaced.
 *
 * `limit` (optional, default 50) caps the rendered set so a
 * pathological backlog can't unbounded-render. The attention set is
 * small by nature.
 *
 * `aggregated` (OPR.0.4.4.15): poll the consolidated multi-host read
 * instead of the single-host list. Callers pass true ONLY when a remote
 * host subscription is enabled — zero-config stays on the legacy wire.
 */
export function useAttentionItems(limit: number = 50, aggregated: boolean = false) {
  return useQuery<AttentionData>({
    queryKey: ["attention-items", limit, aggregated],
    queryFn: aggregated
      ? ({ signal }) => fetchAggregatedAttention(limit, signal)
      : async ({ signal }) => ({ items: await fetchAttentionItems(limit, signal), hosts: [] }),
    staleTime: 15_000,
    retry: false,
    // Mode and limit are separate facts, even under a global keepPreviousData default.
    placeholderData: undefined,
    // HG-8: 'always' (not `true`) — see file header comment.
    refetchOnWindowFocus: "always",
  });
}
