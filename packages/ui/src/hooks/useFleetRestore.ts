import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStartupMutation } from "./useStartupMutation.js";
import { operatorScopeKey, operatorScopeState, OperatorReadError, type OperatorInstanceScope } from "../lib/operator-read.js";
import { kickoffFleetRestore, cancelFleetRestore, readFleetRestoreStatus, isFleetRestoreHandle, fleetRestoreFrame,
  StartupOperationError, type FleetRestoreHandle } from "../lib/startup-operations.js";
export const fleetRestoreQueryKey = (scope: OperatorInstanceScope, connectionKey: string, attemptId?: string | null) => ["fleet-restore", ...operatorScopeKey(scope), connectionKey, attemptId] as const;

export function useFleetRestoreKickoff(connectionKey: string, scope: OperatorInstanceScope) {
  const mutation = useStartupMutation({ mutationKey: ["fleet-restore", ...operatorScopeKey(scope), connectionKey, "kickoff"],
    mutationFn: async () => {
      const receipt = await kickoffFleetRestore(scope, connectionKey);
      // Retain before returning, including when the requesting view detached.
      // Per-call observer callbacks do not survive unmount reliably.
      return { ...receipt, retentionError: saveHandle(receipt.handle) };
    },
  });
  return { ...mutation, ...operatorScopeState(scope) };
}
export function useFleetRestoreCancel(connectionKey: string, scope: OperatorInstanceScope) {
  const client = useQueryClient();
  const mutation = useStartupMutation({ mutationKey: ["fleet-restore", ...operatorScopeKey(scope), connectionKey, "cancel"],
    mutationFn: (handle: FleetRestoreHandle) => cancelFleetRestore(scope, connectionKey, handle),
    prepareVariables: handle => Object.freeze({ ...handle }),
    onSettled: (_result, _error, handle) => { if (isFleetRestoreHandle(handle) && handle.connectionKey === connectionKey) void client.invalidateQueries({ queryKey: fleetRestoreQueryKey(scope, connectionKey, handle.fleetAttemptId) }); },
  });
  return { ...mutation, ...operatorScopeState(scope) };
}
export interface FleetRestorePollOptions { pollIntervalMs?: number; maxPolls?: number; maxConsecutiveErrors?: number }
const bounded = (v: number | undefined, fallback: number) => Number.isSafeInteger(v) && v! > 0 ? v! : fallback;
/** Each GET is independently bounded/cancellable. Transient failures keep the
 * same handle; sustained failure/ceiling detaches the view, not the conductor. */
export function useFleetRestoreStatus(connectionKey: string, handle: FleetRestoreHandle | null, scope: OperatorInstanceScope, options: FleetRestorePollOptions = {}) {
  const client = useQueryClient(); const queryKey = fleetRestoreQueryKey(scope, connectionKey, handle?.fleetAttemptId ?? null);
  const identity = JSON.stringify(queryKey); const current = useRef(identity); current.current = identity;
  const [life, setLife] = useState({ identity, polls: 0, failures: 0, detached: false });
  const state = life.identity === identity ? life : { identity, polls: 0, failures: 0, detached: false };
  const scopeState = operatorScopeState(scope);
  const valid = isFleetRestoreHandle(handle) && handle.connectionKey === connectionKey;
  const scopeError = scopeState.scopeError ?? (!valid && handle ? new OperatorReadError("invalid_request", "This restore handle belongs to another connected instance.") : null);
  const maxPolls = bounded(options.maxPolls, 4500); const maxErrors = bounded(options.maxConsecutiveErrors, 5);
  const record = (failed: boolean) => {
    if (current.current !== identity) return;
    setLife(previous => {
      const before = previous.identity === identity ? previous : { identity, polls: 0, failures: 0, detached: false };
      const polls = before.polls + 1, failures = failed ? before.failures + 1 : 0;
      return { identity, polls, failures, detached: before.detached || polls >= maxPolls || failures >= maxErrors };
    });
  };
  const query = useQuery({ queryKey, enabled: scopeState.scopeSupported && valid && !state.detached,
    retry: false, staleTime: 0, placeholderData: undefined, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      try { const status = await readFleetRestoreStatus(scope, connectionKey, handle!, { signal }); record(false); return status; }
      catch (error) { if (!(error instanceof OperatorReadError && error.code === "cancelled")) record(true); throw error; }
    },
    refetchInterval: observed => observed.state.data?.done || observed.state.error instanceof OperatorReadError && observed.state.error.status === 404
      ? false : bounded(options.pollIntervalMs, 400),
  });
  const unavailable = query.error instanceof OperatorReadError && query.error.status === 404;
  return { ...query, ...scopeState, scopeError,
    frame: handle ? scopeState.scopeSupported && valid ? { ...fleetRestoreFrame(handle, query.data, state.detached), ...(unavailable ? { phase: "unavailable" as const } : {}) }
      : { handle, observation: undefined, phase: "unavailable" as const } : null,
    detached: state.detached, polls: state.polls,
    detach: () => { setLife({ ...state, detached: true }); void client.cancelQueries({ queryKey, exact: true }); },
    reattach: () => {
      setLife({ identity, polls: 0, failures: 0, detached: false });
      return query.refetch(); // same exact GET; never kickoff
    },
  };
}

const storageKey = (connectionKey: string) => `openrig.fleetRestoreAttempt:${encodeURIComponent(connectionKey)}`;
function saveHandle(handle: FleetRestoreHandle): Error | null {
  try { window.sessionStorage.setItem(storageKey(handle.connectionKey), JSON.stringify(handle)); return null; }
  catch { return new Error("The accepted restore handle could not be saved for reload; retain the returned exact handle."); }
}
function loadHandle(connectionKey: string): { handle: FleetRestoreHandle | null; retentionError: Error | null } {
  try {
    if (typeof window === "undefined") return { handle: null, retentionError: null };
    const raw = window.sessionStorage.getItem(storageKey(connectionKey));
    const value: unknown = raw ? JSON.parse(raw) : null;
    return { handle: isFleetRestoreHandle(value) && value.connectionKey === connectionKey ? Object.freeze({ connectionKey, fleetAttemptId: value.fleetAttemptId }) : null, retentionError: null };
  } catch { return { handle: null, retentionError: new Error("The retained restore handle could not be read from browser storage.") }; }
}
/** Retains only the accepted opaque handle, never native history or credentials.
 * A lost kickoff response has nothing to retain. Daemon restart still loses its
 * in-memory attempt; retention is not server recovery or idempotency. */
export function useFleetRestoreAttempt(connectionKey: string) {
  const [stored, setStored] = useState(() => ({ connectionKey, ...loadHandle(connectionKey) }));
  useEffect(() => { setStored({ connectionKey, ...loadHandle(connectionKey) }); }, [connectionKey]);
  const selected = stored.connectionKey === connectionKey ? stored : { handle: null, retentionError: null };
  return { ...selected,
    retain: (handle: FleetRestoreHandle) => {
      if (!isFleetRestoreHandle(handle) || handle.connectionKey !== connectionKey) throw new StartupOperationError("invalid_request", "Do not retain another instance's restore handle.");
      const retained = Object.freeze({ connectionKey, fleetAttemptId: handle.fleetAttemptId }); const retentionError = saveHandle(retained);
      setStored({ connectionKey, handle: retained, retentionError });
    },
    clear: () => {
      let retentionError: Error | null = null;
      try { window.sessionStorage.removeItem(storageKey(connectionKey)); }
      catch { retentionError = new Error("The old restore handle could not be cleared from browser storage."); }
      setStored({ connectionKey, handle: null, retentionError });
    },
  };
}
