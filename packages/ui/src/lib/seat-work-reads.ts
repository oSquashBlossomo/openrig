import { hasShape, isInteger, isText, operatorRead, operatorScopeState, OperatorReadError,
  type OperatorInstanceScope, type OperatorReadOptions } from "./operator-read.js";
import { isPulseQueueItems, recentPulseQueryKey, type PulseQueueItem } from "./recent-pulse-contracts.js";

/** Identity must come from a successfully admitted inventory row. Unknown or
 * failed current identity is represented by null, never a cached session guess. */
export interface SeatWorkTarget {
  rigId: string;
  logicalId: string;
  canonicalSessionName: string;
}
export const SEAT_WORK_LIMITS = { current: 100, pending: 50, finished: 20 } as const;
export type SeatWorkWindowName = keyof typeof SEAT_WORK_LIMITS;
export const SEAT_WORK_WINDOWS: readonly SeatWorkWindowName[] = ["current", "pending", "finished"];
const STATES: Record<SeatWorkWindowName, readonly string[]> = {
  current: ["in-progress", "blocked"], pending: ["pending"], finished: ["done", "handed-off"],
};
const identity = (value: unknown): value is string => isText(value) && !!value.trim();
export function isSeatWorkTarget(value: unknown): value is SeatWorkTarget {
  return hasShape(value, { rigId: identity, logicalId: identity, canonicalSessionName: identity });
}
export function requireSeatWorkTarget(scope: OperatorInstanceScope, target: SeatWorkTarget | null): SeatWorkTarget {
  const error = operatorScopeState(scope).scopeError;
  if (error) throw error;
  if (!isSeatWorkTarget(target)) throw new OperatorReadError("invalid_request", "Seat work requires an admitted exact local rig, logical ID and served session.");
  return target;
}
export function seatWorkQueryKey(scope: OperatorInstanceScope, target: SeatWorkTarget | null, window: SeatWorkWindowName) {
  return recentPulseQueryKey(scope, "recent", "seat-work", target?.rigId ?? null, target?.logicalId ?? null,
    target?.canonicalSessionName ?? null, window);
}
export interface SeatWorkWindow {
  target: SeatWorkTarget;
  window: SeatWorkWindowName;
  rows: PulseQueueItem[];
  limit: number;
  /** Successful read receipt, not the qitem event time or inventory receipt. */
  readAt: number;
  totalCount: null;
  possiblyBounded: boolean;
  /** Inventory counters can include daemon-known aliases; these rows cannot. */
  addressCoverage: "exact-session";
  sourceOrder: "created-desc";
}
function isRows(value: unknown, target: SeatWorkTarget, window: SeatWorkWindowName): value is PulseQueueItem[] {
  return isPulseQueueItems(value) && value.length <= SEAT_WORK_LIMITS[window]
    && value.every(row => row.destinationSession === target.canonicalSessionName && STATES[window].includes(row.state));
}
/** Guard same-key seeded/retained cache without changing or reconstructing DTOs. */
export function isSeatWorkWindow(value: unknown, target: SeatWorkTarget, window: SeatWorkWindowName): value is SeatWorkWindow {
  return hasShape(value, { target: v => isSeatWorkTarget(v) && v.rigId === target.rigId
    && v.logicalId === target.logicalId && v.canonicalSessionName === target.canonicalSessionName,
  window: v => v === window, rows: v => isRows(v, target, window), limit: v => v === SEAT_WORK_LIMITS[window],
  readAt: isInteger, totalCount: v => v === null, possiblyBounded: v => typeof v === "boolean",
  addressCoverage: v => v === "exact-session", sourceOrder: v => v === "created-desc" });
}
export async function readSeatWorkWindow(scope: OperatorInstanceScope, target: SeatWorkTarget | null,
  window: SeatWorkWindowName, options: OperatorReadOptions = {}): Promise<SeatWorkWindow> {
  const admitted = { ...requireSeatWorkTarget(scope, target) };
  if (!SEAT_WORK_WINDOWS.includes(window)) throw new OperatorReadError("invalid_request", "Choose an exact seat work window.");
  const params = new URLSearchParams({ destinationSession: admitted.canonicalSessionName,
    state: STATES[window].join(","), limit: String(SEAT_WORK_LIMITS[window]) });
  const rows = await operatorRead(scope, `/api/queue/list?${params}`, (v): v is PulseQueueItem[] => isRows(v, admitted, window), options);
  return { target: { ...admitted }, window, rows, limit: SEAT_WORK_LIMITS[window], readAt: Date.now(),
    totalCount: null, possiblyBounded: rows.length >= SEAT_WORK_LIMITS[window], addressCoverage: "exact-session", sourceOrder: "created-desc" };
}
export type SeatWorkSource = { state: "available"; data: SeatWorkWindow; error: null }
  | { state: "unavailable"; error: OperatorReadError };
/** Parallel, independent windows. A cancellation stays a cancellation; ordinary
 * failures disclose their exact window instead of erasing healthy siblings. */
export async function readSeatWork(scope: OperatorInstanceScope, target: SeatWorkTarget | null,
  options: OperatorReadOptions = {}): Promise<Record<SeatWorkWindowName, SeatWorkSource>> {
  requireSeatWorkTarget(scope, target);
  const entries = await Promise.all(SEAT_WORK_WINDOWS.map(async window => {
    try { return [window, { state: "available", data: await readSeatWorkWindow(scope, target, window, options), error: null }] as const; }
    catch (error) {
      if (error instanceof OperatorReadError && error.code === "cancelled") throw error;
      return [window, { state: "unavailable", error: error instanceof OperatorReadError ? error
        : new OperatorReadError("network", "Seat work source unavailable.") }] as const;
    }
  }));
  return Object.fromEntries(entries) as Record<SeatWorkWindowName, SeatWorkSource>;
}
