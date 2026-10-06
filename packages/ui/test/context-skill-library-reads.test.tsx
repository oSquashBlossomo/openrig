import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Hono } from "hono";
import { contextPacksRoutes } from "../../daemon/src/routes/context-packs.js";
import { skillsRoutes } from "../../daemon/src/routes/skills.js";
import { useContextPackLibrary } from "../src/hooks/useContextPackLibrary.js";
import { useLibrarySkills } from "../src/hooks/useLibrarySkills.js";

const pack = {
  id: "context-pack:packs/raw%2F:雪", kind: "context-pack", name: "", version: "01", purpose: null,
  sourceType: "workspace", sourcePath: "/fictional/packs/raw", relativePath: "packs/raw%2F:雪", updatedAt: "",
  manifestEstimatedTokens: null, derivedEstimatedTokens: 0,
  files: [{ path: "empty.md", role: "", summary: "", absolutePath: "/fictional/empty.md", bytes: 0, estimatedTokens: 0 },
    { path: "missing.md", role: "proof", summary: null, absolutePath: null, bytes: null, estimatedTokens: null }],
  future: { retained: true },
};
const skill = {
  id: "openrig-managed:raw%2F:雪", name: "", source: "openrig-managed", absolutePath: "/fictional/skill",
  files: [{ name: "SKILL.md", path: "SKILL.md", size: 0, mtime: "" }], future: { retained: true },
};
const families = [
  { family: "context", route: "/api/context-packs/library", key: ["context-packs", "library"], valid: pack, hook: useContextPackLibrary },
  { family: "skills", route: "/api/skills/library", key: ["skills", "library"], valid: skill, hook: useLibrarySkills },
] as const;
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount(f: typeof families[number], fetch: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", vi.fn(fetch));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(qc);
  qc.setQueryData(["hosts"], { ownName: "fictional", selected: "remote", hosts: [] });
  const hook = renderHook(() => ({ ...f.hook() }), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
  return { ...hook, qc, fetch: vi.mocked(globalThis.fetch) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

for (const f of families) {
  it(`${f.family} actual missing-service503 is unavailable, never successful empty`, async () => {
    const app = new Hono(); app.route("/api/context-packs", contextPacksRoutes()); app.route("/api/skills", skillsRoutes());
    const real = await app.request(f.route); expect(real.status).toBe(503);
    const { result, fetch } = mount(f, async () => app.request(f.route));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined(); expect(result.current.error?.message).toBe("HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  for (const invalid of [null, { future: [] }, [{}], [f.valid, { id: "broken-sibling" }]]) {
    it(`${f.family} malformed catalog ${JSON.stringify(invalid)} is a contract error`, async () => {
      const { result } = mount(f, async () => Response.json(invalid));
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toMatchObject({ code: "invalid_contract" }); expect(result.current.data).toBeUndefined();
    });
  }
  it(`${f.family} malformed JSON is distinct from empty`, async () => {
    const { result } = mount(f, async () => new Response("{bad", { headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: "invalid_json" }); expect(result.current.data).toBeUndefined();
  });
  it(`${f.family} retains exact IDs, null/empty/zero/additive facts and connected-instance scope`, async () => {
    const { result, fetch, qc } = mount(f, async () => Response.json([f.valid]));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([f.valid]); expect(qc.getQueryData(f.key)).toEqual([f.valid]);
    expect(fetch.mock.calls[0]![0]).toBe(f.route);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", signal: expect.any(AbortSignal) });
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("headers");
  });
  it(`${f.family} valid empty catalog remains successful empty`, async () => {
    const { result } = mount(f, async () => Response.json([])); await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
  it(`${f.family} preserves absent compatible display metadata as unknown`, async () => {
    const older = { ...f.valid } as Record<string, unknown>;
    const field = f.family === "context" ? "purpose" : "absolutePath"; delete older[field];
    const { result } = mount(f, async () => Response.json([older]));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([older]); expect(result.current.data?.[0]).not.toHaveProperty(field);
  });
  it(`${f.family} rejects incorrectly typed supplied display metadata`, async () => {
    const invalid = { ...f.valid, ...(f.family === "context" ? { purpose: false } : { absolutePath: 42 }) };
    const { result } = mount(f, async () => Response.json([invalid]));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: "invalid_contract" }); expect(result.current.data).toBeUndefined();
  });
  it(`${f.family} failed refresh retains successful same-key data with an error`, async () => {
    let fail = false;
    const { result } = mount(f, async () => fail ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json([f.valid]));
    await waitFor(() => expect(result.current.isSuccess).toBe(true)); fail = true;
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toEqual([f.valid]); expect(result.current.error?.message).toBe("HTTP 503");
  });
  it.each(["headers", "body"])(`${f.family} total deadline bounds never-resolving %s`, async stage => {
    vi.useFakeTimers(); const never = new Promise<Response>(() => {});
    const { result, fetch } = mount(f, async () => stage === "headers" ? never : { ok: true, json: () => new Promise(() => {}) } as unknown as Response);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
    expect(result.current.isError).toBe(true); expect(result.current.error).toMatchObject({ code: "timeout" });
    expect(result.current.data).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
  it(`${f.family} cancellation disposes late headers without decoding or cache publication`, async () => {
    const late = deferred<Response>(), cancel = vi.fn().mockResolvedValue(undefined), json = vi.fn().mockResolvedValue([f.valid]);
    const { unmount, qc, fetch } = mount(f, async () => late.promise);
    expect(fetch).toHaveBeenCalledTimes(1); unmount();
    await act(async () => { late.resolve({ ok: true, body: { cancel }, json } as unknown as Response); await Promise.resolve(); });
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled(); expect(qc.getQueryData(f.key)).toBeUndefined();
  });
}
