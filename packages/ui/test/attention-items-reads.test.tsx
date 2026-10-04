import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAttentionItems, type AttentionQueueItem } from "../src/hooks/useAttentionItems.js";

const item = (qitemId = "q-one", hostId?: string): AttentionQueueItem => ({
  qitemId, tsCreated: "2026-10-04T03:00:00Z", tsUpdated: "2026-10-04T03:00:00Z",
  sourceSession: "sender@rig", destinationSession: "human@host", state: "blocked", priority: "urgent",
  tier: null, tags: null, blockedOn: "human@host", handedOffTo: null, handedOffFrom: null,
  body: "An exact decision", summary: null, evidenceRef: null, ...(hostId === undefined ? {} : { hostId }),
});
let client: QueryClient;
function setup(previous = false) {
  client = new QueryClient({ defaultOptions: { queries: { retry: true, gcTime: Infinity,
    ...(previous ? { placeholderData: keepPreviousData } : {}) } } });
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([false, true])("bounds hung headers aggregate=%s and permits explicit later recovery", async aggregated => {
  vi.useFakeTimers(); const wrapper = setup(); const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useAttentionItems(50, aggregated), { wrapper }); await tick(5_001);
  expect(result.current.error).toMatchObject({ code: "timeout" }); expect(result.current.isFetching).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  fetch.mockImplementation(async () => Response.json(aggregated ? { items: [item("recovered", "local")], hosts: [{ hostId: "local", status: "ok" }] } : [item("recovered")]));
  await act(async () => { await result.current.refetch(); }); await tick(1);
  expect(result.current.error).toBeNull(); expect(result.current.data?.items[0]?.qitemId).toBe("recovered");
});
it.each([false, true])("bounds a hung successful JSON body aggregate=%s", async aggregated => {
  vi.useFakeTimers(); const wrapper = setup(); const cancel = vi.fn(async () => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}), body: { cancel } })));
  const { result } = renderHook(() => useAttentionItems(50, aggregated), { wrapper }); await tick(5_001);
  expect(result.current.error).toMatchObject({ code: "timeout" }); expect(result.current.isFetching).toBe(false); expect(cancel).toHaveBeenCalledTimes(1);
});
it.each(["headers", "body"])("query cancellation aborts a hung %s without committing late data", async stage => {
  vi.useFakeTimers(); const wrapper = setup(); let resolve!: (r: Response) => void;
  const fetch = vi.fn((_url: string, _init?: RequestInit) => stage === "headers" ? new Promise<Response>(r => { resolve = r; }) : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}), body: null } as Response)); vi.stubGlobal("fetch", fetch);
  renderHook(() => useAttentionItems(), { wrapper }); await tick(1);
  await act(async () => { await client.cancelQueries({ queryKey: ["attention-items", 50, false] }); });
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  if (stage === "headers") resolve(Response.json([item("late")])); await tick(5_001);
  expect(client.getQueryData(["attention-items", 50, false])).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("last observer unmount aborts its read and releases the deadline", async () => {
  vi.useFakeTimers(); const wrapper = setup(); const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
  const { unmount } = renderHook(() => useAttentionItems(), { wrapper }); await tick(1); unmount(); await tick(1);
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it.each([true, false])("does not borrow previous data across aggregate mode change from %s", async initial => {
  const wrapper = setup(true); const fetch = vi.fn(async () => Response.json(initial ? { items: [item("old", "local")], hosts: [{ hostId: "local", status: "ok" }] } : [item("old")])); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(({ aggregated }) => useAttentionItems(50, aggregated), { wrapper, initialProps: { aggregated: initial } }); await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  fetch.mockImplementation(() => new Promise<Response>(() => {})); hook.rerender({ aggregated: !initial });
  expect(hook.result.current.data).toBeUndefined(); expect(hook.result.current.isPlaceholderData).toBe(false);
});
it("does not borrow a previous limit's window while the new window is pending", async () => {
  const wrapper = setup(true); const fetch = vi.fn(async () => Response.json([item()])); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(({ limit }) => useAttentionItems(limit), { wrapper, initialProps: { limit: 1 } }); await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  fetch.mockImplementation(() => new Promise<Response>(() => {})); hook.rerender({ limit: 50 }); expect(hook.result.current.data).toBeUndefined();
});
it.each([
  {}, { items: [], hosts: null }, { items: "unavailable", hosts: [] }, null,
  { items: [{}], hosts: [] }, { items: [item()], hosts: [{ hostId: "local", status: "ok" }] },
  { items: [item("one", "local")], hosts: [{ hostId: "local", status: "invented" }] },
  { items: [], hosts: [{ status: "unreachable" }] },
  { items: [], hosts: [{ hostId: "x", status: "unreachable", error: null }] },
])("rejects malformed aggregate contract %# instead of claiming empty success", async payload => {
  const wrapper = setup(); vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
  const hook = renderHook(() => useAttentionItems(50, true), { wrapper }); await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.error).toMatchObject({ code: "invalid_contract" }); expect(hook.result.current.data).toBeUndefined();
});
it.each([{}, [null], [{ ...item(), tags: [1] }], [{ ...item(), summary: 2 }]])("rejects malformed legacy array %#", async payload => {
  const wrapper = setup(); vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
  const hook = renderHook(() => useAttentionItems(), { wrapper }); await waitFor(() => expect(hook.result.current.isError).toBe(true)); expect(hook.result.current.error).toMatchObject({ code: "invalid_contract" });
});
it("preserves nullable/additive row and host facts and applies aggregate limit only to rows", async () => {
  const wrapper = setup(); const one = { ...item("one", "local"), pickup: { status: "unclaimed" }, targetRepo: null, futureFact: { exact: true } };
  const hosts = [{ hostId: "local", status: "ok" }, { hostId: "remote", status: "auth-failed", failedStep: "permission-gate", error: "HTTP 403", futureFact: 2 }];
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ items: [one, item("two", "remote")], hosts, futureEnvelope: "retained" })); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(() => useAttentionItems(1, true), { wrapper }); await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.result.current.data).toEqual({ items: [one], hosts, futureEnvelope: "retained" });
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/queue/attention-aggregate"); expect(fetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
});
it.each([false, true])("retains HTTP failure and disables automatic retries aggregate=%s", async aggregated => {
  vi.useFakeTimers(); const wrapper = setup(); const fetch = vi.fn(async () => new Response("upstream unavailable", { status: 503 })); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(() => useAttentionItems(50, aggregated), { wrapper }); await tick(20_000);
  expect(hook.result.current.error?.message).toBe("HTTP 503"); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([false, true])("reports invalid JSON separately from an empty list aggregate=%s", async aggregated => {
  const wrapper = setup(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{")));
  const hook = renderHook(() => useAttentionItems(50, aggregated), { wrapper }); await waitFor(() => expect(hook.result.current.isError).toBe(true)); expect(hook.result.current.error).toMatchObject({ code: "invalid_json" });
});
it("retains the exact legacy limit key and always-on-focus semantics", async () => {
  const wrapper = setup(); const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json([item()])); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(() => useAttentionItems(7), { wrapper }); await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/queue/list?attention=1&limit=7");
  const query = client.getQueryCache().find({ queryKey: ["attention-items", 7, false], exact: true }); expect(query?.options.refetchOnWindowFocus).toBe("always"); expect(query?.options.staleTime).toBe(15_000);
  await act(async () => { client.getQueryCache().onFocus(); }); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

it("reports a network failure distinctly without a background retry", async () => {
  const wrapper = setup(); const fetch = vi.fn(async () => { throw new TypeError("offline"); }); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(() => useAttentionItems(), { wrapper }); await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.error).toMatchObject({ code: "network", message: "offline" }); expect(fetch).toHaveBeenCalledTimes(1);
});
it("retains exact-mode cached facts alongside a bounded refetch error, then recovers", async () => {
  vi.useFakeTimers(); const wrapper = setup(); const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ items: [item("cached", "local")], hosts: [{ hostId: "local", status: "ok" }] })); vi.stubGlobal("fetch", fetch);
  // Observe error/fetch state as a consumer does, even when cached data remains identical.
  const hook = renderHook(() => ({ ...useAttentionItems(50, true) }), { wrapper }); await tick(1);
  expect(hook.result.current.data?.items[0]?.qitemId).toBe("cached");
  fetch.mockImplementation(() => new Promise<Response>(() => {})); let settled!: Promise<unknown>;
  act(() => { settled = hook.result.current.refetch(); }); await tick(5_001); await settled; await tick(1);
  expect(hook.result.current.error).toMatchObject({ code: "timeout" }); expect(hook.result.current.isFetching).toBe(false);
  expect(hook.result.current.data?.items[0]?.qitemId).toBe("cached");
  fetch.mockImplementation(async () => Response.json({ items: [], hosts: [{ hostId: "local", status: "ok" }] }));
  await act(async () => { await hook.result.current.refetch(); }); await tick(1);
  expect(hook.result.current.error).toBeNull(); expect(hook.result.current.data?.items).toEqual([]);
});
