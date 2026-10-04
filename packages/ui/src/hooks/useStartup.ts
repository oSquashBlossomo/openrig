import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStartupMutation } from "./useStartupMutation.js";
import { operatorScopeKey, operatorScopeState, type OperatorInstanceScope } from "../lib/operator-read.js";
import { readStartupPrerequisites, readStartupRig, performStartupAction, startStartupTerminal, prepareStartupKernel,
  startupActionAttempt, type StartupActionInput, type StartupAction } from "../lib/startup-operations.js";
export * from "../lib/startup-operations.js";
export const startupQueryKey = (scope: OperatorInstanceScope, family: string, ...ids: unknown[]) => ["startup", ...operatorScopeKey(scope), family, ...ids] as const;
const queryOptions = { retry: false, staleTime: 10_000, placeholderData: undefined } as const;

export function useStartupPrerequisites(scope: OperatorInstanceScope) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery({ ...queryOptions, queryKey: startupQueryKey(scope, "prerequisites"), enabled: scopeState.scopeSupported,
    queryFn: ({ signal }) => readStartupPrerequisites(scope, { signal }) });
  return { ...query, ...scopeState };
}
export function useStartupRig(rigId: string | null, scope: OperatorInstanceScope) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery({ ...queryOptions, queryKey: startupQueryKey(scope, "rig", rigId), enabled: scopeState.scopeSupported && !!rigId,
    queryFn: ({ signal }) => readStartupRig(scope, rigId ?? "", { signal }) });
  return { ...query, ...scopeState };
}
/** One effect lane per hook. This local busy state is separate from
 * React Query's latest-call state, so a rejected double click cannot hide the
 * first operation that is still running. Back does not cancel daemon work. */
function useStartupOperation<T, V>(scope: OperatorInstanceScope, family: string, run: (input: V) => Promise<T>, prepareVariables?: (input: V) => V) {
  const client = useQueryClient();
  const mutation = useStartupMutation<T, V>({ mutationKey: startupQueryKey(scope, family), mutationFn: run, prepareVariables,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: startupQueryKey(scope, "rig") });
      void client.invalidateQueries({ queryKey: startupQueryKey(scope, "prerequisites") });
      // Scope-qualified startup reads own reconciliation. Existing topology
      // observers are merely invalidated; no mutation is replayed.
      if (scope.kind === "local-instance") { void client.invalidateQueries({ queryKey: ["rigs", "summary"] }); void client.invalidateQueries({ queryKey: ["ps"] }); }
    },
  });
  return { ...mutation, ...operatorScopeState(scope) };
}
function inputSnapshot(input: StartupActionInput): StartupActionInput {
  const attempt = startupActionAttempt(input);
  return Object.freeze({ selection: attempt.selection!, action: attempt.payload.action as StartupAction, ...(attempt.consent ? { consent: attempt.consent } : {}) });
}
export function useStartupAction(scope: OperatorInstanceScope) { return useStartupOperation(scope, "action", (input: StartupActionInput) => performStartupAction(scope, input), inputSnapshot); }
export function useStartupTerminal(scope: OperatorInstanceScope) { return useStartupOperation(scope, "terminal", () => startStartupTerminal(scope)); }
export function useStartupKernel(scope: OperatorInstanceScope) { return useStartupOperation(scope, "kernel", (runtime: "codex" | "claude-code") => prepareStartupKernel(scope, runtime)); }
export type StartupSurfaceInput = { kind: "seat"; input: StartupActionInput } | { kind: "terminal" } | { kind: "kernel"; runtime: "codex" | "claude-code" };
/** Recommended for a chooser that serializes all three actions in one lane. */
export function useStartupActions(scope: OperatorInstanceScope) {
  return useStartupOperation(scope, "surface-action", (request: StartupSurfaceInput) => request.kind === "seat" ? performStartupAction(scope, request.input)
    : request.kind === "terminal" ? startStartupTerminal(scope) : prepareStartupKernel(scope, request.runtime),
    request => Object.freeze(request.kind === "seat" ? { kind: "seat", input: inputSnapshot(request.input) } : { ...request }));
}
