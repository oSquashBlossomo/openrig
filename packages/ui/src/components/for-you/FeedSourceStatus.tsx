// Source/freshness disclosure for the Activity feed's decision sources.
//
// Rendered only when a decision source is not current and complete. A
// retained read stays usable but is dated and labeled; a failed first read
// is reported as unknown, never as an empty queue.

import type { ReactNode } from "react";
import type { FeedSourceState } from "./feed-read-state.js";
import { DisplayTime, DisplayZoneNote } from "../time/DisplayTime.js";

export interface NeedsInputCoverageLike {
  inspectedRigCount: number;
  discoveredRigCount: number;
  unknownSeatCount: number;
  rejectedRowCount: number;
}

/** The exact receipt instant (ms) in the connected instance's display zone
 * (shared DisplayTime: exact ISO kept on <time>, zone/source in the title). */
function time(ms: number | null | undefined, testId: string): ReactNode {
  // A missing or non-finite receipt is unknown (never "now" or a thrown error).
  const iso = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  return <DisplayTime iso={iso} fallback="an unknown time" testId={testId} />;
}

// Warning rows: primary text on a 15% warning tint over the opaque
// surface-lowest container, plus a warning rule. Calculated (sRGB, unrounded):
// light text 11.52:1 on rgb(253,242,219); dark 10.20:1 on rgb(57,51,28).
// (Plain warning-coloured text measured 1.93:1 on the light body.)
const WARNING_ROW = "border-l-2 border-warning bg-[hsl(var(--warning)/0.15)] px-1.5 py-0.5 text-on-surface";

function Row({ state, testId, children, onRetry }: { state: FeedSourceState; testId: string; children: ReactNode; onRetry?: () => void }) {
  const alert = state === "stale" || state === "unavailable";
  return (
    <li data-testid={testId} data-state={state} role={alert ? "alert" : undefined} className={alert ? `flex flex-wrap items-baseline gap-x-2 gap-y-1 ${WARNING_ROW}` : "flex flex-wrap items-baseline gap-x-2 gap-y-1"}>
      <span className={alert ? "text-on-surface" : "text-on-surface-variant"}>{children}</span>
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
    <ul data-testid="feed-source-status" aria-label="Feed source status" className="mb-3 space-y-1 border border-outline-variant bg-surface-lowest px-2 py-1.5 font-mono text-[10px] text-on-surface">
      {attention !== "ready" ? (
        <Row state={attention} testId="feed-source-attention" onRetry={onRetryAttention}>
          {attention === "pending" ? "Reading requests…"
            : attention === "unavailable" ? <>Requests could not be read{attentionError ? ` (${attentionError.message})` : ""}. Whether anything needs you is unknown.</>
              : attention === "stale" ? <>Requests refresh failed{attentionError ? ` (${attentionError.message})` : ""}. Request cards are from the last successful read at {time(attentionReadAt, "feed-source-attention-read-at")} and may have been answered since.</>
                : "Some hosts could not be read; their requests are unknown (see host status above)."}
        </Row>
      ) : null}
      {needsInput !== "ready" ? (
        <Row state={needsInput} testId="feed-source-needs-input" onRetry={onRetryNeedsInput}>
          {needsInput === "pending" ? "Checking seats for prompts…"
            : needsInput === "unavailable" ? <>Seat prompt scan unavailable{needsInputError ? ` (${needsInputError.message})` : ""}. Seats waiting on input are unknown.</>
              : needsInput === "stale" ? <>Seat prompt scan refresh failed{needsInputError ? ` (${needsInputError.message})` : ""}. Seat cards are from the read at {time(needsInputReadAt, "feed-source-needs-input-read-at")}.</>
                : <>Seat prompt scan incomplete{coverage ? `: inspected ${coverage.inspectedRigCount} of ${coverage.discoveredRigCount} rigs; ${coverage.unknownSeatCount} seat${coverage.unknownSeatCount === 1 ? "" : "s"} unknown${coverage.rejectedRowCount ? `; ${coverage.rejectedRowCount} rows rejected` : ""}` : ""}{omittedRigIds.length ? `; not inspected: ${omittedRigIds.join(", ")}` : ""}.</>}
        </Row>
      ) : null}
      {attention === "stale" || needsInput === "stale" ? (
        // Which zone the dates above use, and why (configured / stale / fallback).
        <li><DisplayZoneNote testId="feed-display-zone" className="text-on-surface-variant" /></li>
      ) : null}
    </ul>
  );
}
