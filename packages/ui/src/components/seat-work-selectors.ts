// Pure selectors for the exact-seat work panel (gui-seat-work-contract.md).
// Needs-you attribution uses only served exact predicates: an agent row's
// destinationSession equal to the seat's served session, or one of the two
// seat-derived identities the review composer produces —
// `<session>|stuck|<iso>` and `<session>|too-long-in-state|<iso>` — decoded
// from the RIGHT so a session containing "|" stays whole. Prose (summary,
// where, unblocks) is never joined; blocked work is not a human request.

import type { PulseQueueItem } from "../lib/recent-pulse-contracts.js";

const SEAT_DERIVED_KINDS = new Set(["stuck", "too-long-in-state"]);

/** Session named by a recognized seat-derived identity, else null. */
export function seatDerivedSession(identity: string): string | null {
  const last = identity.lastIndexOf("|");
  if (last <= 0 || last === identity.length - 1) return null;
  const rest = identity.slice(0, last);
  const mid = rest.lastIndexOf("|");
  if (mid <= 0) return null;
  if (!SEAT_DERIVED_KINDS.has(rest.slice(mid + 1))) return null;
  return rest.slice(0, mid);
}

/** The consumed fields of one served NeedsYou row. */
export interface SeatNeedRow {
  source: "agent" | "derived";
  identity: string;
  summary: string;
  leg: string;
  qitemId: string | null;
  destinationSession: string | null;
  evidenceRef: string | null;
  unblocks: string | null;
  ageIso: string | null;
  derived: { kind: string; evidence: string; threshold: string } | null;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

export function isSeatNeedRow(value: unknown): value is SeatNeedRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const derived = v.derived;
  const derivedOk = derived === null || (typeof derived === "object" && !Array.isArray(derived)
    && isStr((derived as Record<string, unknown>).kind) && isStr((derived as Record<string, unknown>).evidence)
    && isStr((derived as Record<string, unknown>).threshold));
  return (v.source === "agent" || v.source === "derived") && isStr(v.identity) && v.identity.length > 0
    && isStr(v.summary) && isStr(v.leg) && isStrOrNull(v.qitemId) && isStrOrNull(v.destinationSession)
    && isStrOrNull(v.evidenceRef) && isStrOrNull(v.unblocks) && isStrOrNull(v.ageIso) && derivedOk;
}

/** Served review rows attributed to this exact session, plus the number of
 *  rows whose consumed shape could not be validated (never guessed). */
export function selectSeatNeeds(items: readonly unknown[], session: string): { matched: SeatNeedRow[]; unreadable: number } {
  const matched: SeatNeedRow[] = [];
  let unreadable = 0;
  for (const item of items) {
    if (!isSeatNeedRow(item)) {
      unreadable++;
      continue;
    }
    const forSeat = item.source === "agent"
      ? item.destinationSession === session
      : seatDerivedSession(item.identity) === session;
    if (forSeat) matched.push(item);
  }
  return { matched, unreadable };
}

/** Finished rows by update time (newest first); the window itself remains a
 *  bounded creation-ordered source slice. */
export function sortFinished(rows: readonly PulseQueueItem[]): PulseQueueItem[] {
  return [...rows].sort((a, b) => (Date.parse(b.tsUpdated) || 0) - (Date.parse(a.tsUpdated) || 0) || a.qitemId.localeCompare(b.qitemId, "en-US"));
}

export function rowHeadline(row: PulseQueueItem): string {
  const summary = row.summary?.trim();
  if (summary) return summary;
  return row.body.split("\n").find((line) => line.trim())?.trim() ?? row.qitemId;
}
