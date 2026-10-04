import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePlugin, usePlugins, usePluginUsedBy } from "../src/hooks/usePlugins.js";

const clients: QueryClient[] = [];
const families = ["list", "detail", "used-by"] as const;
type Family = typeof families[number];
function hook(family: Family, id: string | null = "plugin") {
  return family === "list" ? usePlugins() : family === "detail" ? usePlugin(id) : usePluginUsedBy(id);
}
function harness(retry: false | number = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 0, gcTime: 0 } } });
  clients.push(client);
  return { client, wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
function install(read: (url: string, init?: RequestInit) => unknown) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => read(url, init));
  vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(families)("%s bounds ignored-abort response headers", async family => {
  vi.useFakeTimers(); const fetch = install(() => new Promise(() => {})); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...hook(family) }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(result.current.error).toMatchObject({ code: "timeout" });
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true); expect(fetch).toHaveBeenCalledOnce();
});
it.each(families)("%s bounds ignored-abort response body and disposes it", async family => {
  vi.useFakeTimers(); const cancel = vi.fn(async () => {});
  const fetch = install(() => ({ ok: true, body: { cancel }, json: () => new Promise(() => {}) })); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...hook(family) }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(result.current.error).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it.each(families)("%s observer cancellation aborts transport and disposes late headers", async family => {
  let finish!: (response: unknown) => void;
  const fetch = install(() => new Promise(done => { finish = done; })); const { client, wrapper } = harness();
  const { unmount } = renderHook(() => ({ ...hook(family) }), { wrapper });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); unmount();
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  const cancel = vi.fn(async () => {}), json = vi.fn(async () => []);
  await act(async () => { finish({ ok: true, body: { cancel }, json }); await Promise.resolve(); });
  expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
  expect(client.getQueryData(["plugins", family, ...(family === "list" ? ["all", "all"] : ["plugin"])] )).toBeUndefined();
});
it.each(["detail", "used-by"] as const)("%s explicit caller cancellation cancels pending body", async family => {
  let started = false; const cancel = vi.fn(async () => {});
  const fetch = install(() => ({ ok: true, body: { cancel }, json: () => { started = true; return new Promise(() => {}); } }));
  const { client, wrapper } = harness(); renderHook(() => ({ ...hook(family) }), { wrapper });
  await waitFor(() => expect(started).toBe(true)); await act(async () => { await client.cancelQueries({ queryKey: ["plugins", family, "plugin"] }); });
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
});
for (const family of ["detail", "used-by"] as const) {
  it.each([null, ""])(`${family} absent %s target refuses mounted/manual reads`, async id => {
    const fetch = install(() => ({ ok: true, json: async () => [] })); const { wrapper } = harness();
    const { result } = renderHook(() => ({ ...hook(family, id) }), { wrapper });
    expect(fetch).not.toHaveBeenCalled();
    let answer: { error: unknown } | undefined;
    await act(async () => { answer = await result.current.refetch(); });
    expect(answer?.error).toMatchObject({ code: "invalid_request" }); expect(fetch).not.toHaveBeenCalled();
  });
}
it("one request deadline includes slow headers plus body; late bytes cannot replace timeout", async () => {
  vi.useFakeTimers(); let headers!: (v: unknown) => void, body!: (v: unknown) => void;
  const cancel = vi.fn(async () => {}); install(() => new Promise(done => { headers = done; })); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...usePlugin("plugin") }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); headers({ ok: true, body: { cancel }, json: () => new Promise(done => { body = done; }) }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect(result.current.error).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
  await act(async () => { body({ entry: { id: "plugin" } }); }); expect(result.current.data).toBeUndefined();
});
it.each(["detail", "used-by"] as const)("%s preserves raw opaque target/key and compatible successful facts", async family => {
  const id = " %2F:雪 01 ", payload = family === "detail" ? { entry: { id }, claudeManifest: null, future: false } : [];
  const fetch = install(() => ({ ok: true, json: async () => payload })); const { client, wrapper } = harness();
  const { result } = renderHook(() => ({ ...hook(family, id) }), { wrapper });
  await waitFor(() => expect(result.current.data).toEqual(payload));
  expect(fetch.mock.calls[0]?.[0]).toBe(`/api/plugins/${encodeURIComponent(id)}${family === "used-by" ? "/used-by" : ""}`);
  expect(client.getQueryData(["plugins", family, id])).toEqual(payload);
});
it.each(families)("%s preserves exact HTTP errors rather than successful emptiness", async family => {
  install(() => ({ ok: false, status: 503, json: async () => ({ error: "plugin_discovery_unavailable" }) })); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...hook(family) }), { wrapper });
  await waitFor(() => expect(result.current.error?.message).toBe("HTTP 503")); expect(result.current.data).toBeUndefined();
});
it("same-target dated data survives a newer HTTP failure", async () => {
  const payload = { entry: { id: "plugin" }, future: null }; let unavailable = false;
  install(() => unavailable ? { ok: false, status: 404 } : { ok: true, json: async () => payload }); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...usePlugin("plugin") }), { wrapper }); await waitFor(() => expect(result.current.data).toEqual(payload));
  unavailable = true; await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.error?.message).toBe("HTTP 404"));
  expect(result.current.data).toEqual(payload); expect(result.current.isRefetchError).toBe(true);
});
it("preserves configured query retry and list filters", async () => {
  let reads = 0; const fetch = install(() => ++reads === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => [] });
  const { client, wrapper } = harness(1); const { result } = renderHook(() => ({ ...usePlugins({ runtime: "codex", source: "codex-cache" }) }), { wrapper });
  await waitFor(() => expect(result.current.data).toEqual([])); expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/plugins?runtime=codex&source=codex-cache");
  expect(client.getQueryData(["plugins", "list", "codex", "codex-cache"])).toEqual([]);
});
