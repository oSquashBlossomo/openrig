// Source/freshness disclosure for the Activity feed's decision sources.
//
// Rendered only when a decision source is not current and complete. A
// retained read stays usable but is dated and labeled; a failed first read
// is reported as unknown, never as an empty queue.

import type { ReactNode } from "react";
import type { FeedSourceState } from "./feed-read-state.js";

export interface NeedsInputCoverageLike {
  inspectedRigCount: number;
  discoveredRigCount: number;
  unknownSeatCount: number;
  rejectedRowCount: number;
}

function time(ms: number | null | undefined): ReactNode {
  if (!ms) return "an unknown time";
  const iso = new Date(ms).toISOString();
  return <time dateTime={iso} title={iso}>{new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>;
}

function Row({ state, testId, children, onRetry }: { state: FeedSourceState; testId: string; children: ReactNode; onRetry?: () => void }) {
  const alert = state === "stale" || state === "unavailable";
  return (
    <li data-testid={testId} data-state={state} role={alert ? "alert" : undefined} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={alert ? "text-warning" : "text-on-surface-variant"}>{children}</span>
      {onRetry && alert ? (
        <button type="button" onClick={onRetry} data-testid={`${testId}-retry`} className="border border-on-surface px-1.5 py-0.5 text-[9px] uppercase hover:bg-surface-low">
          Retry
        </button>
      ) : null}
    </li>
  );
}

export function FeedSourceStatus({ attention, attentionError, attentionReadAt, onRetryAttention, needsInput, needsInputError, needsInputReadAt, coverage, omittedRigIds, onRetryNeedsInput }: {
  attention: FeedSourceState; attentionError: Error | null; attentionReadAt: number | null; onRetryAttention: () => void;
  needsInput: FeedSourceState; needsInputError: Error | null; needsInputReadAt: number | null | undefined;
  coverage: NeedsInputCoverageLike | undefined; omittedRigIds: string[]; onRetryNeedsInput: () => void;
}) {
  if (attention === "ready" && needsInput === "ready") return null;
  return (
    <ul data-testid="feed-source-status" aria-label="Feed source status" className="mb-3 space-y-1 border border-outline-variant px-2 py-1.5 font-mono text-[10px]">
      {attention !== "ready" ? (
        <Row state={attention} testId="feed-source-attention" onRetry={onRetryAttention}>
          {attention === "pending" ? "Reading requests…"
            : attention === "unavailable" ? <>Requests could not be read{attentionError ? ` (${attentionError.message})` : ""}. Whether anything needs you is unknown.</>
              : attention === "stale" ? <>Requests refresh failed{attentionError ? ` (${attentionError.message})` : ""}. Request cards are from the last successful read at {time(attentionReadAt)} and may have been answered since.</>
                : "Some hosts could not be read; their requests are unknown (see host status above)."}
        </Row>
      ) : null}
      {needsInput !== "ready" ? (
        <Row state={needsInput} testId="feed-source-needs-input" onRetry={onRetryNeedsInput}>
          {needsInput === "pending" ? "Checking seats for prompts…"
            : needsInput === "unavailable" ? <>Seat prompt scan unavailable{needsInputError ? ` (${needsInputError.message})` : ""}. Seats waiting on input are unknown.</>
              : needsInput === "stale" ? <>Seat prompt scan refresh failed{needsInputError ? ` (${needsInputError.message})` : ""}. Seat cards are from the read at {time(needsInputReadAt)}.</>
                : <>Seat prompt scan incomplete{coverage ? `: inspected ${coverage.inspectedRigCount} of ${coverage.discoveredRigCount} rigs; ${coverage.unknownSeatCount} seat${coverage.unknownSeatCount === 1 ? "" : "s"} unknown${coverage.rejectedRowCount ? `; ${coverage.rejectedRowCount} rows rejected` : ""}` : ""}{omittedRigIds.length ? `; not inspected: ${omittedRigIds.join(", ")}` : ""}.</>}
        </Row>
      ) : null}
    </ul>
  );
}
