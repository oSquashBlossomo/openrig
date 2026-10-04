import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSettings } from "../src/hooks/useSettings.js";
const clients: QueryClient[] = [];
const resolved = (value: string | number | boolean) => ({ value, source: "default", defaultValue: value });
const valid = () => ({ settings: { "ui.preview.default_lines": resolved(50) } });
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  return { client, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("bounds ignored-abort headers to five seconds without automatic retry", async () => {
  vi.useFakeTimers(); const fetch = vi.fn(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch);
  const { wrapper } = harness(); const { result } = renderHook(useSettings, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); }); expect(result.current.error).toMatchObject({ code: "timeout" });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(fetch).toHaveBeenCalledOnce();
});
it.each([200, 503])("bounds HTTP%s body with the same deadline and disposes it", async status => {
  vi.useFakeTimers(); const cancel = vi.fn(async () => {});
  vi.stubGlobal("fetch", async () => ({ ok: status === 200, status, body: { cancel }, json: () => new Promise(() => {}) }));
  const { wrapper } = harness(); const { result } = renderHook(useSettings, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); }); expect(result.current.error).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
});
it("links observer cancellation and disposes late headers without decoding", async () => {
  let complete!: (response: unknown) => void; let signal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, init?: RequestInit) => { signal = init?.signal as AbortSignal; return new Promise(done => { complete = done; }); });
  vi.stubGlobal("fetch", fetch); const { wrapper } = harness(); const { unmount } = renderHook(useSettings, { wrapper });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); unmount(); expect(signal?.aborted).toBe(true);
  const cancel = vi.fn(async () => {}), json = vi.fn(async () => valid()); complete({ ok: true, body: { cancel }, json });
  await waitFor(() => expect(cancel).toHaveBeenCalledOnce()); expect(json).not.toHaveBeenCalled();
});
it("cancels an owned unread body on unmount", async () => {
  let started = false; let signal: AbortSignal | undefined; const cancel = vi.fn(async () => {});
  vi.stubGlobal("fetch", async (_url, init) => { signal = init?.signal; return { ok: true, body: { cancel }, json: () => { started = true; return new Promise(() => {}); } }; });
  const { wrapper } = harness(); const { unmount } = renderHook(useSettings, { wrapper }); await waitFor(() => expect(started).toBe(true));
  unmount(); expect(signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
});
it("uses one mixed header/body budget; late body cannot replace timeout", async () => {
  vi.useFakeTimers(); let headers!: (response: unknown) => void, body!: (data: unknown) => void; const cancel = vi.fn(async () => {});
  vi.stubGlobal("fetch", () => new Promise(done => { headers = done; })); const { wrapper } = harness(); const { result } = renderHook(useSettings, { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); headers({ ok: true, body: { cancel }, json: () => new Promise(done => { body = done; }) }); await vi.advanceTimersByTimeAsync(1001); });
  expect(result.current.error).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
  await act(async () => { body(valid()); await vi.advanceTimersByTimeAsync(10); }); expect(result.current.data).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
});
it.each([null, {}, { settings: null }, { settings: [] }, { settings: { x: null } },
  { settings: { x: { ...resolved(1), value: {} } } }, { settings: { x: { ...resolved(1), defaultValue: [] } } },
  { settings: { x: { ...resolved(1), source: "invented" } } }, { settings: { x: { value: 1 } } },
  { settings: { x: resolved(NaN) } }, { settings: {}, feedHostSubscriptions: null },
  { settings: {}, feedHostSubscriptions: [{ hostId: "remote", enabled: "true" }] },
])("rejects malformed successful settings case %#", async payload => {
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => payload })); const { wrapper } = harness(); const { result } = renderHook(useSettings, { wrapper });
  await waitFor(() => expect(result.current.fetchStatus).toBe("idle")); expect(result.current.error).toMatchObject({ code: "invalid_contract" }); expect(result.current.data).toBeUndefined();
});
it("retains partial/additive maps, old optional shape, and zero/false/empty facts", async () => {
  const payload = { settings: { zero: resolved(0), false: resolved(false), empty: resolved(""), future: { ...resolved("5"), extra: "retained" } }, extra: { untouched: true } };
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => payload })); vi.stubGlobal("fetch", fetch);
  const { wrapper } = harness(); const { result } = renderHook(useSettings, { wrapper }); await waitFor(() => expect(result.current.data).toEqual(payload));
  expect(fetch.mock.calls[0][0]).toBe("/api/config"); expect(fetch.mock.calls[0][1]).not.toHaveProperty("headers");
});
it("retains optional feed host facts without selected-host routing", async () => {
  const payload = { settings: {}, feedHostSubscriptions: [{ hostId: "remote-1", enabled: false, extra: 0 }] };
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => payload })); const { client, wrapper } = harness();
  client.setQueryData(["hosts"], { selectedHostId: "remote-1" }); const { result } = renderHook(useSettings, { wrapper }); await waitFor(() => expect(result.current.data).toEqual(payload));
});
it.each([[404, null, "HTTP 404"], [503, {}, "HTTP 503"], [503, { error: "settings_unavailable" }, "settings_unavailable"], [400, { error: "exact daemon error" }, "exact daemon error"]])("preserves HTTP%s error decoding and null fallback", async (status, payload, message) => {
  vi.stubGlobal("fetch", async () => ({ ok: false, status, json: async () => payload })); const { wrapper } = harness(); const { result } = renderHook(useSettings, { wrapper }); await waitFor(() => expect(result.current.error?.message).toBe(message));
});
it("preserves invalid JSON and network classifications", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError("private body content"); } }).mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetch); const { wrapper } = harness(); const { result } = renderHook(useSettings, { wrapper });
  await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_json" })); expect(result.current.error?.message).not.toContain("private body content");
  await act(async () => { await result.current.refetch(); }); await waitFor(() => expect(result.current.error).toMatchObject({ code: "network" }));
});
it("retains same-instance warm cache with explicit refetch error", async () => {
  const payload = valid(); vi.stubGlobal("fetch", async () => ({ ok: false, status: 503, json: async () => ({ error: "settings_unavailable" }) }));
  const { client, wrapper } = harness(); client.setQueryData(["settings", "all"], payload); const { result } = renderHook(useSettings, { wrapper });
  await waitFor(() => expect(result.current.error?.message).toBe("settings_unavailable")); expect(result.current.data).toEqual(payload); expect(result.current.isRefetchError).toBe(true);
});
