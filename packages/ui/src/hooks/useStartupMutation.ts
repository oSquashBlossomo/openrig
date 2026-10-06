import { useRef, useState } from "react";
import { useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { StartupOperationError } from "../lib/startup-operations.js";

/** Acquire the effect lane BEFORE React Query creates a new mutation/observer.
 * Refusing inside mutationFn prevents duplicate POSTs but loses the accepted
 * first receipt when the observer switches to the refused second invocation. */
export function useStartupMutation<T, V>(options: Omit<UseMutationOptions<T, StartupOperationError, V>, "retry" | "mutationFn"> & {
  mutationFn: (variables: V) => Promise<T>; prepareVariables?: (variables: V) => V;
}) {
  const busy = useRef(false); const [operationPending, setPending] = useState(false);
  const mutation = useMutation<T, StartupOperationError, V>({ ...options, retry: false,
    onSettled: async (...args) => {
      try { await options.onSettled?.(...args); }
      finally { busy.current = false; setPending(false); }
    },
  });
  const begin = (variables: V) => {
    const prepared = options.prepareVariables ? options.prepareVariables(variables) : variables;
    busy.current = true; setPending(true); return prepared;
  };
  const mutate: typeof mutation.mutate = (variables, callbacks) => {
    if (busy.current) return; // repeated UI input cannot steal the first observer
    mutation.mutate(begin(variables), callbacks);
  };
  const mutateAsync: typeof mutation.mutateAsync = (variables, callbacks) => {
    if (busy.current) return Promise.reject(new StartupOperationError("operation_in_progress", "An operation is still awaiting its exact result."));
    try { return mutation.mutateAsync(begin(variables), callbacks); }
    catch (error) { return Promise.reject(error); }
  };
  return { ...mutation, mutate, mutateAsync, operationPending, reset: () => { if (!busy.current) mutation.reset(); } };
}
