// Presentation helpers for Recent / Pulse. Pure: no reads, no joins beyond
// exact identity lookups in already-served Pulse evidence. A seat or rig is
// linked only when exactly one served record carries that exact identity;
// anything else stays a visible canonical pointer.

import { PULSE_LIMITS, type PulseQueueItem, type PulseRead, type PulseWindow } from "../../lib/recent-pulse-contracts.js";
import { isHumanSeatSessionRef } from "../../lib/session-name.js";

export type SeatResolution =
  | { kind: "seat"; rigId: string; rigName: string; logicalId: string; session: string }
  | { kind: "human" }
  | { kind: "no-logical-id"; rigId: string; rigName: string }
  | { kind: "ambiguous"; count: number }
  | { kind: "not-found"; inventoryComplete: boolean }
  | { kind: "unavailable"; reason: string };

/** Exact canonical session → served seat. Never by suffix, logical name or cwd. */
export function resolveSeat(pulse: PulseRead | undefined, pulseStatus: string, session: string): SeatResolution {
  if (isHumanSeatSessionRef(session)) return { kind: "human" };
  if (!pulse) return { kind: "unavailable", reason: pulseStatus === "loading" ? "seat inventory is still being read" : "seat inventory was not read" };
  if (pulse.inventory.state !== "available") return { kind: "unavailable", reason: `rig inventory unavailable: ${pulse.inventory.error.message}` };
  const matches = pulse.seats.filter((seat) => seat.session === session);
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  const seat = matches[0];
  if (!seat) return { kind: "not-found", inventoryComplete: pulse.inventoryComplete };
  // PulseSeat.logicalId falls back to the session for display; a route needs
  // the served node logicalId itself.
  const nodes = pulse.nodeSources.find((n) => n.rig.id === seat.rigId)?.source.data ?? [];
  const served = nodes.filter((node) => node.canonicalSessionName === session);
  const logicalId = served.length === 1 ? served[0]!.logicalId : null;
  if (!logicalId) return { kind: "no-logical-id", rigId: seat.rigId, rigName: seat.rigName };
  return { kind: "seat", rigId: seat.rigId, rigName: seat.rigName, logicalId, session };
}

export type RigResolution = { kind: "rig"; rigId: string } | { kind: "ambiguous"; count: number } | { kind: "not-found" } | { kind: "unavailable"; reason: string };

/** Exact Recent rig NAME → served rig ID (topology identity). */
export function resolveRig(pulse: PulseRead | undefined, rigName: string): RigResolution {
  if (!pulse) return { kind: "unavailable", reason: "rig inventory was not read" };
  if (pulse.inventory.state !== "available") return { kind: "unavailable", reason: `rig inventory unavailable: ${pulse.inventory.error.message}` };
  const matches = pulse.inventory.data.filter((rig) => (rig.name ?? null) === rigName);
  if (matches.length > 1) return { kind: "ambiguous", count: matches.length };
  return matches[0] ? { kind: "rig", rigId: matches[0].id } : { kind: "not-found" };
}

/** TUI subject: authored summary → first nonempty body line → destination. */
export function qitemSubject(item: Pick<PulseQueueItem, "summary" | "body" | "destinationSession">): string {
  const summary = item.summary?.trim();
  if (summary) return summary;
  const line = item.body.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ?? item.destinationSession;
}

/** Elapsed age from a served timestamp; unknown stays unknown (never "just now"). */
export function ageSince(iso: string | null | undefined, now: number): string {
  if (!iso) return "age unknown";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "age unknown";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Claim age only from a recorded claim time. A null claim stays unknown;
 * the update time is shown as an update age, never as a claim. */
export function claimAgeText(item: Pick<PulseQueueItem, "claimedAt" | "tsUpdated">, now: number): string {
  if (item.claimedAt === null) return `claim time not recorded · updated ${ageSince(item.tsUpdated, now)} ago`;
  const age = ageSince(item.claimedAt, now);
  return age === "age unknown" ? "claim time unreadable" : `claimed ${age} ago`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Count text for one lane from its own referent window. */
export function laneCountText(window: PulseWindow<unknown>): string {
  if (window.totalCount !== null) return String(window.totalCount);
  return `${window.servedCount} served · total unknown`;
}

export const LANES = [
  { id: "waitingYou", title: "Needs you", sources: ["attention"], reason: "Human-destination or blocked-on-human decisions from the attention window (limit 100)." },
  { id: "parked", title: "Parked with baton", sources: ["inProgress", "inventory"], reason: "In-progress work, not handed off, whose owner's terminal is reported inactive (false). Unknown activity is not idle." },
  { id: "blocked", title: "Blocked on agents", sources: ["blocked"], reason: "Blocked work excluding human blockers. A qitem pointer names its owner only after an exact lookup." },
  { id: "now", title: "Now", sources: ["inventory"], reason: "Seats whose terminal is reported active (true), with their first served in-progress work." },
  { id: "finished", title: "Just finished", sources: ["finished"], reason: "Newest-updated among the 20 most recently created done/handed-off items. Not complete finish history." },
  { id: "upNext", title: "Up next", sources: ["pending"], reason: "Unclaimed pending work from the 50 most recently created pending items, in served order." },
] as const;
export type LaneId = (typeof LANES)[number]["id"];

/** Why a lane's total is not known, from the lane's own evidence. */
export function laneUnknownReason(id: LaneId, pulse: PulseRead): string | null {
  const window = pulse.model[id];
  if (!window || window.totalCount !== null) return null;
  switch (id) {
    case "finished": return "Candidate window ordered by creation; older-created items finished recently can be outside it.";
    case "now": {
      // Seat-only evidence: the queue window cap never bounds Now.
      const reasons: string[] = [];
      if (!pulse.inventoryComplete) reasons.push("Seat inventory is incomplete (failed or capped node reads).");
      const unknown = pulse.seats.filter((s) => s.terminalActive === null).length;
      if (unknown) reasons.push(`${plural(unknown, "served seat reports", "served seats report")} unknown activity, neither active nor idle.`);
      return reasons.join(" ") || "Total not established from the served seat evidence.";
    }
    case "parked": {
      const reasons: string[] = [];
      const inProgress = pulse.sources.inProgress;
      const served = inProgress.state === "available" ? inProgress.data.length : 0;
      if (served >= PULSE_LIMITS.inProgress) reasons.push(`In-progress source window is full (${served} of limit ${PULSE_LIMITS.inProgress} served); more in-progress work may exist beyond it.`);
      if (!pulse.inventoryComplete) reasons.push("Seat inventory is incomplete (failed or capped node reads).");
      const bySeat = new Map(pulse.seats.map((s) => [s.session, s]));
      const owners = inProgress.state === "available" ? inProgress.data.filter((q) => q.handedOffTo == null).map((q) => bySeat.get(q.destinationSession)) : [];
      const unknown = owners.filter((seat) => seat !== undefined && seat.terminalActive === null).length;
      const missing = owners.filter((seat) => seat === undefined).length;
      if (unknown) reasons.push(`${plural(unknown, "in-progress owner reports", "in-progress owners report")} unknown activity, neither active nor idle.`);
      if (missing) reasons.push(`${plural(missing, "in-progress owner is", "in-progress owners are")} not in the served seat inventory.`);
      return reasons.join(" ") || "Total not established from the served evidence.";
    }
    case "blocked":
      if (Object.keys(pulse.blockerErrors).length || pulse.omittedBlockerIds.length) return "Some blocker pointers could not be resolved to an owner.";
      return window.possiblyBounded ? "The blocked window is full; more may exist." : "Some blocker pointers are unresolved.";
    default: return window.possiblyBounded ? "The source window is full; more may exist beyond it." : null;
  }
}
