// Target-bound workflow mutation outcomes. Every submitted attempt is filed
// under the immutable (scope, instance, kind) it was SENT to, before the POST
// leaves. Its pending/unknown/settled outcome is written back to that same
// entry when the request settles, even if the user has navigated elsewhere or
// the panel unmounted. A panel shows only its own instance's entry as
// actionable; another instance's uncertain attempt is shown as a pointer back
// to that exact instance, never resubmitted from here.
//
// The ledger lives beside the QueryClient (one per app/test client) for the
// life of the page. A full reload discards it; the daemon's operation and
// occurrence records remain the durable source for readback.

import { useCallback, useState, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { operatorScopeKey, type OperatorInstanceScope } from "../../lib/operator-read.js";

// "resume-sequential" is filed separately from occurrence resume: its attempt
// carries an expected failure, never an occurrence ID.
export type WorkflowMutationKind = "resume" | "resume-sequential" | "revision" | "abort";

export interface RecoveryTarget {
  readonly scope: OperatorInstanceScope;
  readonly instanceId: string;
  readonly kind: WorkflowMutationKind;
}

export function recoveryTarget(scope: OperatorInstanceScope, instanceId: string, kind: WorkflowMutationKind): RecoveryTarget {
  return Object.freeze({ scope, instanceId, kind });
}

export function recoveryTargetKey(target: RecoveryTarget): string {
  return JSON.stringify([target.kind, ...operatorScopeKey(target.scope), target.instanceId]);
}

export function sameTarget(a: RecoveryTarget, b: RecoveryTarget): boolean {
  return recoveryTargetKey(a) === recoveryTargetKey(b);
}

export interface LedgerEntry<O = unknown> {
  readonly target: RecoveryTarget;
  readonly outcome: O;
  /** When this outcome was recorded in this browser. */
  readonly at: string;
}

type Listener = () => void;

class RecoveryLedger {
  private entries: ReadonlyMap<string, LedgerEntry> = new Map();
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = () => this.entries;

  write(target: RecoveryTarget, outcome: unknown | undefined) {
    const next = new Map(this.entries);
    const key = recoveryTargetKey(target);
    if (outcome === undefined) next.delete(key);
    else next.set(key, Object.freeze({ target, outcome, at: new Date().toISOString() }));
    this.entries = next;
    for (const listener of this.listeners) listener();
  }
}

const ledgers = new WeakMap<QueryClient, RecoveryLedger>();

function ledgerFor(client: QueryClient): RecoveryLedger {
  let ledger = ledgers.get(client);
  if (!ledger) { ledger = new RecoveryLedger(); ledgers.set(client, ledger); }
  return ledger;
}

export type LedgerWriter<O> = (outcome: O | undefined) => void;

/** All entries, re-rendering on change. */
export function useRecoveryLedger() {
  const ledger = ledgerFor(useQueryClient());
  const entries = useSyncExternalStore(ledger.subscribe, ledger.snapshot, ledger.snapshot);
  /** A writer bound to `target` now; later navigation cannot redirect it. */
  const writerFor = useCallback(<O,>(target: RecoveryTarget): LedgerWriter<O> => (outcome) => ledger.write(target, outcome), [ledger]);
  return { entries, writerFor };
}

/** The entry for exactly `target`, plus a writer bound to that target. */
export function useRecoveryEntry<O>(target: RecoveryTarget): { entry: LedgerEntry<O> | undefined; write: LedgerWriter<O>; writerFor: <T>(t: RecoveryTarget) => LedgerWriter<T> } {
  const { entries, writerFor } = useRecoveryLedger();
  const key = recoveryTargetKey(target);
  const entry = entries.get(key) as LedgerEntry<O> | undefined;
  // The key fully identifies the target, so a new object for the same target
  // does not create a new writer.
  const write = useCallback<LedgerWriter<O>>((outcome) => writerFor<O>(target)(outcome), [key, writerFor]);
  return { entry, write, writerFor };
}

/** Same-kind, same-scope entries for OTHER instances that match `retained`. */
export function useOtherInstanceEntries<O>(target: RecoveryTarget, retained: (outcome: O) => boolean): LedgerEntry<O>[] {
  const { entries } = useRecoveryLedger();
  const scope = JSON.stringify(operatorScopeKey(target.scope));
  return [...entries.values()].filter((e): e is LedgerEntry<O> => e.target.kind === target.kind
    && JSON.stringify(operatorScopeKey(e.target.scope)) === scope && e.target.instanceId !== target.instanceId
    && retained(e.outcome as O));
}

/** View state that belongs to one target (e.g. the inspected proposal or the
 * chosen occurrence). It reads as `initial` under any other target, so a
 * route-param change can never carry a selection to another instance. */
export function useTargetState<T>(targetKey: string, initial: T): [T, (value: T) => void] {
  const [state, setState] = useState<{ key: string; value: T }>({ key: targetKey, value: initial });
  const value = state.key === targetKey ? state.value : initial;
  const set = useCallback((next: T) => setState({ key: targetKey, value: next }), [targetKey]);
  return [value, set];
}
