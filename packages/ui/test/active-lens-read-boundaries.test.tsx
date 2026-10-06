import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { ActiveLensStore } from "../../daemon/src/domain/active-lens-store.js";
import { specLibraryRoutes } from "../../daemon/src/routes/spec-library.js";
import { useActiveLens } from "../src/hooks/useSpecLibrary.js";

const clients: QueryClient[] = [], dirs: string[] = [];
const key = ["spec-library", "active-lens"];
const lens = { specName: " workflow:%2F 雪 ", specVersion: "01:2", activatedAt: "2026-10-04T00:00:00.000Z" };
function harness(retry: false | number = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 0, gcTime: 0 } } }); clients.push(client);
  return { client, wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
function install(read: (route: string, init?: RequestInit) => unknown) {
  const fetch = vi.fn(async (route: string, init?: RequestInit) => read(route, init)); vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("bounds ignored-abort headers without changing the connected-instance key", async () => {
  vi.useFakeTimers(); const fetch = install(() => new Promise(() => {})); const { client, wrapper } = harness();
  const { result } = renderHook(() => ({ ...useActiveLens() }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(result.current.error).toMatchObject({ code: "timeout" }); expect(client.getQueryState(key)?.status).toBe("error");
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/specs/library/active-lens"); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it("bounds body decoding and disposes the unread body", async () => {
  vi.useFakeTimers(); const cancel = vi.fn(async () => {});
  install(() => ({ ok: true, body: { cancel }, json: () => new Promise(() => {}) })); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...useActiveLens() }), { wrapper }); await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(result.current.error).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
});
it("one total budget includes slow headers and body; late payload cannot replace timeout", async () => {
  vi.useFakeTimers(); let headers!: (v: unknown) => void, body!: (v: unknown) => void;
  const cancel = vi.fn(async () => {}); install(() => new Promise(done => { headers = done; })); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...useActiveLens() }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); headers({ ok: true, body: { cancel }, json: () => new Promise(done => { body = done; }) }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); }); expect(result.current.error).toMatchObject({ code: "timeout" });
  await act(async () => { body({ activeLens: lens }); }); expect(result.current.data).toBeUndefined(); expect(cancel).toHaveBeenCalledOnce();
});
it("unmount aborts owned headers and disposes a late response without decoding", async () => {
  let finish!: (v: unknown) => void; const fetch = install(() => new Promise(done => { finish = done; })); const { client, wrapper } = harness();
  const { unmount } = renderHook(() => ({ ...useActiveLens() }), { wrapper }); await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); unmount();
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  const cancel = vi.fn(async () => {}), json = vi.fn(async () => ({ activeLens: lens }));
  await act(async () => { finish({ ok: true, body: { cancel }, json }); });
  expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled(); expect(client.getQueryData(key)).toBeUndefined();
});
it("explicit observer cancellation aborts pending body", async () => {
  let started = false; const cancel = vi.fn(async () => {});
  const fetch = install(() => ({ ok: true, body: { cancel }, json: () => { started = true; return new Promise(() => {}); } }));
  const { client, wrapper } = harness(); renderHook(() => ({ ...useActiveLens() }), { wrapper }); await waitFor(() => expect(started).toBe(true));
  await act(async () => { await client.cancelQueries({ queryKey: key }); });
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
});
it.each([404, 503])("HTTP%s preserves its original message and cannot become no-lens success", async status => {
  install(() => ({ ok: false, status, json: async () => ({ error: "unavailable" }) })); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...useActiveLens() }), { wrapper }); await waitFor(() => expect(result.current.error?.message).toBe(`HTTP ${status}`));
  expect(result.current.data).toBeUndefined();
});
it.each([{ activeLens: null }, {}, { activeLens: { ...lens, future: false } }])("preserves compatible successful envelope %j", async payload => {
  const fetch = install(() => ({ ok: true, json: async () => payload })); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...useActiveLens() }), { wrapper }); await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual("activeLens" in payload ? payload.activeLens : null);
  expect(fetch).toHaveBeenCalledOnce();
});
it("same-target dated lens stays retained beside a newer failed read", async () => {
  let unavailable = false; install(() => unavailable ? { ok: false, status: 503 } : { ok: true, json: async () => ({ activeLens: lens }) }); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...useActiveLens() }), { wrapper }); await waitFor(() => expect(result.current.data).toEqual(lens));
  unavailable = true; await act(async () => { await result.current.refetch(); }); await waitFor(() => expect(result.current.isRefetchError).toBe(true));
  expect(result.current.data).toEqual(lens); expect(result.current.error?.message).toBe("HTTP 503");
});
it("preserves inherited retry policy", async () => {
  let calls = 0; const fetch = install(() => ++calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ activeLens: null }) }); const { wrapper } = harness(1);
  const { result } = renderHook(() => ({ ...useActiveLens() }), { wrapper }); await waitFor(() => expect(result.current.data).toBeNull()); expect(fetch).toHaveBeenCalledTimes(2);
});
it("actual Hono/private ActiveLensStore returns exact persisted tuple or known absence without forwarding", async () => {
  const dir = mkdtempSync("/private/tmp/openrig-active-lens-get-"); dirs.push(dir);
  const store = new ActiveLensStore({ filePath: join(dir, "lens.json"), now: () => new Date(lens.activatedAt) }); store.set(lens.specName, lens.specVersion);
  const app = new Hono(); app.use("*", async (c, next) => { c.set("activeLensStore" as never, store as never); await next(); }); app.route("/api/specs/library", specLibraryRoutes());
  // jsdom signal is tested above; Node Request rejects that other-realm signal.
  const fetch = install((route, init) => app.request(`http://fixture${route}`, { method: init?.method ?? "GET" })); const { wrapper } = harness();
  const { result } = renderHook(() => ({ ...useActiveLens() }), { wrapper }); await waitFor(() => expect(result.current.data).toEqual(store.get()));
  expect(result.current.data).toEqual(lens); store.clear(); await act(async () => { await result.current.refetch(); }); await waitFor(() => expect(result.current.data).toBeNull());
  expect(fetch.mock.calls.every(([route, init]) => route === "/api/specs/library/active-lens" && (init?.method ?? "GET") === "GET" && init?.headers === undefined)).toBe(true);
});
