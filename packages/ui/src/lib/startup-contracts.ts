import { arrayOf, hasShape, isBoolean, isInteger, isObject, isText, nullable, oneOf, optional } from "./operator-read.js";

export const exactText = (v: unknown): v is string => isText(v) && !!v.trim();
export interface StartupPrerequisites extends Record<string, unknown> { codex: "ok" | "unavailable"; claudeCode: "ok" | "unavailable" }
export interface StartupSeat extends Record<string, unknown> {
  logicalId: string; nodeId: string; runtime: string | null; model: string | null; revision: string; hasHistory: boolean;
  intendedAction: "resume-original" | "fresh-primed" | "awaiting-decision"; reason?: string; freshRequired: boolean;
  tokenState: "present" | "missing" | "stale" | "unverified"; occupantSessionId?: string | null;
  provenance?: string | null; lastVerified?: string | null; runtimePrompt?: string;
  observed: { state: "running" | "stopped" | "attention_required" | "transport_unavailable" | "unverified"; detail: string; sessionName: string };
  contextPending?: boolean; freshAllowed?: boolean; prerequisite?: string;
}
export interface StartupRig extends Record<string, unknown> { rigId: string; rigName: string; seats: StartupSeat[] }
export type StartupAction = "resume" | "start" | "fresh" | "continue";
/** Session name is the daemon's served pane target, not a guessed conversation ID. */
export interface StartupSelection {
  readonly rigId: string; readonly nodeId: string; readonly logicalId: string; readonly runtime: string;
  readonly revision: string; readonly sessionName: string;
}
export interface StartupFreshConsent { readonly action: "fresh"; readonly selection: StartupSelection }
export interface StartupResult extends Record<string, unknown> { ok: boolean; code?: string; message?: string }

export function isStartupPrerequisites(v: unknown): v is StartupPrerequisites {
  return hasShape(v, { codex: oneOf("ok", "unavailable"), claudeCode: oneOf("ok", "unavailable") });
}
export function isStartupSeat(v: unknown): v is StartupSeat {
  return hasShape(v, { logicalId: exactText, nodeId: exactText, runtime: nullable(isText), model: nullable(isText), revision: exactText, hasHistory: isBoolean,
    intendedAction: oneOf("resume-original", "fresh-primed", "awaiting-decision"), freshRequired: isBoolean, reason: optional(isText),
    tokenState: oneOf("present", "missing", "stale", "unverified"), occupantSessionId: optional(nullable(isText)),
    provenance: optional(nullable(isText)), lastVerified: optional(nullable(isText)), runtimePrompt: optional(isText),
    contextPending: optional(isBoolean), freshAllowed: optional(isBoolean), prerequisite: optional(isText),
    observed: value => hasShape(value, { state: oneOf("running", "stopped", "attention_required", "transport_unavailable", "unverified"), detail: isText, sessionName: exactText }),
  });
}
export function isStartupRig(v: unknown): v is StartupRig {
  if (!hasShape(v, { rigId: exactText, rigName: exactText, seats: arrayOf(isStartupSeat) })) return false;
  const seats = v.seats as StartupSeat[];
  return new Set(seats.map(s => s.nodeId)).size === seats.length && new Set(seats.map(s => s.logicalId)).size === seats.length;
}
export function isStartupSelection(v: unknown): v is StartupSelection {
  return hasShape(v, { rigId: exactText, nodeId: exactText, logicalId: exactText, runtime: exactText, revision: exactText, sessionName: exactText });
}
export function sameStartupSelection(a: StartupSelection, b: StartupSelection): boolean {
  return ["rigId", "nodeId", "logicalId", "runtime", "revision", "sessionName"].every(k => a[k as keyof StartupSelection] === b[k as keyof StartupSelection]);
}
export function isStartupResult(v: unknown): v is StartupResult { return hasShape(v, { ok: isBoolean, code: optional(isText), message: optional(isText) }); }
/** Check every identity the producer supplies; a response without an identity
 * echo is permitted by the existing API and still needs observed readback. */
export function matchesStartupResult(v: StartupResult, selection: StartupSelection): boolean {
  const matches = (row: Record<string, unknown>) => ["rigId", "nodeId", "logicalId", "runtime", "sessionName"].every(k => row[k] === undefined || row[k] === selection[k as keyof StartupSelection]);
  if (!matches(v) || (v.seat !== undefined && (!isObject(v.seat) || !matches(v.seat)))) return false;
  if (v.observed !== undefined && (!isObject(v.observed) || !matches(v.observed))) return false;
  // unchanged/non-target facts legitimately describe other seats; target effects do not.
  return ["launched", "alreadyRunning", "failedTargets"].every(k => v[k] === undefined || (Array.isArray(v[k]) && v[k].every(row => isObject(row) && matches(row))));
}

export type FleetRestoreOutcome = "fully_restored" | "partially_restored" | "failed" | "not_attempted";
export interface FleetRestoreAttention extends Record<string, unknown> { rigId: string; seat: string; need: string }
export interface FleetRestoreRow extends Record<string, unknown> {
  rigId: string; outcome: FleetRestoreOutcome; receiptRef?: string | number; attention?: FleetRestoreAttention[]; reason?: string; remediation?: string;
}
export interface FleetRestoreStatus extends Record<string, unknown> {
  done: boolean; cancelled: boolean; verdict: "all_fully_restored" | "all_failed" | "none_attempted" | "mixed";
  rollup: { counts: Record<FleetRestoreOutcome, number>; sequence: FleetRestoreRow[]; attention_required: FleetRestoreAttention[]; [key: string]: unknown };
}
export interface FleetRestoreHandle { readonly connectionKey: string; readonly fleetAttemptId: string }
export interface FleetRestoreKickoff extends Record<string, unknown> { fleetAttemptId: string; status: "started" }
const outcomes: FleetRestoreOutcome[] = ["fully_restored", "partially_restored", "failed", "not_attempted"];
const attention = (v: unknown) => hasShape(v, { rigId: exactText, seat: exactText, need: isText });
export function isFleetRestoreStatus(v: unknown): v is FleetRestoreStatus {
  if (!hasShape(v, { done: isBoolean, cancelled: isBoolean, verdict: oneOf("all_fully_restored", "all_failed", "none_attempted", "mixed"),
    rollup: r => hasShape(r, { counts: c => hasShape(c, Object.fromEntries(outcomes.map(o => [o, isInteger]))),
      sequence: arrayOf(row => hasShape(row, { rigId: exactText, outcome: oneOf(...outcomes), reason: optional(isText), remediation: optional(isText),
        receiptRef: optional(x => isText(x) || isInteger(x)), attention: optional(arrayOf(attention)) })), attention_required: arrayOf(attention) }),
  })) return false;
  const { counts, sequence } = (v as unknown as FleetRestoreStatus).rollup;
  if (!outcomes.every(o => counts[o] === sequence.filter(row => row.outcome === o).length)) return false;
  const total = sequence.length;
  const verdict = !total || counts.not_attempted === total ? "none_attempted" : counts.fully_restored === total ? "all_fully_restored" : counts.failed === total ? "all_failed" : "mixed";
  return v.verdict === verdict;
}
export function isFleetRestoreKickoff(v: unknown): v is FleetRestoreKickoff { return hasShape(v, { fleetAttemptId: exactText, status: oneOf("started") }); }
export function isFleetRestoreHandle(v: unknown): v is FleetRestoreHandle { return hasShape(v, { connectionKey: exactText, fleetAttemptId: exactText }); }
/** A paused view retains the last server observation, including its done flag. */
export function fleetRestoreFrame(handle: FleetRestoreHandle, observation?: FleetRestoreStatus, detached = false) {
  return { handle, observation, phase: observation?.done ? "done" as const : detached ? "detached" as const : observation ? "running" as const : "observing" as const };
}
