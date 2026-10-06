import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { OPERATOR_QUERY_OPTIONS, operatorScopeState, OperatorReadError,
  type OperatorHookOptions, type OperatorInstanceScope } from "../lib/operator-read.js";
import { isSeatWorkTarget, isSeatWorkWindow, readSeatWorkWindow, SEAT_WORK_WINDOWS, seatWorkQueryKey,
  type SeatWorkTarget, type SeatWorkWindow, type SeatWorkWindowName } from "../lib/seat-work-reads.js";

export interface SeatWorkWindowRead {
  status: "unsupported" | "disabled" | "error" | "ready" | "loading";
  current: SeatWorkWindow | undefined;
  retained: SeatWorkWindow | undefined;
  error: Error | null;
  readAt: number | null;
  isFetching: boolean;
  refetch: UseQueryResult<SeatWorkWindow, Error>["refetch"];
}

/** Explicit local source and current admitted inventory identity. Call with null
 * target for unknown/failed identity. Each cache is exact rig/logical/session;
 * the existing shared Recent scheduler refreshes it without a new EventSource. */
export function useSeatWork(scope: OperatorInstanceScope, target: SeatWorkTarget | null, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const admitted = scopeState.scopeSupported && isSeatWorkTarget(target);
  const enabled = admitted && options.enabled !== false;
  const queries = useQueries({ queries: SEAT_WORK_WINDOWS.map(window => ({ ...OPERATOR_QUERY_OPTIONS,
    queryKey: seatWorkQueryKey(scope, target, window),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      if (options.enabled === false) throw new OperatorReadError("invalid_request", "Seat work read is disabled.");
      return readSeatWorkWindow(scope, target, window, { signal });
    }, enabled,
  })) });
  const project = (window: SeatWorkWindowName): SeatWorkWindowRead => {
    const query = queries[SEAT_WORK_WINDOWS.indexOf(window)]!;
    const verified = enabled && target && isSeatWorkWindow(query.data, target, window) ? query.data : undefined;
    const contractError = enabled && query.data !== undefined && !verified
      ? new OperatorReadError("invalid_contract", "Cached seat work does not match this exact admitted target.") : null;
    const error = !scopeState.scopeSupported ? scopeState.scopeError : query.error ?? contractError;
    const current = verified && !query.isError && !query.isPlaceholderData ? verified : undefined;
    const retained = verified && query.isError && !query.isPlaceholderData ? verified : undefined;
    const status = !scopeState.scopeSupported ? "unsupported" : !enabled ? "disabled" : error ? "error" : current ? "ready" : "loading";
    return { ...query, status, current, retained, error, readAt: current?.readAt ?? retained?.readAt ?? null };
  };
  const windows = { current: project("current"), pending: project("pending"), finished: project("finished") };
  const available = SEAT_WORK_WINDOWS.filter(window => windows[window].status === "ready").length;
  const failures = SEAT_WORK_WINDOWS.filter(window => windows[window].status === "error").length;
  const status = !scopeState.scopeSupported ? "unsupported" : !enabled ? "disabled"
    : available === SEAT_WORK_WINDOWS.length ? "ready" : available ? "partial" : failures === SEAT_WORK_WINDOWS.length ? "error" : "loading";
  return { ...scopeState, scope, target, status, windows,
    refetch: () => Promise.all(queries.map(query => query.refetch())) };
}
