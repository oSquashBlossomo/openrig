import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDaemonHealth } from "../src/hooks/useDaemonHealth.js";

const clients: QueryClient[] = [];
function wrapper() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client); return { client, wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) }; }
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.unstubAllGlobals(); vi.useRealTimers(); });
const healthy = { status: "ok", eventLoop: { lagMeanMs: 1, lagP99Ms: 2, utilization: 0.2, lastTickAgeMs: 1, healthy: true } };

describe("bounded shared daemon health", () => {
  it.each(["headers", "body"])("marks previous healthy cache unhealthy after hung %s and recovers on later successful read", async stage => {
    vi.useFakeTimers(); const fetch = vi.fn(async (..._args: Parameters<typeof globalThis.fetch>) => healthyResponse());
    vi.stubGlobal("fetch", fetch); const { client, wrapper: wrap } = wrapper(); client.setQueryData(["daemon", "health"], healthy);
    fetch.mockImplementation(() => stage === "headers" ? new Promise(() => {}) : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}), body: null } as unknown as Response));
    const { result } = renderHook(() => useDaemonHealth(), { wrapper: wrap }); expect(result.current.signal.controlPlaneUnhealthy).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
    expect(result.current.query.error).toMatchObject({ code: "timeout" }); expect(result.current.signal.controlPlaneUnhealthy).toBe(true);
    expect(result.current.query.data).toEqual(healthy); expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    fetch.mockImplementation(async () => healthyResponse());
    await act(async () => { await result.current.query.refetch(); await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.signal.controlPlaneUnhealthy).toBe(false); expect(result.current.query.data).toEqual(healthy); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("passes query cancellation to fetch on unmount and removes the transport deadline", async () => {
    vi.useFakeTimers(); const fetch = vi.fn((..._args: Parameters<typeof globalThis.fetch>) => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
    const { wrapper: wrap } = wrapper(); const { unmount } = renderHook(() => useDaemonHealth(), { wrapper: wrap }); const signal = fetch.mock.calls[0]?.[1]?.signal;
    unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects malformed health payload instead of treating it as healthy", async () => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "ok", eventLoop: { healthy: "yes" } })));
    const { wrapper: wrap } = wrapper(); const { result } = renderHook(() => useDaemonHealth(), { wrapper: wrap }); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(result.current.signal.controlPlaneUnhealthy).toBe(true); expect(result.current.query.error).toMatchObject({ code: "invalid_contract" });
  });
});
function healthyResponse() { return Response.json(healthy); }
