import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useGlobalEvents } from '../src/hooks/useGlobalEvents.js';
import { useRecentTransitions, useMaintainedStream } from '../src/hooks/useRecentTransitions.js';
import { usePulse } from '../src/hooks/usePulse.js';
import { LOCAL_OPERATOR_INSTANCE as local } from '../src/lib/operator-read.js';
import { recentPulseQueryKey } from '../src/lib/recent-pulse-contracts.js';

interface Read { url: string; signal: AbortSignal; completed: boolean }
let client: QueryClient;
let reads: Read[];
let delay: number;
let emit: (name: string, data?: string) => void;
let connections: number;
let closed: number;
const at = '2026-10-04T12:00:00.000Z';
const recentKey = recentPulseQueryKey(local, 'recent', 'instance', null, 20);
const streamKey = recentPulseQueryKey(local, 'stream', 'latest', 5, null, null, null, null, null, null, false);
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function event(type: string) {
  // Real queue.updated and seat.activity_changed lack rigId. Connected-instance
  // window refresh must not depend on optional entity chrome fields.
  act(() => emit('message', JSON.stringify({ type, qitemId: 'q-exact', sessionName: 'owner@rig' })));
}
async function setup(nextDelay = 200) {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); reads = []; delay = 200; connections = 0; closed = 0;
  vi.stubGlobal('EventSource', class {
    listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    constructor(url: string) { expect(url).toBe('/api/events'); connections++; emit = (name, data) => { for (const listener of this.listeners.get(name) ?? []) listener({ data }); }; }
    addEventListener(name: string, listener: (event: { data?: string }) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
    close() { closed++; }
  });
  vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => {
    const read: Read = { url, signal: options.signal as AbortSignal, completed: false }; reads.push(read);
    const stamp = new Date(Date.now()).toISOString();
    const parsed = new URL(url, 'http://private');
    const body = parsed.pathname === '/api/queue/recent-transitions' ? [{ transitionId: 1, qitemId: 'q-exact', ts: stamp, actorSession: 'owner@rig', change: 'claimed', summary: stamp, rig: 'rig', targetKind: 'qitem', target: 'q-exact' }]
      : parsed.pathname === '/api/stream/list' ? [{ streamItemId: 'stream-exact', tsEmitted: stamp, streamSortKey: 'sort-exact', sourceSession: 'owner@rig', body: stamp, format: 'text', hintType: null, hintUrgency: null, hintDestination: null, hintTags: null, interrupt: false, archivedAt: null }]
      : parsed.pathname === '/api/queue/list' && parsed.searchParams.get('state') === 'pending' ? [{ qitemId: 'q-exact', sourceSession: 'owner@rig', destinationSession: 'checker@rig', state: 'pending', priority: 'routine', tsCreated: stamp, tsUpdated: stamp, body: stamp, summary: null, blockedOn: null, handedOffTo: null, claimedAt: null }]
      : [];
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { read.completed = true; resolve(Response.json(body)); }, delay);
      read.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const events = renderHook(() => useGlobalEvents(), { wrapper });
  const reader = renderHook(() => ({ recent: { ...useRecentTransitions(local, { kind: 'instance' }) }, pulse: { ...usePulse(local) }, stream: { ...useMaintainedStream(local) } }), { wrapper });
  await tick(405);
  expect(reader.result.current.recent.rows[0]?.summary).toBe(at); expect(reader.result.current.pulse.status).toBe('ready');
  expect(reader.result.current.pulse.model?.upNext?.rows[0]?.body).toBe(at); expect(reader.result.current.stream.current?.rows[0]?.body).toBe(at);
  reads = []; delay = nextDelay;
  return { wrapper, events, reader };
}
function fresh(value: string | undefined) { expect(value).toMatch(/^2026-10-04T12:/); expect(value).not.toBe(at); }
function count(path: string) { return reads.filter(r => new URL(r.url, 'http://private').pathname === path).length; }
afterEach(() => { cleanup(); client?.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('connected-instance Recent/Pulse/stream SSE wiring', () => {
  it.each(['queue.updated', 'qitem.fallback_routed', 'inbox.absorbed'])('refreshes actual Recent and Pulse output on %s without rigId or a poll', async type => {
    const { reader } = await setup(); event(type); await tick(1_405);
    fresh(reader.result.current.recent.rows[0]?.summary ?? undefined); fresh(reader.result.current.pulse.model?.upNext?.rows[0]?.body);
    expect(reader.result.current.stream.current?.rows[0]?.body).toBe(at);
    expect(count('/api/queue/recent-transitions')).toBe(1); expect(count('/api/queue/list')).toBe(5); expect(count('/api/stream/list')).toBe(0); expect(connections).toBe(1);
  });
  it.each(['seat.activity_changed', 'seat.rung_health', 'node.startup_ready', 'session.detached', 'rig.stopped', 'pod.deleted', 'restore.completed', 'bootstrap.partial'])('refreshes only Pulse on lifecycle %s', async type => {
    const { reader } = await setup(); event(type); await tick(1_405);
    fresh(reader.result.current.pulse.model?.upNext?.rows[0]?.body); expect(reader.result.current.recent.rows[0]?.summary).toBe(at); expect(reader.result.current.stream.current?.rows[0]?.body).toBe(at);
    expect(count('/api/queue/list')).toBe(5); expect(count('/api/queue/recent-transitions')).toBe(0); expect(count('/api/stream/list')).toBe(0);
  });
  it('refreshes maintained stream on stream.emitted without refreshing unrelated windows', async () => {
    const { reader } = await setup(); event('stream.emitted'); await tick(1_405);
    fresh(reader.result.current.stream.current?.rows[0]?.body); expect(reader.result.current.recent.rows[0]?.summary).toBe(at); expect(reader.result.current.pulse.model?.upNext?.rows[0]?.body).toBe(at);
    expect(reads).toHaveLength(1); expect(count('/api/stream/list')).toBe(1);
  });
  it('refreshes all three only after reconnect, coalescing bursts with a non-cancelling trailing read', async () => {
    const { reader } = await setup(1_500);
    act(() => emit('open')); await tick(1_000); expect(reads).toHaveLength(0);
    for (let i = 0; i < 30; i++) { event('queue.updated'); event('stream.emitted'); }
    await tick(1_000); expect(reads).toHaveLength(7);
    for (let i = 0; i < 30; i++) { event('inbox.absorbed'); event('seat.activity_changed'); }
    act(() => { emit('error'); emit('open'); }); await tick(1_000);
    expect(reads).toHaveLength(7); expect(reads.every(r => !r.signal.aborted)).toBe(true);
    await tick(6_001);
    expect(count('/api/queue/recent-transitions')).toBe(2); expect(count('/api/stream/list')).toBe(2); expect(count('/api/queue/list')).toBe(10); expect(count('/api/rigs/summary')).toBe(2);
    expect(reads.every(r => r.completed && !r.signal.aborted)).toBe(true); expect(connections).toBe(1); expect(reader.result.current.pulse.isFetching).toBe(false); fresh(reader.result.current.recent.rows[0]?.summary ?? undefined);
  });
  it('marks inactive/disabled local windows stale while leaving remote and unrelated retained cache alone', async () => {
    const { wrapper } = await setup();
    const disabled = recentPulseQueryKey(local, 'stream', 'latest', 5, null, null, null, 'disabled', null, null, false);
    const inactive = recentPulseQueryKey(local, 'recent', 'rig', 'other:rig', 20);
    const remote = { kind: 'remote-instance', hostId: 'other' } as const;
    const remoteKeys = [recentPulseQueryKey(remote, 'pulse'), recentPulseQueryKey(remote, 'recent', 'instance', null, 20), recentPulseQueryKey(remote, 'stream', 'latest', 5, null, null, null, null, null, null, false)];
    client.setQueryData(disabled, client.getQueryData(streamKey)); client.setQueryData(inactive, client.getQueryData(recentKey));
    for (const key of remoteKeys) client.setQueryData(key, { retained: true });
    const unrelated = ['recent-pulse', 'operator', 'local-instance', 'unrelated']; client.setQueryData(unrelated, { retained: true });
    renderHook(() => useMaintainedStream(local, { hintTag: 'disabled' }, { enabled: false }), { wrapper });
    const remoteReader = renderHook(() => ({ pulse: usePulse(remote), recent: useRecentTransitions(remote, { kind: 'instance' }), stream: useMaintainedStream(remote) }), { wrapper });
    event('queue.updated'); event('stream.emitted'); await tick(1_405);
    expect(client.getQueryState(disabled)?.isInvalidated).toBe(true); expect(client.getQueryState(inactive)?.isInvalidated).toBe(true); expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
    act(() => { emit('open'); emit('error'); emit('open'); }); await tick(1_405);
    for (const key of remoteKeys) { expect(client.getQueryState(key)?.isInvalidated).toBe(false); expect(client.getQueryData(key)).toEqual({ retained: true }); }
    expect(remoteReader.result.current.pulse.current).toBeUndefined(); expect(remoteReader.result.current.recent.rows).toEqual([]); expect(remoteReader.result.current.stream.current).toBeUndefined();
    expect(reads.every(r => !r.url.includes('other') && !r.url.includes('disabled'))).toBe(true);
  });
  it('discards in-flight trailing work on event-owner unmount without cancelling surviving readers', async () => {
    const { events, reader } = await setup(1_500); event('stream.emitted'); await tick(1_000); event('stream.emitted'); await tick(1_000);
    events.unmount(); await tick(2_000);
    expect(count('/api/stream/list')).toBe(1); expect(reads.every(r => r.completed && !r.signal.aborted)).toBe(true); fresh(reader.result.current.stream.current?.rows[0]?.body); expect(closed).toBe(1);
  });
  it('cleans up an unflushed coalescing window', async () => {
    const { events } = await setup(); event('queue.updated'); event('stream.emitted'); events.unmount(); await tick(2_000);
    expect(reads).toHaveLength(0); expect(closed).toBe(1);
  });
  it('keeps quiet polling for all three windows when no event is emitted', async () => {
    const { reader } = await setup(); await tick(30_001);
    fresh(reader.result.current.recent.rows[0]?.summary ?? undefined); fresh(reader.result.current.stream.current?.rows[0]?.body);
    await tick(405); fresh(reader.result.current.pulse.model?.upNext?.rows[0]?.body);
    expect(count('/api/queue/recent-transitions')).toBe(1); expect(count('/api/stream/list')).toBe(1); expect(count('/api/queue/list')).toBe(5);
  });
});
