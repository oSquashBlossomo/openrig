import { useQuery } from "@tanstack/react-query";
import { hasShape, isText, optional, nullable } from "../lib/operator-read.js";
import { readNeedsInputSeats, type NeedsInputNode, type NeedsInputRead } from "../lib/needs-input-read.js";

export interface NeedsInputSeatEntry {
  logicalId: string;
  sessionName?: string | null;
  source: string;
  eventAt?: string | null;
  sampledAt?: string;
  rigId?: string;
  /** Original served facts retained for source/identity explanation. */
  node?: NeedsInputNode;
}

const QUERY_KEY = ["needs-input-seats"] as const;
export function useNeedsInputSeats() {
  const query = useQuery<NeedsInputRead>({
    queryKey: QUERY_KEY,
    queryFn: ({ signal, client }) => readNeedsInputSeats({ signal,
      startAfterRigId: client.getQueryData<NeedsInputRead>(QUERY_KEY)?.nextStartAfterRigId }),
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: false,
    placeholderData: undefined,
  });
  // A live QueryClient can still hold the pre-envelope array after a source
  // update. Keep valid same-key rows as stale evidence, without inventing
  // coverage or crashing while the first new read is pending.
  const legacySeats: NeedsInputSeatEntry[] | undefined = Array.isArray(query.data)
    && query.data.every((value): value is NeedsInputSeatEntry => hasShape(value, {
      logicalId: v => typeof v === "string" && v.length > 0, source: isText,
      rigId: optional(isText), sessionName: optional(nullable(isText)),
      eventAt: optional(nullable(isText)), sampledAt: optional(isText),
    })) ? query.data : undefined;
  const snapshot = Array.isArray(query.data) ? undefined : query.data;
  const readState = query.error ? (snapshot || legacySeats ? "stale" : "unavailable") : legacySeats ? "stale" : !snapshot ? "pending"
    : snapshot.coverage.complete ? "ready"
    : snapshot.sources.some(s => s.state === "available" || (s.state === "partial" && s.nodes.length > 0)) ? "partial" : "unavailable";
  // The existing Feed API remains an array. The shared query cache holds the
  // typed read snapshot; consumers must consult readState/coverage before
  // treating an empty array or retained cache as current negative evidence.
  return { ...query, data: snapshot?.seats ?? legacySeats, readState,
    coverage: snapshot?.coverage, sourceErrors: snapshot?.sourceErrors ?? [],
    unknownSeats: snapshot?.unknownSeats ?? [], omittedRigIds: snapshot?.omittedRigIds ?? [],
    sources: snapshot?.sources ?? [], readAt: snapshot?.readAt };
}
