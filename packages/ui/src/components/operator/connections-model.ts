// Pure Connections context model (mirrors packages/tui/src/connections/
// connections-model.ts:91–123) over existing connected-instance reads:
// the bounded Pulse read (queue windows + rig/node inventory), each rig's
// served spec.json name and the connected instance's spec library.
//
// Identity is exact throughout: the inbound destination matches a served
// canonicalSessionName byte for byte; human requests join on the exact
// destinationSession === human.address; authored specs match library rows by
// exact kind+name and list every candidate when more than one exists. Nothing
// is split from display names, and an unread/partial source is never zero.

import type { PulseNode, PulseQueueItem, PulseRead, PulseSource } from "../../lib/recent-pulse-contracts.js";
import { PULSE_LIMITS } from "../../lib/recent-pulse-contracts.js";
import type { SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";

export interface InventorySeat { rigId: string; rigName: string; logicalId: string | null; session: string; podNamespace: string | null }

export type InboundTarget =
  | { kind: "no-destination" }
  | { kind: "reading" }
  | { kind: "matched"; seat: InventorySeat }
  | { kind: "ambiguous"; seats: InventorySeat[] }
  /** No served seat matches in a COMPLETE inventory read. */
  | { kind: "not-found" }
  /** No match, but the inventory read was partial/unavailable: unknown. */
  | { kind: "unknown"; reason: string };

/** Served seats with their exact rig identity (agents and infrastructure). */
export function inventorySeats(pulse: PulseRead | undefined): InventorySeat[] {
  const seats: InventorySeat[] = [];
  for (const { rig, source } of pulse?.nodeSources ?? []) {
    for (const node of (source.data ?? []) as PulseNode[]) {
      if (typeof node.canonicalSessionName !== "string" || !node.canonicalSessionName) continue;
      seats.push({ rigId: rig.id, rigName: typeof rig.name === "string" && rig.name ? rig.name : rig.id, logicalId: node.logicalId, session: node.canonicalSessionName, podNamespace: node.podNamespace ?? null });
    }
  }
  return seats;
}

/** Why inventory is incomplete, or null when every rig's seats were read. */
export function inventoryGap(pulse: PulseRead | undefined): string | null {
  if (!pulse) return "inventory not read yet";
  if (pulse.inventory.state === "unavailable") return `rig inventory unavailable (${pulse.inventory.error.message})`;
  const failed = pulse.nodeSources.filter((n) => n.source.state === "unavailable").map((n) => n.rig.id);
  const parts: string[] = [];
  if (failed.length) parts.push(`seats unreadable for ${failed.join(", ")}`);
  if (pulse.truncatedRigCount) parts.push(`${pulse.truncatedRigCount} rig(s) beyond the ${pulse.nodeSources.length}-rig read bound`);
  if (pulse.truncatedSeatCount) parts.push(`${pulse.truncatedSeatCount} seat(s) beyond the seat read bound`);
  return parts.length ? parts.join("; ") : null;
}

export function resolveInbound(destination: string | null | undefined, pulse: PulseRead | undefined, reading: boolean): InboundTarget {
  if (!destination) return { kind: "no-destination" };
  if (!pulse) return reading ? { kind: "reading" } : { kind: "unknown", reason: "inventory could not be read" };
  const matches = inventorySeats(pulse).filter((seat) => seat.session === destination);
  if (matches.length === 1) return { kind: "matched", seat: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", seats: matches };
  const gap = inventoryGap(pulse);
  return gap ? { kind: "unknown", reason: gap } : { kind: "not-found" };
}

export const REQUEST_STATES = ["pending", "in-progress", "blocked"] as const;
export const REQUEST_SAMPLE = 3;
const WINDOWS = ["attention", "pending", "inProgress", "blocked"] as const;
type WindowName = (typeof WINDOWS)[number];
const WINDOW_LABEL: Record<WindowName, string> = { attention: "attention", pending: "pending", inProgress: "in-progress", blocked: "blocked" };

export interface RequestSample {
  /** Up to three open requests addressed to this human, from loaded windows. */
  rows: PulseQueueItem[];
  /** How many matched in the loaded windows (never a global total). */
  matchedInWindows: number;
  readWindows: string[];
  unavailableWindows: Array<{ name: string; message: string }>;
  /** Windows that returned exactly their limit: more may exist. */
  boundedWindows: string[];
  /** No window could be read: requests are unknown, not zero. */
  unknown: boolean;
}

export function humanRequestSample(address: string, pulse: PulseRead | undefined): RequestSample {
  const sources = pulse?.sources as Record<WindowName, PulseSource<PulseQueueItem[]>> | undefined;
  const readWindows: string[] = [];
  const unavailableWindows: RequestSample["unavailableWindows"] = [];
  const boundedWindows: string[] = [];
  const byId = new Map<string, PulseQueueItem>();
  for (const name of WINDOWS) {
    const source = sources?.[name];
    if (!source || source.state === "unavailable") {
      unavailableWindows.push({ name: WINDOW_LABEL[name], message: source?.error.message ?? "not read" });
      continue;
    }
    readWindows.push(WINDOW_LABEL[name]);
    if (source.data.length >= PULSE_LIMITS[name]) boundedWindows.push(WINDOW_LABEL[name]);
    for (const row of source.data) if (!byId.has(row.qitemId)) byId.set(row.qitemId, row);
  }
  const matches = [...byId.values()].filter((row) => row.destinationSession === address && (REQUEST_STATES as readonly string[]).includes(row.state));
  return { rows: matches.slice(0, REQUEST_SAMPLE), matchedInWindows: matches.length, readWindows, unavailableWindows, boundedWindows, unknown: readWindows.length === 0 };
}

export interface RigContext {
  rigId: string;
  rigName: string;
  lifecycle: string | null;
  /** Agent seats read for this rig; null when its seats were not read. */
  seatCount: number | null;
  seatsState: "read" | "unavailable" | "beyond-bound";
}

/** Rig rows from the served inventory, with lifecycle and seat evidence. */
export function rigContexts(pulse: PulseRead | undefined): RigContext[] {
  if (!pulse || pulse.inventory.state === "unavailable") return [];
  const read = new Map(pulse.nodeSources.map((n) => [n.rig.id, n.source]));
  return (pulse.inventory.data as Array<Record<string, unknown> & { id: string; name?: string | null }>).map((rig) => {
    const source = read.get(rig.id);
    const nodes = source?.state === "available" ? (source.data as PulseNode[]) : null;
    return {
      rigId: rig.id,
      rigName: typeof rig.name === "string" && rig.name ? rig.name : rig.id,
      lifecycle: typeof rig.lifecycleState === "string" ? rig.lifecycleState : null,
      seatCount: nodes ? nodes.filter((n) => n.nodeKind !== "infrastructure").length : null,
      seatsState: !source ? "beyond-bound" : source.state === "available" ? "read" : "unavailable",
    };
  });
}

type CurrentSpecMatch =
  | { kind: "absent" }
  | { kind: "matched"; entry: SpecLibraryEntry }
  | { kind: "ambiguous"; entries: SpecLibraryEntry[] };

export type SpecMatch =
  | { kind: "pending" }
  /** The latest library read failed. `retained` is the match from the last
   * successful read (dated by `retainedAt`); it is earlier evidence, never a
   * current match or absence. */
  | { kind: "unavailable"; message: string; retained?: CurrentSpecMatch; retainedAt?: number | null }
  | CurrentSpecMatch;

function exactMatch(name: string, entries: SpecLibraryEntry[]): CurrentSpecMatch {
  const rows = entries.filter((entry) => entry.kind === "rig" && entry.name === name);
  if (rows.length === 1) return { kind: "matched", entry: rows[0]! };
  if (rows.length > 1) return { kind: "ambiguous", entries: rows };
  return { kind: "absent" };
}

/** Library rows for an authored rig spec name: exact kind + name bytes. A
 * failed latest read wins over retained data (React Query keeps the last
 * successful entries after a failed refetch). */
export function matchAuthoredSpec(name: string, entries: SpecLibraryEntry[] | undefined, error: Error | null, readAt: number | null = null): SpecMatch {
  if (error) return entries ? { kind: "unavailable", message: error.message, retained: exactMatch(name, entries), retainedAt: readAt } : { kind: "unavailable", message: error.message };
  if (!entries) return { kind: "pending" };
  return exactMatch(name, entries);
}
