// App-lifetime owner for connected-instance recovery effects.
//
// Mount once above the route Outlet (inside QueryClientProvider). Routes may
// unmount while a startup POST, fleet kickoff or fleet cancel is in flight; the
// promise chains below live here, so the submitted attempt and its result stay
// inspectable when the operator returns. Leaving a page never cancels accepted
// daemon work, and nothing here replays a POST automatically.
//
// Scope: startup and crash-cart routes are not host-forwarded. Every effect is
// bound to the CONNECTED instance and is refused before transport unless the
// topology host selection is known and local — a remote or unknown selection
// is never permission to act on (or relabel) local data.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHosts } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { LOCAL_OPERATOR_INSTANCE } from "../../lib/operator-read.js";
import {
  useStartupActions, reconcileStartupAttempt, startupActionAttempt, StartupOperationError,
  type StartupSurfaceInput, type StartupOperationAttempt, type StartupResult, type StartupSeat,
} from "../../hooks/useStartup.js";
import {
  useFleetRestoreAttempt, useFleetRestoreCancel, useFleetRestoreKickoff, useFleetRestoreStatus, fleetRestoreQueryKey,
  type FleetRestorePollOptions,
} from "../../hooks/useFleetRestore.js";
import type { FleetRestoreHandle } from "../../lib/startup-operations.js";
import { admitConnectedLocal, currentOrigin, fleetConnectionKey } from "./connected-admission.js";

// ---------------------------------------------------------------- selection

/** `stale` means the last successful /api/hosts read is retained but the
 * latest refresh failed: it is shown, but it no longer authorizes new effects. */
export type ConnectedSelection =
  | { state: "unknown"; error: Error | null }
  | { state: "local"; instanceName: string | null; stale: boolean; error: Error | null }
  | { state: "remote"; hostId: string; instanceName: string | null; stale: boolean; error: Error | null };

export { fleetConnectionKey } from "./connected-admission.js";

// ------------------------------------------------------------------ startup

export type StartupReadback =
  | { state: "reading" }
  | { state: "read"; at: string; rigName: string; seat: StartupSeat | null; selectionChanged: boolean }
  | { state: "failed"; at: string; message: string }
  /** Not read: the current source is not the attempt's original connected instance
   * (or is unknown/remote/stale). The receipt is kept exactly as settled. */
  | { state: "deferred"; at: string; reason: string };

export interface StartupAttemptRecord {
  readonly id: string;
  /** Connected instance the attempt was sent to. Readback is refused under another. */
  readonly connectionKey: string;
  readonly request: StartupSurfaceInput;
  /** Immutable identity captured before transport (selection, action, revision). */
  readonly attempt: StartupOperationAttempt;
  readonly submittedAt: string;
  readonly status: "pending" | "succeeded" | "rejected" | "outcome_unknown";
  readonly settledAt?: string;
  readonly receipt?: { result: StartupResult; status: number };
  readonly error?: StartupOperationError;
  readonly readback?: StartupReadback;
}

export interface ChooserContextState {
  rigId: string | null;
  nodeId: string | null;
  rigFilter: string;
  seatFilter: string;
  rigScroll: number;
  seatScroll: number;
}
const initialChooser: ChooserContextState = { rigId: null, nodeId: null, rigFilter: "", seatFilter: "", rigScroll: 0, seatScroll: 0 };

export type SubmitOutcome = { ok: true; recordId: string } | { ok: false; reason: string };

// -------------------------------------------------------------------- fleet

export interface FleetKickoffRecord {
  readonly status: "pending" | "accepted" | "rejected" | "outcome_unknown";
  readonly connectionKey: string;
  readonly submittedAt: string;
  readonly settledAt?: string;
  readonly handle?: FleetRestoreHandle;
  readonly retentionError?: string | null;
  readonly error?: StartupOperationError;
  /** A lost kickoff must be acknowledged before another deliberate kickoff. */
  readonly acknowledged: boolean;
}

export interface FleetCancelRecord {
  readonly handle: FleetRestoreHandle;
  readonly status: "pending" | "accepted" | "rejected" | "outcome_unknown";
  readonly requestedAt: string;
  readonly settledAt?: string;
  readonly error?: StartupOperationError;
}

const now = () => new Date().toISOString();
const MAX_STARTUP_RECORDS = 25;

function errorStatus(error: unknown): StartupAttemptRecord["status"] | "drop" {
  if (!(error instanceof StartupOperationError)) return "outcome_unknown";
  if (error.code === "operation_in_progress") return "drop";
  if (error.code === "rejected" || error.code === "invalid_request" || error.code === "unsupported_scope") return "rejected";
  return "outcome_unknown";
}

function frozenAttempt(request: StartupSurfaceInput): StartupOperationAttempt {
  if (request.kind === "seat") return startupActionAttempt(request.input);
  if (request.kind === "terminal") return Object.freeze({ kind: "terminal" as const, payload: Object.freeze({}) });
  return Object.freeze({ kind: "kernel" as const, payload: Object.freeze({ runtime: request.runtime }) });
}

function useRecoveryValue(pollOptions?: FleetRestorePollOptions) {
  const client = useQueryClient();
  const hosts = useHosts();
  const instanceName = hosts.data ? (hosts.data.ownName?.trim() || null) : null;
  const hostsError = hosts.error instanceof Error ? hosts.error : null;
  const stale = !!hosts.data && hosts.isError;
  const selection: ConnectedSelection = !hosts.data
    ? { state: "unknown", error: hostsError }
    : hosts.data.selected === LOCAL_HOST_ID
      ? { state: "local", instanceName, stale, error: hostsError }
      : { state: "remote", hostId: hosts.data.selected, instanceName, stale, error: hostsError };
  // Observation of an already-retained attempt continues on the last known
  // local selection; NEW effects additionally require a current selection read.
  const local = selection.state === "local";
  const refusal = selection.state === "remote" ? `Topology is viewing remote host ${selection.hostId}. Startup and fleet restore act only on the connected instance; select the local host first.`
    : selection.state === "unknown" ? "Reading the host selection; no connected-instance effect is sent until it is known to be local."
    : selection.stale ? "The host selection could not be re-read, so it is not known to still be local. Nothing is sent until it reads again."
    : null;

  const connectionKey = hosts.data ? fleetConnectionKey(currentOrigin(), instanceName) : null;

  // ---------------------------------------------------------------- startup
  const lane = useStartupActions(LOCAL_OPERATOR_INSTANCE);
  const laneRef = useRef(lane); laneRef.current = lane;
  const startupInflight = useRef(false);
  const seq = useRef(0);
  const [startupRecords, setStartupRecords] = useState<StartupAttemptRecord[]>([]);
  const [chooser, setChooser] = useState<ChooserContextState>(initialChooser);
  const updateChooser = useCallback((patch: Partial<ChooserContextState>) => setChooser(previous => ({ ...previous, ...patch })), []);
  const patchRecord = useCallback((id: string, patch: Partial<StartupAttemptRecord>) =>
    setStartupRecords(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row)), []);

  // Readback is bound to the attempt's ORIGINAL connection. It is admitted
  // against the current host cache before the GET and again when the GET
  // settles, so a late completion never reads A's seat from instance B, and a
  // connection change during the read never attaches B's facts to A's receipt.
  const readBack = useCallback((id: string, attempt: StartupOperationAttempt, originalConnection: string): SubmitOutcome => {
    if (attempt.kind !== "seat") return { ok: false, reason: "Only seat attempts are read back." };
    const before = admitConnectedLocal(client, originalConnection);
    if (!before.ok) {
      patchRecord(id, { readback: { state: "deferred", at: now(), reason: before.reason } });
      return { ok: false, reason: before.reason };
    }
    patchRecord(id, { readback: { state: "reading" } });
    const settle = (readback: StartupReadback) => {
      const after = admitConnectedLocal(client, originalConnection);
      patchRecord(id, { readback: after.ok ? readback : { state: "deferred", at: now(), reason: `The source changed while reading; the result was discarded. ${after.reason}` } });
    };
    reconcileStartupAttempt(LOCAL_OPERATOR_INSTANCE, attempt)
      .then(read => settle({ state: "read", at: now(), rigName: read.rig.rigName, seat: read.seat, selectionChanged: read.selectionChanged }))
      .catch((error: unknown) => settle({ state: "failed", at: now(), message: error instanceof Error ? error.message : "Readback failed." }));
    return { ok: true, recordId: id };
  }, [patchRecord, client]);

  const submitStartup = useCallback((request: StartupSurfaceInput): SubmitOutcome => {
    if (!connectionKey) return { ok: false, reason: "The connected instance identity is not known yet." };
    // Current cache, not the rendered closure, authorizes the effect.
    const admission = admitConnectedLocal(client, connectionKey);
    if (!admission.ok) return { ok: false, reason: admission.reason };
    if (refusal) return { ok: false, reason: refusal };
    if (startupInflight.current || laneRef.current.operationPending)
      return { ok: false, reason: "Another startup effect is still awaiting its exact result." };
    let attempt: StartupOperationAttempt;
    try { attempt = frozenAttempt(request); }
    catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "The request could not be prepared." }; }
    const id = `startup-${++seq.current}`;
    startupInflight.current = true;
    const record: StartupAttemptRecord = { id, connectionKey, request, attempt, submittedAt: now(), status: "pending" };
    // Never evict a pending or unknown attempt to make room: those are exactly
    // the records an operator must still be able to inspect.
    setStartupRecords(rows => {
      const next = [record, ...rows];
      while (next.length > MAX_STARTUP_RECORDS) {
        const index = next.map(row => row.status).lastIndexOf("succeeded");
        const evict = index >= 0 ? index : next.map(row => row.status).lastIndexOf("rejected");
        if (evict < 0) break;
        next.splice(evict, 1);
      }
      return next;
    });
    laneRef.current.mutateAsync(request)
      .then(receipt => {
        patchRecord(id, { status: "succeeded", settledAt: now(), receipt: { result: receipt.result, status: receipt.status } });
        // Kernel preparation only prepares topology: select its exact rig so
        // the operator inspects it and chooses a seat deliberately.
        if (request.kind === "kernel" && typeof receipt.result.rigId === "string")
          setChooser(previous => ({ ...previous, rigId: receipt.result.rigId as string, nodeId: null, seatScroll: 0 }));
        readBack(id, attempt, connectionKey);
      })
      .catch((error: unknown) => {
        const status = errorStatus(error);
        if (status === "drop") { setStartupRecords(rows => rows.filter(row => row.id !== id)); return; }
        patchRecord(id, { status, settledAt: now(), error: error instanceof StartupOperationError ? error
          : new StartupOperationError("outcome_unknown", "The response could not be read; the operation may have taken effect.", attempt) });
        readBack(id, attempt, connectionKey);
      })
      .finally(() => { startupInflight.current = false; });
    return { ok: true, recordId: id };
  }, [refusal, connectionKey, patchRecord, readBack, client]);

  const rereadStartup = useCallback((id: string): SubmitOutcome => {
    const record = startupRecords.find(row => row.id === id);
    if (!record) return { ok: false, reason: "That attempt is no longer retained." };
    if (record.connectionKey !== connectionKey)
      return { ok: false, reason: "This attempt was sent to a different connected instance; it is not read back against this one." };
    if (!local) return { ok: false, reason: refusal ?? "The host selection is not local." };
    // readBack re-admits the record's original connection against the current cache.
    return readBack(id, record.attempt, record.connectionKey);
  }, [startupRecords, readBack, connectionKey, local, refusal]);

  // ------------------------------------------------------------------ fleet
  const key = connectionKey ?? "";
  const stored = useFleetRestoreAttempt(key);
  const storedRef = useRef(stored); storedRef.current = stored;
  const kickoff = useFleetRestoreKickoff(key, LOCAL_OPERATOR_INSTANCE);
  const kickoffRef = useRef(kickoff); kickoffRef.current = kickoff;
  const cancel = useFleetRestoreCancel(key, LOCAL_OPERATOR_INSTANCE);
  const cancelRef = useRef(cancel); cancelRef.current = cancel;
  const kickoffInflight = useRef(false);
  const cancelInflight = useRef(false);
  const [accepted, setAccepted] = useState<{ handle: FleetRestoreHandle; retentionError: string | null; acceptedAt: string } | null>(null);
  const [kickoffRecord, setKickoffRecord] = useState<FleetKickoffRecord | null>(null);
  const [cancelRecord, setCancelRecord] = useState<FleetCancelRecord | null>(null);
  const [pausedAttempt, setPausedAttempt] = useState<string | null>(null);

  // The in-memory accepted handle survives a sessionStorage failure; the stored
  // handle covers reload. A handle accepted under another key is never observed here.
  const handle = accepted && accepted.handle.connectionKey === key ? accepted.handle : stored.handle;
  const foreignHandle = accepted && connectionKey && accepted.handle.connectionKey !== connectionKey ? accepted.handle : null;
  const observedHandle = local && connectionKey && handle ? handle : null;
  const status = useFleetRestoreStatus(key, observedHandle, LOCAL_OPERATOR_INSTANCE, pollOptions);
  const statusRef = useRef(status); statusRef.current = status;
  const observation = status.data;
  const unknownToDaemon = status.frame?.phase === "unavailable";
  const done = observation?.done === true;

  // A replaced handle starts with fresh operator observation intent.
  useEffect(() => { setPausedAttempt(previous => previous && previous !== handle?.fleetAttemptId ? null : previous); }, [handle?.fleetAttemptId]);

  const kickoffFleet = useCallback((): SubmitOutcome => {
    if (!connectionKey) return { ok: false, reason: "The connected instance identity is not known yet." };
    const admission = admitConnectedLocal(client, connectionKey);
    if (!admission.ok) return { ok: false, reason: admission.reason };
    if (refusal) return { ok: false, reason: refusal };
    if (kickoffInflight.current || kickoffRef.current.operationPending) return { ok: false, reason: "A restore kickoff is still awaiting its response." };
    if (handle && !done && !unknownToDaemon)
      return { ok: false, reason: "A retained restore attempt has not reported done. Observe it, or forget it deliberately, before starting another." };
    if (kickoffRecord?.status === "outcome_unknown" && !kickoffRecord.acknowledged)
      return { ok: false, reason: "The last kickoff response was lost. Acknowledge that a restore may already be running before starting another." };
    kickoffInflight.current = true;
    const submittedAt = now();
    setKickoffRecord({ status: "pending", connectionKey, submittedAt, acknowledged: false });
    kickoffRef.current.mutateAsync(undefined)
      .then(receipt => {
        const retentionError = receipt.retentionError?.message ?? null;
        // A newly accepted attempt starts from its own first read, never from a
        // cached observation that happens to share its ID.
        client.removeQueries({ queryKey: fleetRestoreQueryKey(LOCAL_OPERATOR_INSTANCE, receipt.handle.connectionKey, receipt.handle.fleetAttemptId), exact: true });
        try { storedRef.current.retain(receipt.handle); } catch { /* foreign key after reconnect: keep in-memory handle */ }
        setAccepted({ handle: receipt.handle, retentionError, acceptedAt: now() });
        setCancelRecord(null);
        setPausedAttempt(null);
        setKickoffRecord({ status: "accepted", connectionKey, submittedAt, settledAt: now(), handle: receipt.handle, retentionError, acknowledged: false });
      })
      .catch((error: unknown) => {
        const failure = errorStatus(error);
        if (failure === "drop") { setKickoffRecord(null); return; }
        setKickoffRecord({ status: failure === "rejected" ? "rejected" : "outcome_unknown", connectionKey, submittedAt, settledAt: now(), acknowledged: false,
          error: error instanceof StartupOperationError ? error : new StartupOperationError("outcome_unknown", "The kickoff response could not be read.") });
      })
      .finally(() => { kickoffInflight.current = false; });
    return { ok: true, recordId: submittedAt };
  }, [refusal, connectionKey, handle, done, unknownToDaemon, kickoffRecord, client]);

  const acknowledgeLostKickoff = useCallback(() => setKickoffRecord(previous => previous ? { ...previous, acknowledged: true } : previous), []);

  const cancelReadSince = cancelRecord?.status === "outcome_unknown" && cancelRecord.settledAt
    ? status.dataUpdatedAt > Date.parse(cancelRecord.settledAt) : true;
  const requestCancel = useCallback((): SubmitOutcome => {
    if (!observedHandle) return { ok: false, reason: "No restore attempt is observed on this connected instance." };
    // The stop must reach the instance that accepted this exact handle.
    const admission = admitConnectedLocal(client, observedHandle.connectionKey);
    if (!admission.ok) return { ok: false, reason: admission.reason };
    if (refusal) return { ok: false, reason: refusal };
    if (cancelInflight.current || cancelRef.current.operationPending) return { ok: false, reason: "A stop request is still awaiting its response." };
    if (done) return { ok: false, reason: "The daemon already reported this attempt done." };
    if (unknownToDaemon) return { ok: false, reason: "This daemon no longer knows the attempt; a stop request cannot reach it." };
    if (!cancelReadSince) return { ok: false, reason: "Read the current status after the lost stop response before requesting stop again." };
    const target = observedHandle;
    cancelInflight.current = true;
    const requestedAt = now();
    setCancelRecord({ handle: target, status: "pending", requestedAt });
    // Stop-before-next-rig still needs observation until served done.
    if (statusRef.current.detached) { setPausedAttempt(null); void statusRef.current.reattach(); }
    cancelRef.current.mutateAsync(target)
      .then(() => setCancelRecord({ handle: target, status: "accepted", requestedAt, settledAt: now() }))
      .catch((error: unknown) => {
        const failure = errorStatus(error);
        if (failure === "drop") return;
        setCancelRecord({ handle: target, status: failure === "rejected" ? "rejected" : "outcome_unknown", requestedAt, settledAt: now(),
          error: error instanceof StartupOperationError ? error : new StartupOperationError("outcome_unknown", "The stop response could not be read.") });
      })
      .finally(() => { cancelInflight.current = false; });
    return { ok: true, recordId: requestedAt };
  }, [refusal, observedHandle, done, unknownToDaemon, cancelReadSince, client]);

  const pauseObservation = useCallback(() => {
    if (!observedHandle) return;
    setPausedAttempt(observedHandle.fleetAttemptId);
    statusRef.current.detach();
  }, [observedHandle]);
  const resumeObservation = useCallback(() => {
    setPausedAttempt(null);
    void statusRef.current.reattach(); // the same exact GET; never a kickoff
  }, []);

  const forgetFleetAttempt = useCallback(() => {
    if (kickoffInflight.current || cancelInflight.current) return;
    storedRef.current.clear();
    setAccepted(null); setKickoffRecord(null); setCancelRecord(null); setPausedAttempt(null);
  }, []);

  // A stop request belongs to its exact handle; never show it against another.
  const currentCancel = cancelRecord && handle && cancelRecord.handle.fleetAttemptId === handle.fleetAttemptId
    && cancelRecord.handle.connectionKey === handle.connectionKey ? cancelRecord : null;

  return {
    selection, refusal, connectionKey,
    startup: {
      records: startupRecords,
      operationPending: lane.operationPending || startupRecords.some(row => row.status === "pending"),
      submit: submitStartup, reread: rereadStartup,
      chooser, updateChooser,
    },
    fleet: {
      handle, foreignHandle, observedHandle,
      acceptedRetentionError: accepted && accepted.handle.connectionKey === key ? accepted.retentionError : null,
      storageError: stored.retentionError?.message ?? null,
      kickoff: kickoffRecord, kickoffPending: kickoff.operationPending || kickoffRecord?.status === "pending",
      cancel: currentCancel, cancelPending: cancel.operationPending || cancelRecord?.status === "pending", cancelReadSince,
      status, observation, done, unknownToDaemon,
      pausedByOperator: !!handle && pausedAttempt === handle.fleetAttemptId,
      start: kickoffFleet, acknowledgeLostKickoff, requestCancel, pauseObservation, resumeObservation, forget: forgetFleetAttempt,
    },
  };
}

export type RecoveryOperations = ReturnType<typeof useRecoveryValue>;
const RecoveryContext = createContext<RecoveryOperations | null>(null);

export function RecoveryOperationsProvider({ children, pollOptions }: { children: ReactNode; pollOptions?: FleetRestorePollOptions }) {
  const value = useRecoveryValue(pollOptions);
  return <RecoveryContext.Provider value={value}>{children}</RecoveryContext.Provider>;
}

export function useRecoveryOperations(): RecoveryOperations {
  const value = useContext(RecoveryContext);
  if (!value) throw new Error("RecoveryOperationsProvider must wrap the route Outlet so pending startup and restore attempts outlive their pages.");
  return value;
}
