import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OPERATOR_QUERY_OPTIONS, operatorScopeKey, operatorScopeState, type OperatorHookOptions, type OperatorInstanceScope } from '../lib/operator-read.js';
import { freezeRecentSelection, isRecentTransitions, readMaintainedStream, readRecentTransitions, recentPulseQueryKey, type RecentScope, type RecentTransition, type StreamFilter } from '../lib/recent-pulse-contracts.js';
export function useRecentTransitions(scope: OperatorInstanceScope, filter: RecentScope, options: OperatorHookOptions & {
  limit?: number;
  expanded?: boolean;
} = {}) {
  const scopeState = operatorScopeState(scope);
  const limit = options.limit ?? 20;
  const query = useQuery({ ...OPERATOR_QUERY_OPTIONS, queryKey: recentPulseQueryKey(scope, 'recent', filter.kind, filter.kind === 'rig' ? filter.rig : null, limit), queryFn: ({ signal }) => readRecentTransitions(scope, filter, limit, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  const current = scopeState.scopeSupported && !query.isError && !query.isPlaceholderData && isRecentTransitions(query.data) ? query.data : undefined;
  const status = !scopeState.scopeSupported ? 'unsupported' : query.isError ? 'error' : current ? 'ready' : query.data !== undefined ? 'error' : 'loading';
  return { ...query, ...scopeState, status, rows: current ?? [], visibleRows: options.expanded ? current ?? [] : (current ?? []).slice(-5), servedCount: current?.length ?? null, totalCount: null, possiblyBounded: current ? current.length >= limit : null };
}
export function useRecentTransitionSelection(scope: OperatorInstanceScope) {
  const [selection, setSelection] = useState<ReturnType<typeof freezeRecentSelection>>(null);
  const key = operatorScopeKey(scope).join('\0');
  return { selected: selection?.authorityKey === key ? selection : null, select: (rows: readonly RecentTransition[], id: number) => setSelection(freezeRecentSelection(scope, rows, id)), clear: () => setSelection(null) };
}
export function useMaintainedStream(scope: OperatorInstanceScope, filter: StreamFilter = {}, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery({ ...OPERATOR_QUERY_OPTIONS, queryKey: recentPulseQueryKey(scope, 'stream', filter.direction ?? 'latest', filter.limit ?? 5, filter.afterSortKey ?? null, filter.sourceSession ?? null, filter.hintDestination ?? null, filter.hintTag ?? null, filter.since ?? null, filter.until ?? null, !!filter.includeArchived), queryFn: ({ signal }) => readMaintainedStream(scope, filter, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  return { ...query, ...scopeState, current: scopeState.scopeSupported && !query.isError && !query.isPlaceholderData ? query.data : undefined };
}
