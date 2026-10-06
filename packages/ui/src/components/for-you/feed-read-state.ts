// Read state for the Activity feed's decision sources.
//
// The Action-required / Approval lenses are only as complete as the two
// reads behind them: the durable attention queue (`useAttentionItems`) and
// the seat prompt scan (`useNeedsInputSeats`). An empty card list is
// trustworthy negative evidence ONLY when both reads are current and
// complete; pending, failed, partial or retained (stale) reads never earn
// "All caught up".

import type { AttentionData } from "../../hooks/useAttentionItems.js";

export type FeedSourceState = "pending" | "ready" | "partial" | "unavailable" | "stale";

export interface FeedAttentionQueryLike {
  data: AttentionData | undefined;
  error: Error | null;
}

/** Attention queue state. Aggregated reads with any non-ok host are partial:
 * those hosts' requests are unknown, not absent. */
export function attentionFeedState(query: FeedAttentionQueryLike): FeedSourceState {
  if (query.error) return query.data ? "stale" : "unavailable";
  if (!query.data) return "pending";
  return query.data.hosts.some((host) => host.status !== "ok") ? "partial" : "ready";
}

/** Needs-input state straight from the hook; an absent state is not evidence. */
export function needsInputFeedState(readState: string | undefined): FeedSourceState {
  return readState === "ready" || readState === "partial" || readState === "unavailable" || readState === "stale" ? readState : "pending";
}

/** Lenses whose emptiness depends on the decision sources above. */
export const DECISION_LENSES = new Set(["all", "action-required", "approval"]);

export function emptyIsConfirmed(lens: string, attention: FeedSourceState, needsInput: FeedSourceState): boolean {
  if (!DECISION_LENSES.has(lens)) return true;
  return attention === "ready" && needsInput === "ready";
}

export const UNCONFIRMED_EMPTY_LABEL: Record<string, string> = {
  all: "Can't confirm you're caught up",
  "action-required": "Can't confirm no actions are waiting",
  approval: "Can't confirm no approvals are waiting",
};
