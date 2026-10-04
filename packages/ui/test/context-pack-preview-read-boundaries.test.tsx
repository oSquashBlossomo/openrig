import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextPackLibraryService } from "../../daemon/src/domain/context-packs/context-pack-library-service.js";
import { contextPacksRoutes } from "../../daemon/src/routes/context-packs.js";
import { useContextPackPreview } from "../src/hooks/useContextPackLibrary.js";

const clients: QueryClient[] = [], dirs: string[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(q => q.clear()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.useRealTimers(); vi.unstubAllGlobals(); });
const preview = (ref = "packs/a") => ({ id: `context-pack:${ref}`, name: "", version: "01", bundleText: "", bundleBytes: 0, estimatedTokens: 0,
  files: [{ path: "empty.md", role: "reference", bytes: 0, estimatedTokens: 0 }], missingFiles: [{ path: "missing.md", role: "proof" }], future: { retained: true } });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function mount(ref: string | null, transport: typeof globalThis.fetch, oldPlaceholder = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, ...(oldPlaceholder ? { placeholderData: keepPreviousData } : {}) } } }); clients.push(qc);
  qc.setQueryData(["hosts"], { ownName: "private", selected: "far", hosts: [] });
  const fetch = vi.fn(transport); vi.stubGlobal("fetch", fetch);
  const hook = renderHook(({ ref }: { ref: string | null }) => ({ ...useContextPackPreview(ref) }), { initialProps: { ref }, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
  return { ...hook, qc, fetch };
}
it.each(["headers", "body"])("bounds hung preview %s with one total deadline", async stage => {
  vi.useFakeTimers(); const { result, fetch } = mount("packs/a", async () => stage === "headers" ? new Promise(() => {}) : { ok: true, json: () => new Promise(() => {}) } as unknown as Response);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
  expect(result.current.error).toMatchObject({ code: "timeout" }); expect(result.current.data).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
});
it.each([null, ""])("manual refetch without exact ref %s does not GET a fabricated target", async ref => {
  const { result, fetch } = mount(ref, async () => Response.json(preview())); expect(fetch).not.toHaveBeenCalled();
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error).toMatchObject({ code: "invalid_request" }); expect(result.current.data).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
});
it.each([{ ...preview(), id: "context-pack:packs/b" }, { ...preview(), bundleText: null }, { ...preview(), missingFiles: null }, { ...preview(), files: [{}] }])("rejects wrong target or malformed preview %j", async body => {
  const { result } = mount("packs/a", async () => Response.json(body));
  await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" }); expect(result.current.data).toBeUndefined();
});
it("global previous-data defaults cannot expose A's bundle while B is pending", async () => {
  const next = deferred<Response>(); const { result, rerender, qc } = mount("packs/a", async input => String(input).endsWith("packs%2Fa") ? Response.json(preview()) : next.promise, true);
  await waitFor(() => expect(result.current.isSuccess).toBe(true)); rerender({ ref: "packs/b" });
  expect(result.current.data).toBeUndefined(); expect(qc.getQueryData(["context-packs", "preview", "packs/a"])).toEqual(preview());
  await act(async () => { next.resolve(Response.json(preview("packs/b"))); });
  await waitFor(() => expect(result.current.data?.id).toBe("context-pack:packs/b"));
});
it("unmount cancellation disposes late headers without decoding/publication", async () => {
  const late = deferred<Response>(), cancel = vi.fn().mockResolvedValue(undefined), json = vi.fn().mockResolvedValue(preview());
  const { unmount, qc, fetch } = mount("packs/a", async () => late.promise); unmount();
  await act(async () => { late.resolve({ ok: true, body: { cancel }, json } as unknown as Response); await Promise.resolve(); });
  expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1); expect(json).not.toHaveBeenCalled();
  expect(qc.getQueryData(["context-packs", "preview", "packs/a"])).toBeUndefined();
});
it("successful preview keeps empty text, zero/nullable-independent facts, additive fields and exact local request", async () => {
  const { result, fetch } = mount("packs/a", async () => Response.json(preview()));
  await waitFor(() => expect(result.current.isSuccess).toBe(true)); expect(result.current.data).toEqual(preview());
  expect(fetch.mock.calls[0]![0]).toBe("/api/context-packs/library/by-ref/preview?ref=packs%2Fa");
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", signal: expect.any(AbortSignal) }); expect(fetch.mock.calls[0]![1]).not.toHaveProperty("headers");
});
it("failed same-ref refresh retains dated preview with its HTTP error", async () => {
  let fail = false; const { result } = mount("packs/a", async () => fail ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json(preview()));
  await waitFor(() => expect(result.current.isSuccess).toBe(true)); fail = true;
  await act(async () => { await result.current.refetch(); });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error?.message).toBe("HTTP 503"); expect(result.current.data).toEqual(preview());
});
it("actual private service/Hono preview preserves ref ID, bytes/Unicode/missing files; missing/unsafe refs stay errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "openrig-context-preview-")); dirs.push(root); const pack = join(root, "packs", "a"); mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, "manifest.yaml"), 'name: "raw%2F:雪"\nversion: "01"\ntaxonomy: world\nfiles:\n  - path: text.md\n    role: reference\n  - path: missing.md\n    role: proof\n');
  writeFileSync(join(pack, "text.md"), "# 雪\nemoji 🐈\n"); const library = new ContextPackLibraryService({ roots: [{ path: root, sourceType: "workspace" }] }); library.scan();
  const app = new Hono(); app.use("*", async (c, next) => { c.set("contextPackLibrary" as never, library as never); await next(); }); app.route("/api/context-packs", contextPacksRoutes());
  const route = "/api/context-packs/library/by-ref/preview?ref=packs%2Fa", real = await app.request(route); expect(real.status).toBe(200); const served = await real.json();
  const { result, rerender, fetch } = mount("packs/a", async (input, init) => app.request(String(input), { method: init?.method, headers: init?.headers }));
  await waitFor(() => expect(result.current.isSuccess).toBe(true)); expect(result.current.data).toEqual(served);
  expect(result.current.data).toMatchObject({ id: "context-pack:packs/a", name: "raw%2F:雪", version: "01", missingFiles: [{ path: "missing.md", role: "proof" }] });
  expect(result.current.data?.bundleText).toContain("emoji 🐈"); rerender({ ref: "packs/absent" });
  await waitFor(() => expect(result.current.error?.message).toBe("HTTP 404")); expect(result.current.data).toBeUndefined();
  rerender({ ref: "../escape" }); await waitFor(() => expect(result.current.error?.message).toBe("HTTP 400"));
  expect(fetch.mock.calls.every(([url]) => !String(url).includes("host="))).toBe(true);
});
