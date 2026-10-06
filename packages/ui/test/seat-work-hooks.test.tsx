import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSeatWork } from "../src/hooks/useSeatWork.js";
import { useGlobalEvents } from "../src/hooks/useGlobalEvents.js";
import { LOCAL_OPERATOR_INSTANCE as local, type OperatorInstanceScope } from "../src/lib/operator-read.js";
import { seatWorkQueryKey } from "../src/lib/seat-work-reads.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";
const target = { rigId: "rig/exact", logicalId: "pod.owner", canonicalSessionName: "raw%2F/seat" };
const qitem = { qitemId: "qitem-exact", sourceSession: "source@fixture", destinationSession: target.canonicalSessionName,
  state: "in-progress", priority: "routine", tsCreated: "2026-10-05T00:00:00Z", tsUpdated: "2026-10-05T01:00:00Z",
  body: "Exact work", summary: null, blockedOn: null, handedOffTo: null, claimedAt: null };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, placeholderData: keepPreviousData } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps successful receipt distinct from failed warm refresh, preserves healthy siblings and recovers", async () => {
  let fail = false;
  const fetch = vi.fn(async (route: string) => {
    const state = new URL(route, "http://fixture").searchParams.get("state");
    if (state === "in-progress,blocked") return fail ? Response.json({ error: "private_failure" }, { status: 503 }) : Response.json([qitem]);
    return Response.json([]);
  }); vi.stubGlobal("fetch", fetch);
  const { wrapper, client } = setup(); const hook = renderHook(() => useSeatWork(local, target), { wrapper });
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  const first = hook.result.current.windows.current.current!; expect(first.rows[0]!.qitemId).toBe(qitem.qitemId);
  fail = true;
  await act(async () => { await hook.result.current.windows.current.refetch(); });
  await waitFor(() => expect(hook.result.current.windows.current.status).toBe("error"));
  expect(hook.result.current.status).toBe("partial"); expect(hook.result.current.windows.current.current).toBeUndefined();
  expect(hook.result.current.windows.current.retained).toBe(first); expect(hook.result.current.windows.current.readAt).toBe(first.readAt);
  expect(hook.result.current.windows.current.error).toMatchObject({ code: "http", status: 503 });
  expect(hook.result.current.windows.pending.current?.rows).toEqual([]);
  expect(client.getQueryData(seatWorkQueryKey(local, target, "current"))).toBe(first);
  fail = false;
  await act(async () => { await hook.result.current.windows.current.refetch(); });
  await waitFor(() => expect(hook.result.current.status).toBe("ready")); expect(hook.result.current.windows.current.retained).toBeUndefined();
});
it("isolates exact rig/logical/session keys despite global previous-data defaults and discards late old-target body", async () => {
  const next = { ...target, rigId: "rig-other", canonicalSessionName: "raw%2F/other" };
  let hold = false; const signals: AbortSignal[] = []; const late: Array<() => void> = [];
  const fetch = vi.fn((route: string, init: RequestInit) => {
    const url = new URL(route, "http://fixture"); const old = url.searchParams.get("destinationSession") === target.canonicalSessionName;
    const rows = url.searchParams.get("state") === "in-progress,blocked" ? [{ ...qitem, destinationSession: old ? target.canonicalSessionName : next.canonicalSessionName }] : [];
    if (old && hold) {
      signals.push(init.signal!);
      return Promise.resolve({ ok: true, body: { cancel: vi.fn(async () => {}) }, json: () => new Promise(resolve => { late.push(() => resolve(rows)); }) });
    }
    return Promise.resolve(Response.json(rows));
  }); vi.stubGlobal("fetch", fetch);
  const { wrapper, client } = setup(); const hook = renderHook(({ seat }) => useSeatWork(local, seat), { initialProps: { seat: target }, wrapper });
  await waitFor(() => expect(hook.result.current.status).toBe("ready")); const old = hook.result.current.windows.current.current!;
  hold = true;
  let oldReads!: Promise<unknown>;
  act(() => { oldReads = hook.result.current.refetch(); });
  await waitFor(() => expect(late).toHaveLength(3));
  hook.rerender({ seat: next });
  expect(hook.result.current.windows.current.current).toBeUndefined(); expect(hook.result.current.windows.current.retained).toBeUndefined();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  const current = hook.result.current.windows.current.current!; expect(current.target).toEqual(next);
  await act(async () => { for (const release of late) release(); await oldReads; });
  expect(hook.result.current.windows.current.current).toBe(current);
  expect(client.getQueryData(seatWorkQueryKey(local, target, "current"))).toBe(old);
  expect(client.getQueryData(seatWorkQueryKey(local, next, "current"))).toBe(current);
});
it.each(["remote", "unknown", "disabled"])("hides warm evidence and refuses manual refetch for %s admission", async mode => {
  const fetch = vi.fn(async () => Response.json([])); vi.stubGlobal("fetch", fetch);
  const { wrapper } = setup();
  const hook = renderHook(({ scope, seat, enabled }) => useSeatWork(scope, seat, { enabled }), {
    initialProps: { scope: local as OperatorInstanceScope, seat: target as typeof target | null, enabled: true }, wrapper,
  });
  await waitFor(() => expect(hook.result.current.status).toBe("ready")); const before = fetch.mock.calls.length;
  hook.rerender({ scope: mode === "remote" ? { kind: "remote-instance", hostId: "opaque/remote" } : local,
    seat: mode === "unknown" ? null : target, enabled: mode !== "disabled" });
  expect(hook.result.current.status).toBe(mode === "remote" ? "unsupported" : "disabled");
  expect(hook.result.current.windows.current.current).toBeUndefined(); expect(hook.result.current.windows.current.retained).toBeUndefined();
  await act(async () => { await hook.result.current.refetch(); });
  expect(fetch).toHaveBeenCalledTimes(before); expect(hook.result.current.windows.pending.current).toBeUndefined();
});
it("aborts all three reads on unmount with no eventual usable evidence", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn((_route: string, init: RequestInit) => { signals.push(init.signal!); return new Promise<Response>(() => {}); }));
  const { wrapper } = setup(); const hook = renderHook(() => useSeatWork(local, target), { wrapper });
  await waitFor(() => expect(signals).toHaveLength(3)); hook.unmount(); expect(signals.every(s => s.aborted)).toBe(true);
});
it("reuses shared queue scheduler without abort-starving a slow existing read or issuing remote/inactive reads", async () => {
  vi.useFakeTimers(); vi.stubGlobal("EventSource", createMockEventSourceClass());
  const pending: Array<() => void> = []; const signals: AbortSignal[] = [];
  const fetch = vi.fn((_route: string, init: RequestInit) => {
    signals.push(init.signal!); return new Promise<Response>(resolve => pending.push(() => resolve(Response.json([]))));
  }); vi.stubGlobal("fetch", fetch);
  const { wrapper, client } = setup();
  const remote = { kind: "remote-instance", hostId: "remote/exact" } as const;
  const inactiveKey = seatWorkQueryKey(local, { ...target, rigId: "inactive" }, "pending");
  client.setQueryData(inactiveKey, { fictionalInactive: true });
  const hook = renderHook(() => { useGlobalEvents(); return { local: useSeatWork(local, target), remote: useSeatWork(remote, target) }; }, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(fetch).toHaveBeenCalledTimes(3);
  for (let n = 0; n < 3; n++) {
    act(() => instances[0]!.simulateMessage(JSON.stringify({ type: "queue.changed", seq: n })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  }
  expect(fetch).toHaveBeenCalledTimes(3); expect(signals.every(signal => !signal.aborted)).toBe(true);
  await act(async () => { for (const release of pending.splice(0)) release(); await vi.advanceTimersByTimeAsync(1); });
  expect(fetch).toHaveBeenCalledTimes(6); expect(hook.result.current.remote.status).toBe("unsupported");
  expect(client.getQueryData(inactiveKey)).toEqual({ fictionalInactive: true });
  await act(async () => { for (const release of pending.splice(0)) release(); await vi.advanceTimersByTimeAsync(1); });
  expect(hook.result.current.local.status).toBe("ready"); hook.unmount();
});

it("never treats a wrong-identity same-key cached window as current evidence", async () => {
  const { wrapper, client } = setup();
  client.setQueryData(seatWorkQueryKey(local, target, "current"), { target: { ...target, rigId: "foreign" }, window: "current",
    rows: [qitem], limit: 100, readAt: Date.now(), totalCount: null, possiblyBounded: false, addressCoverage: "exact-session", sourceOrder: "created-desc" });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const hook = renderHook(() => useSeatWork(local, target), { wrapper });
  expect(hook.result.current.windows.current.status).toBe("error");
  expect(hook.result.current.windows.current.error).toMatchObject({ code: "invalid_contract" });
  expect(hook.result.current.windows.current.current).toBeUndefined(); expect(hook.result.current.windows.current.retained).toBeUndefined();
  hook.unmount();
});
