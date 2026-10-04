import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLibraryReview, useSpecLibrary } from "../src/hooks/useSpecLibrary.js";

// Exact served opaque ID and nullable workflow DTO; no client-built identity.
const id = "served%id:name/version";
const review = { kind: "workflow", libraryEntryId: id, name: "same:name", version: "version:1",
  purpose: null, targetRig: null, terminalTurnRule: "done", rolesCount: 0, stepsCount: 0, isBuiltIn: false,
  sourcePath: "/private/fixture/workflow.yaml", cachedAt: "2026-10-04T00:00:00Z",
  topology: { nodes: [], edges: [] }, steps: [] };
const entry = { id, kind: "workflow", name: review.name, version: review.version, sourceType: "user_file",
  sourcePath: review.sourcePath, relativePath: "workflow.yaml", updatedAt: review.cachedAt };
const kinds = ["catalog", "review"] as const;
type ReadKind = typeof kinds[number];
const clients: QueryClient[] = [];
const key = (kind: ReadKind, source: string | null) => kind === "catalog"
  ? ["spec-library", "workflow", source] : ["spec-library", "review", id, source];
const payload = (kind: ReadKind, source: string) => kind === "catalog"
  ? [{ ...entry, sourceEvidence: source }] : { ...review, sourceEvidence: source };
const route = (kind: ReadKind) => kind === "catalog" ? "/api/specs/library?kind=workflow"
  : `/api/specs/library/${encodeURIComponent(id)}/review`;
function useRead(kind: ReadKind, sourceHostId?: string | null) {
  return kind === "catalog" ? useSpecLibrary("workflow", { sourceHostId }) : useLibraryReview(id, { sourceHostId });
}
function harness(selected?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0,
    placeholderData: (previous: unknown) => previous } } }); clients.push(client);
  if (selected) client.setQueryData(["hosts"], { ownName: "Fixture", selected, hosts: [] });
  return { client, wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe.each(kinds)("spec %s read origin", kind => {
  it("keeps default selected-remote route and existing key", async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json(payload(kind, "remote/exact"))); vi.stubGlobal("fetch", fetch);
    const { client, wrapper } = harness("remote/exact"); const { result } = renderHook(() => useRead(kind), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(payload(kind, "remote/exact")));
    expect(fetch.mock.calls[0]?.[0]).toBe(`${route(kind)}${kind === "catalog" ? "&" : "?"}host=remote%2Fexact`);
    expect(client.getQueryData(key(kind, "remote/exact"))).toEqual(payload(kind, "remote/exact"));
  });
  it("keeps the existing absent-selection local default", async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json(payload(kind, "local"))); vi.stubGlobal("fetch", fetch);
    const { client, wrapper } = harness(); const { result } = renderHook(() => useRead(kind), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(payload(kind, "local")));
    expect(fetch.mock.calls[0]?.[0]).toBe(route(kind)); expect(client.getQueryData(key(kind, "local"))).toEqual(payload(kind, "local"));
  });
  it("pins connected-local reads despite a selected remote host", async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json(payload(kind, "local"))); vi.stubGlobal("fetch", fetch);
    const { client, wrapper } = harness("remote/exact"); const { result } = renderHook(() => useRead(kind, "local"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(payload(kind, "local")));
    expect(fetch.mock.calls[0]?.[0]).toBe(route(kind)); expect(result.current.sourceHostId).toBe("local");
    expect(client.getQueryData(key(kind, "local"))).toEqual(payload(kind, "local")); expect(client.getQueryData(key(kind, "remote/exact"))).toBeUndefined();
    act(() => client.setQueryData(["hosts"], { ownName: "Fixture", selected: "other/remote", hosts: [] }));
    await act(async () => { await Promise.resolve(); });
    expect(fetch).toHaveBeenCalledOnce(); expect(result.current.sourceHostId).toBe("local");
  });
  it("changes explicit origins without exposing or caching a late old body", async () => {
    let finishOld!: (value: unknown) => void; const cancel = vi.fn(async () => {});
    const fetch = vi.fn(async (url: string, _options?: RequestInit) => url.includes("host=A")
      ? { ok: true, json: () => new Promise(resolve => { finishOld = resolve; }), body: { cancel } }
      : Response.json(payload(kind, "B")));
    vi.stubGlobal("fetch", fetch); const { client, wrapper } = harness("unrelated/selected");
    const { result, rerender } = renderHook(({ source }: { source: string }) => useRead(kind, source), { wrapper, initialProps: { source: "A" } });
    await waitFor(() => expect(finishOld).toBeTypeOf("function")); rerender({ source: "B" });
    expect(result.current.data).toBeUndefined(); expect(result.current.isPlaceholderData).toBe(false);
    await waitFor(() => expect(result.current.data).toEqual(payload(kind, "B"))); expect(result.current.sourceHostId).toBe("B");
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
    await act(async () => { finishOld(payload(kind, "A")); }); expect(result.current.data).toEqual(payload(kind, "B"));
    expect(client.getQueryData(key(kind, "A"))).toBeUndefined(); expect(client.getQueryData(key(kind, "B"))).toEqual(payload(kind, "B"));
  });
  it("unknown origin masks warm data and cannot manually refetch local", async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json(payload(kind, "local"))); vi.stubGlobal("fetch", fetch);
    const { client, wrapper } = harness("local"); client.setQueryData(key(kind, null), payload(kind, "unverified"));
    const { result } = renderHook(() => useRead(kind, null), { wrapper });
    expect(result.current.data).toBeUndefined(); expect(result.current.sourceHostId).toBeNull(); expect(result.current.fetchStatus).toBe("idle"); expect(fetch).not.toHaveBeenCalled();
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.error).toMatchObject({ code: "invalid_request" })); expect(result.current.data).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });
  it("drops prior known data on unknown origin under global keepPreviousData", async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json(payload(kind, "local"))); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness("remote/selected");
    const { result, rerender } = renderHook(({ source }: { source: string | null }) => useRead(kind, source), { wrapper, initialProps: { source: "local" as string | null } });
    await waitFor(() => expect(result.current.data).toEqual(payload(kind, "local"))); rerender({ source: null });
    expect(result.current.data).toBeUndefined(); expect(result.current.sourceHostId).toBeNull(); expect(result.current.isPlaceholderData).toBe(false); expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps cancellation linked and disposes late headers without decoding", async () => {
    let finish!: (value: unknown) => void; const cancel = vi.fn(async () => {}), json = vi.fn();
    const fetch = vi.fn((_url: string, _options?: RequestInit) => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
    const { client, wrapper } = harness("remote/selected"); renderHook(() => useRead(kind, "local"), { wrapper }); await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await act(async () => { await client.cancelQueries({ queryKey: key(kind, "local") }); }); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => { finish({ body: { cancel }, json }); }); expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
  });
  it("preserves the total five-second deadline for an ignored-abort body", async () => {
    vi.useFakeTimers(); const cancel = vi.fn(async () => {});
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: () => new Promise(() => {}), body: { cancel } })); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness("remote/selected"); const { result } = renderHook(() => useRead(kind, "local"), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); }); expect(result.current.error).toMatchObject({ code: "timeout" });
    expect(fetch.mock.calls[0]?.[0]).toBe(route(kind)); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
  });
});
