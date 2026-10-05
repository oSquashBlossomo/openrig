// The baseline adapter tests old helpers before the atomic API exists, so
// RED demonstrates actual forbidden writes rather than a missing import.
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveLensStore } from "../../daemon/src/domain/active-lens-store.js";
import { specLibraryRoutes } from "../../daemon/src/routes/spec-library.js";
import * as hookModule from "../src/hooks/useSpecLibrary.js";
import type { ActiveLensPayload } from "../src/hooks/useSpecLibrary.js";
import type { HostsResponse } from "../src/hooks/useHosts.js";

interface Input { originHostId: string | null; specName: string; specVersion: string }
interface Actions {
  setActiveLens(input: Input): Promise<ActiveLensPayload | null>;
  clearActiveLens(input: Pick<Input, "originHostId">): Promise<void>;
}
const api = hookModule as unknown as {
  useActiveLensActions?: () => Actions;
  setActiveLens?: (name: string, version: string) => Promise<ActiveLensPayload | null>;
  clearActiveLens?: () => Promise<void>;
};
function useActions(): Actions {
  return api.useActiveLensActions ? api.useActiveLensActions() : {
    setActiveLens: ({ specName, specVersion }) => api.setActiveLens!(specName, specVersion),
    clearActiveLens: () => api.clearActiveLens!(),
  };
}
const clients: QueryClient[] = [], dirs: string[] = [];
afterEach(() => {
  cleanup(); clients.splice(0).forEach(c => c.clear());
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllGlobals();
});
const hosts = (selected = "local"): HostsResponse => ({ ownName: "Fictional", selected, hosts: [] });
function mount(selected = "local", seed = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(qc);
  if (seed) qc.setQueryData(["hosts"], hosts(selected));
  const dir = mkdtempSync(join(tmpdir(), "openrig-active-lens-actions-")); dirs.push(dir);
  const store = new ActiveLensStore({ filePath: join(dir, "lens.json"), now: () => new Date("2026-10-04T19:00:00Z") });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("activeLensStore" as never, store as never); await next(); });
  app.route("/api/specs/library", specLibraryRoutes());
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://fictional.invalid");
    return app.request(url.pathname + url.search, { method: init?.method, headers: init?.headers, body: init?.body });
  }); vi.stubGlobal("fetch", fetch);
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const hook = renderHook(useActions, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
  return { ...hook, qc, store, fetch, invalidate };
}
const input = (originHostId: string | null): Input => ({ originHostId, specName: " exact:%2F 雪 ", specVersion: "01:2" });

it.each(["remote", null, "", " local", "LOCAL"])("origin %s rejects both verbs with no local effect", async origin => {
  const { result, store, fetch, invalidate } = mount(); store.set("existing", "0");
  await expect(result.current.setActiveLens(input(origin))).rejects.toThrow(/origin|source|connected|local/i);
  await expect(result.current.clearActiveLens({ originHostId: origin })).rejects.toThrow(/origin|source|connected|local/i);
  expect(fetch).not.toHaveBeenCalled(); expect(store.get()).toMatchObject({ specName: "existing", specVersion: "0" });
  expect(invalidate).not.toHaveBeenCalled();
});
it.each(["missing", "remote", "malformed", "error-warm-local", "pending-warm-local"])("current %s authority rejects both verbs", async context => {
  const { result, qc, store, fetch, invalidate } = mount(context === "remote" ? "far" : "local", context !== "missing");
  if (context === "malformed") qc.setQueryData(["hosts"], { selected: "local" });
  if (context === "error-warm-local") qc.getQueryCache().find({ queryKey: ["hosts"], exact: true })!.setState({ status: "error", error: new Error("hosts read failed") });
  if (context === "pending-warm-local") qc.getQueryCache().find({ queryKey: ["hosts"], exact: true })!.setState({ status: "pending", error: null });
  store.set("existing", "0");
  await expect(result.current.setActiveLens(input("local"))).rejects.toThrow(/selection|host|local|connected/i);
  await expect(result.current.clearActiveLens({ originHostId: "local" })).rejects.toThrow(/selection|host|local|connected/i);
  expect(fetch).not.toHaveBeenCalled(); expect(store.get()).toMatchObject({ specName: "existing", specVersion: "0" });
  expect(invalidate).not.toHaveBeenCalled();
});
it.each(["local-to-remote", "remote-to-local"])("retained %s callbacks reject both verbs", async direction => {
  const before = direction === "local-to-remote" ? "local" : "far", after = before === "local" ? "far" : "local";
  const { result, qc, store, fetch } = mount(before); const retained = result.current;
  act(() => qc.setQueryData(["hosts"], hosts(after))); store.set("existing", "0");
  await expect(retained.setActiveLens(input(before))).rejects.toThrow();
  await expect(retained.clearActiveLens({ originHostId: before })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled(); expect(store.get()).toMatchObject({ specName: "existing" });
});
it("uses its owning QueryClient instead of the most recently mounted client", async () => {
  const a = mount("far"), retained = a.result.current; const b = mount("local");
  await expect(retained.setActiveLens(input("local"))).rejects.toThrow();
  await expect(retained.clearActiveLens({ originHostId: "local" })).rejects.toThrow();
  expect(a.fetch).not.toHaveBeenCalled(); expect(b.fetch).not.toHaveBeenCalled();
});
it("known local preserves exact payload, actual store receipt and ordered successful invalidations", async () => {
  const { result, store, fetch, invalidate } = mount();
  const receipt = await result.current.setActiveLens(input("local"));
  expect(receipt).toEqual({ specName: input("local").specName, specVersion: "01:2", activatedAt: "2026-10-04T19:00:00.000Z" });
  expect(store.get()).toEqual(receipt);
  expect(fetch.mock.calls[0]).toEqual(["/api/specs/library/active-lens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ specName: input("local").specName, specVersion: "01:2" }) }]);
  expect(invalidate.mock.calls.map(([options]) => options)).toEqual([{ queryKey: ["spec-library", "active-lens"] }, { queryKey: ["slices"] }]);
  invalidate.mockClear();
  await expect(result.current.clearActiveLens({ originHostId: "local" })).resolves.toBeUndefined(); expect(store.get()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(invalidate.mock.calls.map(([options]) => options)).toEqual([{ queryKey: ["spec-library", "active-lens"] }, { queryKey: ["slices"] }]);
});
it.each(["POST", "DELETE"])("%s HTTP errors remain exact, with one request and no invalidation", async method => {
  const { result, fetch, invalidate } = mount(); fetch.mockImplementation(async () => Response.json({ error: "unavailable" }, { status: 503 }));
  await expect(method === "POST" ? result.current.setActiveLens(input("local")) : result.current.clearActiveLens({ originHostId: "local" })).rejects.toThrow("HTTP 503");
  expect(fetch).toHaveBeenCalledTimes(1); expect(invalidate).not.toHaveBeenCalled();
});
it("preserves nullable successful POST receipt", async () => {
  const { result, fetch } = mount(); fetch.mockImplementation(async () => Response.json({ activeLens: null }));
  await expect(result.current.setActiveLens(input("local"))).resolves.toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("removes free unsafe exports when the bounded API lands", () => {
  expect(api.useActiveLensActions).toBeTypeOf("function"); expect(api.setActiveLens).toBeUndefined(); expect(api.clearActiveLens).toBeUndefined();
});
