import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useNodeDetail } from "../src/hooks/useNodeDetail.js";
import { useLibraryReview, useSpecLibrary } from "../src/hooks/useSpecLibrary.js";
const node = { rigId: "rig/exact", rigName: "Rig", logicalId: "seat.exact", podId: null,
  canonicalSessionName: "seat-exact@Rig", nodeKind: "agent", runtime: null, sessionStatus: null,
  startupStatus: null, restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, recoveryGuidance: null,
  latestError: null, model: null, agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: null,
  startupFiles: [], startupActions: [], recentEvents: [], infrastructureStartupCommand: null, peers: [],
  edges: { outgoing: [], incoming: [] }, transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 } };
const review = { kind: "rig", libraryEntryId: "opaque/id:one", sourcePath: "/private/spec.yaml", sourceState: "library_item",
  name: "Same display name", version: "1", format: "legacy", nodes: [], edges: [], graph: { nodes: [], edges: [] }, raw: "name: Same display name" };
const entry = { id: review.libraryEntryId, kind: "rig", name: review.name, version: "1", sourceType: "user_file",
  sourcePath: review.sourcePath, relativePath: "spec.yaml", updatedAt: "2026-10-04", resolvedSourcePath: null };
const clients: QueryClient[] = [];
function harness(selected?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, placeholderData: previous => previous } } }); clients.push(client);
  if (selected) client.setQueryData(["hosts"], { selected, hosts: [] });
  return { client, wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
afterEach(() => { clients.splice(0).forEach(c => c.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("node/library read identity", () => {
  it.each(["rig", "seat", "host"])("drops old node/session when %s changes while replacement is pending", async change => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(node)).mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness("local");
    const { result, rerender } = renderHook(({ rigId, seat }) => useNodeDetail(rigId, seat), { wrapper, initialProps: { rigId: node.rigId, seat: node.logicalId } });
    await waitFor(() => expect(result.current.data).toEqual(node));
    if (change === "host") act(() => client.setQueryData(["hosts"], { selected: "remote/exact", hosts: [] }));
    else rerender({ rigId: change === "rig" ? "other/rig" : node.rigId, seat: change === "seat" ? "other.seat" : node.logicalId });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); expect(result.current.data).toBeUndefined(); expect(result.current.isPlaceholderData).toBe(false);
  });
  it.each(["id", "host"])("drops previous review when %s changes, even with colliding display names", async change => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(review)).mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness("local"); const { result, rerender } = renderHook(({ id }) => useLibraryReview(id), { wrapper, initialProps: { id: review.libraryEntryId } });
    await waitFor(() => expect(result.current.data).toEqual(review));
    if (change === "host") act(() => client.setQueryData(["hosts"], { selected: "remote/exact", hosts: [] })); else rerender({ id: "opaque/id:two" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); expect(result.current.data).toBeUndefined();
  });
  it.each(["kind", "host"])("drops previous library when %s changes", async change => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([entry])).mockImplementation(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch);
    const { wrapper, client } = harness("local"); const { result, rerender } = renderHook(({ kind }: { kind: "rig" | "agent" }) => useSpecLibrary(kind), { wrapper, initialProps: { kind: "rig" } });
    await waitFor(() => expect(result.current.data).toEqual([entry]));
    if (change === "host") act(() => client.setQueryData(["hosts"], { selected: "remote/exact", hosts: [] })); else rerender({ kind: "agent" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); expect(result.current.data).toBeUndefined();
  });
  it.each([undefined, "local", "remote/exact"])("preserves supported scope %s and query keys", async selected => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json(node)); vi.stubGlobal("fetch", fetch); const { wrapper, client } = harness(selected);
    const { result } = renderHook(() => useNodeDetail(node.rigId, node.logicalId), { wrapper }); await waitFor(() => expect(result.current.data).toEqual(node));
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/rigs/rig%2Fexact/nodes/seat.exact${selected === "remote/exact" ? "?host=remote%2Fexact" : ""}`);
    expect(client.getQueryData(["rig", node.rigId, "nodes", node.logicalId, selected ?? "local"])).toEqual(node);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["node", "review", "library"])("bounds never-resolving %s bodies", async kind => {
    vi.useFakeTimers(); const cancel = vi.fn(async () => {});
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true, json: () => new Promise(() => {}), body: { cancel } })); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness("remote/exact"); const { result } = renderHook(() => kind === "node" ? useNodeDetail(node.rigId, node.logicalId) : kind === "review" ? useLibraryReview(review.libraryEntryId) : useSpecLibrary(), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); }); expect(result.current.error).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it.each(["node", "review", "library"])("cancels %s and disposes late headers without decoding", async kind => {
    let resolve!: (v: unknown) => void; const cancel = vi.fn(async () => {}), json = vi.fn();
    const fetch = vi.fn((_url: string, _options?: RequestInit) => new Promise(done => { resolve = done; })); vi.stubGlobal("fetch", fetch); const { wrapper, client } = harness("local");
    renderHook(() => kind === "node" ? useNodeDetail(node.rigId, node.logicalId) : kind === "review" ? useLibraryReview(review.libraryEntryId) : useSpecLibrary(), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); await act(async () => { await client.cancelQueries(); }); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => { resolve({ body: { cancel }, json }); }); expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
  });
  it.each([{ ...node, rigId: "other" }, { ...node, logicalId: "other" }])("rejects wrong served node identity %j", async value => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value))); const { wrapper } = harness(); const { result } = renderHook(() => useNodeDetail(node.rigId, node.logicalId), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" }); expect(result.current.data).toBeUndefined();
  });
  it("rejects review for another opaque ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...review, libraryEntryId: "opaque/id:two" }))); const { wrapper } = harness(); const { result } = renderHook(() => useLibraryReview(review.libraryEntryId), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" });
  });
  it("keeps same-identity stale evidence distinguishable from first-load unavailability", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(node)).mockResolvedValue(Response.json({ error: "origin unavailable" }, { status: 503 })); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness(); const { result } = renderHook(() => ({ ...useNodeDetail(node.rigId, node.logicalId) }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(node)); const observedAt = result.current.dataUpdatedAt;
    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toEqual(node); expect(result.current.dataUpdatedAt).toBe(observedAt);
    await waitFor(() => expect(result.current.isRefetchError).toBe(true)); expect(result.current.error).toMatchObject({ code: "http", status: 503 });
  });
  it("drops disabled node/review selections and blocks manual refetch of missing identity", async () => {
    const fetch = vi.fn(async (url: string) => Response.json(url.includes("/nodes/") ? node : review)); vi.stubGlobal("fetch", fetch);
    const { wrapper } = harness();
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => ({ node: { ...useNodeDetail(node.rigId, id ? node.logicalId : null) }, review: { ...useLibraryReview(id) } }), { wrapper, initialProps: { id: review.libraryEntryId } });
    await waitFor(() => expect(result.current.review.data).toEqual(review)); await waitFor(() => expect(result.current.node.data).toEqual(node));
    rerender({ id: null }); expect(result.current.review.data).toBeUndefined(); expect(result.current.node.data).toBeUndefined();
    await act(async () => { await result.current.node.refetch(); await result.current.review.refetch(); });
    await waitFor(() => expect(result.current.node.error).toMatchObject({ code: "invalid_request" })); await waitFor(() => expect(result.current.review.error).toMatchObject({ code: "invalid_request" })); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed catalog instead of exposing arbitrary JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: [entry] }))); const { wrapper } = harness(); const { result } = renderHook(() => useSpecLibrary(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" });
  });
});
