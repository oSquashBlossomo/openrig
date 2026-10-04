import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useRecentTransitions, useRecentTransitionSelection } from '../src/hooks/useRecentTransitions.js';
import { usePulse } from '../src/hooks/usePulse.js';
import { LOCAL_OPERATOR_INSTANCE as local } from '../src/lib/operator-read.js';
const row = { transitionId: 1, qitemId: 'exact', ts: '2026-10-04T00:00:00Z', actorSession: 'actor@rig', change: 'claimed', summary: null, rig: 'rig', targetKind: 'qitem', target: 'exact' };
let qc: QueryClient;
function setup() { qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, placeholderData: keepPreviousData } } }); return ({ children }: {
  children: ReactNode;
}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>; }
afterEach(() => { qc?.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('omits prior successful Recent after refresh error and preserves frozen original selection', async () => {
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async () => failed ? Response.json({ error: 'bad' }, { status: 503 }) : Response.json([row])));
  const { result } = renderHook(() => { const recent = useRecentTransitions(local, { kind: 'instance' }); const selection = useRecentTransitionSelection(local); return { recent, selection }; }, { wrapper: setup() });
  await waitFor(() => expect(result.current.recent.rows).toHaveLength(1));
  act(() => result.current.selection.select(result.current.recent.rows, 1));
  failed = true;
  await act(async () => { await qc.invalidateQueries({ queryKey: ['recent-pulse'] }); });
  await waitFor(() => expect(result.current.recent.status).toBe('error'));
  expect(result.current.recent.rows).toEqual([]);
  expect(result.current.selection.selected?.row).toEqual(row);
});
it('cancels old selection, defeats global placeholders, and never fetches foreign scope', async () => {
  let release!: (v: Response) => void;
  let signal!: AbortSignal;
  const fetch = vi.fn((_: string, init: RequestInit) => { signal = init.signal!; return new Promise<Response>(r => { release = r; }); });
  vi.stubGlobal('fetch', fetch);
  const { result, rerender } = renderHook(({ scope }) => useRecentTransitions(scope, { kind: 'instance' }), { initialProps: { scope: local as typeof local | {
        kind: 'remote-instance';
        hostId: string;
      } }, wrapper: setup() });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  rerender({ scope: { kind: 'remote-instance', hostId: 'foreign' } });
  expect(signal.aborted).toBe(true);
  expect(result.current.status).toBe('unsupported');
  expect(result.current.rows).toEqual([]);
  await act(async () => { release(Response.json([row])); });
  expect(result.current.rows).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('returns named partial Pulse source failures rather than cached current evidence', async () => {
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => failed ? Response.json({ error: 'bad' }, { status: 503 }) : Response.json([])));
  const { result } = renderHook(() => usePulse(local), { wrapper: setup() });
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.model?.upNext?.totalCount).toBe(0);
  failed = true;
  await act(async () => { await qc.invalidateQueries({ queryKey: ['recent-pulse'] }); });
  await waitFor(() => expect(result.current.status).toBe('error'));
  expect(result.current.model).toBeNull();
  expect(result.current.sources?.pending.state).toBe('unavailable');
});
it('aborts Pulse reads on unmount', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((_: string, init: RequestInit) => { signals.push(init.signal!); return new Promise<Response>(() => { }); }));
  const { unmount } = renderHook(() => usePulse(local), { wrapper: setup() });
  await waitFor(() => expect(signals).toHaveLength(5));
  unmount();
  expect(signals.every(s => s.aborted)).toBe(true);
});
it('preserves the independently successful NOW window when all queue sources fail', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/api/queue/list?')
    ? Response.json({ error: 'queue_unavailable' }, { status: 503 })
    : url.includes('/summary') ? Response.json([{ id: 'rig-id', name: 'rig' }])
    : Response.json([{ logicalId: 'pod.owner', nodeKind: 'agent', canonicalSessionName: 'owner@rig', terminalActive: true, lastActivityAt: null }])));
  const { result } = renderHook(() => usePulse(local), { wrapper: setup() });
  await waitFor(() => expect(result.current.current?.inventory.state).toBe('available'));
  expect(result.current.status).toBe('partial');
  expect(result.current.model?.now?.rows[0]).toMatchObject({ session: 'owner@rig', work: null, workSourceAvailable: false });
  expect(result.current.sourceErrors.map(row => row.source)).toEqual(['attention', 'blocked', 'inProgress', 'pending', 'finished']);
  expect(result.current.model?.waitingYou).toBeNull();
});
