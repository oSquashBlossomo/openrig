import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useHosts, useHostSelection, useSelectedHostId } from "../src/hooks/useHosts.js";

const valid = {
  ownName: "private connected daemon", selected: "remote/exact", hosts: [
    { id: "remote/exact", transport: "http", url: "http://private-origin.invalid", selected: true, status: "unknown", bearer_file: "/private/token-pointer" },
    { id: "ssh/exact", transport: "ssh", target: "private.invalid", selected: false, status: "unreachable" },
  ],
};
const clients: QueryClient[] = [];
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return { client, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("host selection read boundaries", () => {
  it.each([
    { ownName: "private", hosts: [] },
    { ...valid, selected: "" },
    { ...valid, hosts: {} },
    { ...valid, hosts: [{ ...valid.hosts[0], id: 4 }] },
    { ...valid, hosts: [{ ...valid.hosts[0], transport: "invented" }] },
    { ...valid, hosts: [{ ...valid.hosts[0], status: "healthy" }] },
    { ...valid, hosts: [{ ...valid.hosts[0], url: undefined }] },
    { ...valid, hosts: [{ ...valid.hosts[1], target: undefined }] },
  ])("rejects malformed selection data instead of authorizing local Files: %j", async payload => {
    const fetch = vi.fn(async () => json(payload)); vi.stubGlobal("fetch", fetch);
    const h = harness();
    const { result } = renderHook(() => ({ query: useHosts(), selection: useHostSelection() }), h);
    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.query.error).toMatchObject({ code: "invalid_contract" });
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.selection.known).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains the served registry alias, pointers and additive facts without selecting an invented local host", async () => {
    const payload = { ...valid, selected: "removed/registry/alias", diagnostic: { registryPresent: true } };
    const fetch = vi.fn(async () => json(payload)); vi.stubGlobal("fetch", fetch);
    const h = harness(); const { result } = renderHook(() => ({ query: useHosts(), selected: useSelectedHostId(), selection: useHostSelection() }), h);
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.query.data).toEqual(payload);
    expect(result.current.selected).toBe(payload.selected);
    expect(result.current.selection).toEqual({ known: true, isLocal: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("covers slow headers and a stalled body with one five-second deadline", async () => {
    vi.useFakeTimers();
    let resolve!: (response: unknown) => void;
    const cancel = vi.fn(async () => {});
    const fetch = vi.fn(() => new Promise(r => { resolve = r; })); vi.stubGlobal("fetch", fetch);
    const h = harness(); const { result } = renderHook(() => useHosts(), h);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    await act(async () => { resolve({ ok: true, status: 200, json: () => new Promise(() => {}), body: { cancel } }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(result.current.isError).toBe(true);
    expect(result.current.error).toMatchObject({ code: "timeout" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an abandoned selection read and disposes late response bytes", async () => {
    let resolve!: (response: unknown) => void;
    const cancel = vi.fn(async () => {}), read = vi.fn(async () => valid);
    const fetch = vi.fn(() => new Promise(r => { resolve = r; })); vi.stubGlobal("fetch", fetch);
    const h = harness(); const { unmount } = renderHook(() => useHosts(), h);
    const signal = fetch.mock.calls[0]?.[1]?.signal;
    unmount();
    expect(signal).toBeDefined(); expect(signal.aborted).toBe(true);
    await act(async () => { resolve({ ok: true, status: 200, json: read, body: { cancel } }); });
    expect(read).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    expect(h.client.getQueryData(["hosts"])).toBeUndefined();
  });

  it("keeps a failed refresh distinct from freshly verified cached selection", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(valid)).mockResolvedValueOnce(json({ error: "invalid_registry" }, 500));
    vi.stubGlobal("fetch", fetch);
    const h = harness(); const { result } = renderHook(() => useHosts(), h);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const timestamp = result.current.dataUpdatedAt;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.isRefetchError).toBe(true));
    expect(result.current.error).toMatchObject({ code: "http", status: 500, serverCode: "invalid_registry" });
    expect(result.current.data).toEqual(valid); expect(result.current.dataUpdatedAt).toBe(timestamp);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps passive selected-host observers passive until an active host reader mounts", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const h = harness(); const { result } = renderHook(() => useSelectedHostId(), h);
    expect(result.current).toBe("local"); expect(fetch).not.toHaveBeenCalled();
    act(() => h.client.setQueryData(["hosts"], valid));
    // Cache notifications are async; the observer's lack of a fetch is the invariant.
    expect(fetch).not.toHaveBeenCalled();
  });
});
