import { useQuery } from '@tanstack/react-query';
import { OPERATOR_QUERY_OPTIONS, operatorScopeState, type OperatorHookOptions, type OperatorInstanceScope } from '../lib/operator-read.js';
import { readPulse, recentPulseQueryKey } from '../lib/recent-pulse-contracts.js';
export function usePulse(scope: OperatorInstanceScope, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery({ ...OPERATOR_QUERY_OPTIONS, queryKey: recentPulseQueryKey(scope, 'pulse'), queryFn: ({ signal }) => readPulse(scope, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  const current = scopeState.scopeSupported && !query.isError && !query.isPlaceholderData ? query.data : undefined;
  const successes = current ? Object.values(current.sources).filter(s => s.state === 'available').length : 0;
  const errors = current ? Object.entries(current.sources).filter(([, s]) => s.state === 'unavailable').map(([source, s]) => ({ source, error: s.error })) : [];
  if (current && current.inventory.state === 'unavailable')
    errors.push({ source: 'inventory', error: current.inventory.error });
  for (const row of current?.nodeSources ?? [])
    if (row.source.state === 'unavailable')
      errors.push({ source: `nodes:${row.rig.id}`, error: row.source.error });
  // NOW is independent pane evidence; unavailable queue work does not erase it.
  const hasUsableWindow = !!current && (successes > 0 || (!!current.model.now && (current.inventoryComplete || current.model.now.servedCount > 0)));
  const status = !scopeState.scopeSupported ? 'unsupported' : query.isError || (current && !hasUsableWindow) ? 'error' : !current ? 'loading' : errors.length || !current.inventoryComplete || Object.keys(current.blockerErrors).length || current.omittedBlockerIds.length ? 'partial' : 'ready';
  return { ...query, ...scopeState, status, current, model: status === 'error' ? null : current?.model ?? null, sources: current?.sources, sourceErrors: errors, inventoryComplete: current?.inventoryComplete ?? false, truncatedRigCount: current?.truncatedRigCount ?? 0 };
}
