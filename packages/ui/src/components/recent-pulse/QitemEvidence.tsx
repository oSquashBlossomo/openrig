// Current queue item, read by exact recorded ID. This is SEPARATE evidence:
// it describes the item now, never the recorded transition that linked here,
// and it never replaces a frozen Recent original.
//
// Read: one GET /api/queue/:qitemId through canonical operatorRead (5 s
// deadline, abort, validation) with the reviewed Pulse queue-item guard. Its
// key sits in the shared `recent` family so the existing global-event
// scheduler refreshes it on queue/qitem/inbox events; no new transport,
// EventSource or scheduler.

import { useQuery } from "@tanstack/react-query";
import { OPERATOR_QUERY_OPTIONS, operatorRead, operatorScopeState, type OperatorInstanceScope, OperatorReadError } from "../../lib/operator-read.js";
import { isPulseQueueItems, recentPulseQueryKey, type PulseQueueItem } from "../../lib/recent-pulse-contracts.js";
import { usePulse } from "../../hooks/usePulse.js";
import { DetailSection, Field, Fields, LoadingBlock, ReadFailure, Tag, TechnicalDetails, Timestamp } from "../operator/OperatorPrimitives.js";
import { qitemSubject, resolveSeat } from "./recent-pulse-model.js";
import { ReadCompletion, SeatPointer } from "./RecentPulseParts.js";

export function recentQitemQueryKey(scope: OperatorInstanceScope, qitemId: string) {
  return recentPulseQueryKey(scope, "recent", "qitem", qitemId);
}

export function useRecentQitem(scope: OperatorInstanceScope, qitemId: string | null) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<PulseQueueItem, OperatorReadError>({
    ...OPERATOR_QUERY_OPTIONS,
    queryKey: recentQitemQueryKey(scope, qitemId ?? ""),
    queryFn: ({ signal }) => operatorRead(scope, `/api/queue/${encodeURIComponent(qitemId!)}`,
      (v): v is PulseQueueItem => isPulseQueueItems([v]) && (v as PulseQueueItem).qitemId === qitemId, { signal }),
    enabled: scopeState.scopeSupported && qitemId !== null,
  });
  const current = scopeState.scopeSupported && !query.isError && !query.isPlaceholderData ? query.data : undefined;
  return { ...query, ...scopeState, current };
}

export function QitemEvidence({ scope, qitemId, context }: { scope: OperatorInstanceScope; qitemId: string; context?: string }) {
  const read = useRecentQitem(scope, qitemId);
  const pulse = usePulse(scope);
  const item = read.current;
  return (
    <section data-testid="recent-qitem-evidence" aria-labelledby="recent-qitem-heading" className="border border-outline-variant bg-surface-lowest p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">Current queue item · separate evidence</p>
      <h2 id="recent-qitem-heading" tabIndex={-1} className="mt-1 break-words font-mono text-sm font-bold text-on-surface [overflow-wrap:anywhere]">{qitemId}</h2>
      <p className="mt-1 text-xs text-on-surface-variant">
        {context ?? "Read now by its exact ID."} This is the item&apos;s present state, not a record of any earlier transition.
      </p>
      {!read.scopeSupported ? <ReadFailure error={read.scopeError} what="Queue item" testId="recent-qitem-unsupported" />
        : read.error ? (
          <ReadFailure
            error={read.error}
            what={read.error.serverCode === "qitem_not_found" ? "Queue item no longer served" : "Queue item"}
            onRetry={() => void read.refetch()}
            testId="recent-qitem-error"
          />
        ) : !item ? <LoadingBlock label="queue item" testId="recent-qitem-loading" /> : (
          <div className="mt-3 space-y-3">
            <ReadCompletion at={read.dataUpdatedAt} fetching={read.isFetching} testId="recent-qitem-read" />
            <p data-testid="recent-qitem-subject" className="text-sm text-on-surface [overflow-wrap:anywhere]">{qitemSubject(item)}</p>
            <div className="flex flex-wrap gap-1">
              <Tag tone={item.state === "blocked" ? "warn" : item.state === "in-progress" ? "info" : item.state === "pending" ? "neutral" : "muted"} testId="recent-qitem-state">{item.state}</Tag>
              <Tag tone={item.priority === "routine" ? "muted" : "bad"}>{item.priority}</Tag>
            </div>
            <Fields>
              <Field label="Owner (destination)"><SeatPointer session={item.destinationSession} resolution={resolveSeat(pulse.current, pulse.status, item.destinationSession)} testId="recent-qitem-owner" /></Field>
              <Field label="From"><SeatPointer session={item.sourceSession} resolution={resolveSeat(pulse.current, pulse.status, item.sourceSession)} /></Field>
              <Field label="Created"><Timestamp iso={item.tsCreated} /></Field>
              <Field label="Updated"><Timestamp iso={item.tsUpdated} /></Field>
              <Field label="Claimed"><Timestamp iso={item.claimedAt} fallback="not claimed" /></Field>
              <Field label="Blocked on">{item.blockedOn ?? "—"}</Field>
              <Field label="Handed off to">{item.handedOffTo ?? "—"}</Field>
            </Fields>
            <DetailSection title="Body">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-surface-low p-2 font-mono text-[12px] text-on-surface [overflow-wrap:anywhere]">{item.body}</pre>
            </DetailSection>
            <TechnicalDetails value={item} testId="recent-qitem-json" />
          </div>
        )}
    </section>
  );
}
