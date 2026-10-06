import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRigSummary } from "../src/hooks/useRigSummary.js";
import { useRigGraph } from "../src/hooks/useRigGraph.js";
import { usePsEntries } from "../src/hooks/usePsEntries.js";
import { useNodeInventory } from "../src/hooks/useNodeInventory.js";

const selection = vi.hoisted(() => ({ host: "local" }));
vi.mock("../src/hooks/useHosts.js", () => ({ useSelectedHostId: () => selection.host }));
const ps = { rigId: "rig-a", name: "A", nodeCount: 1, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null };
const unconfiguredNode = { rigId: "rig-a", rigName: "A", logicalId: "seat", podId: null, canonicalSessionName: null,
  nodeKind: "agent", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "not_restored",
  tmuxAttachCommand: null, resumeCommand: null, latestError: null, contextUsage: null, agentActivity: null, identityVerdict: null };
const cases = [
  ["summary", (_rig: string) => useRigSummary(), [{ id: "rig-a", name: null }]],
  ["graph", (rig: string) => useRigGraph(rig), { nodes: [null, { id: "seat" }], edges: [] }],
  ["ps", (_rig: string) => usePsEntries(), [ps]],
  ["nodes", (rig: string) => useNodeInventory(rig), [unconfiguredNode]],
] as const;
const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, placeholderData: keepPreviousData } } });
  clients.push(client);
  return { client, Wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); selection.host = "local"; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("fleet reads exclude previous selections even with the application placeholder default", () => {
  it.each(cases)("%s clears the old host while the next host body is pending", async (_name, useRead, original) => {
    let complete!: (value: unknown) => void;
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => original })
      .mockResolvedValueOnce({ ok: true, json: () => new Promise(done => { complete = done; }) });
    vi.stubGlobal("fetch", fetch);
    const { Wrapper } = wrapper(); const { result, rerender } = renderHook(() => useRead("rig-a"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(original));
    selection.host = "remote/exact"; rerender();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeUndefined(); expect(result.current.isPlaceholderData).toBe(false);
    await act(async () => { complete(original); });
    await waitFor(() => expect(result.current.data).toEqual(original));
    expect(fetch.mock.calls[1][0]).toContain("host=remote%2Fexact");
  });
  it.each([cases[1], cases[3]])("%s excludes the old rig on a delayed cross-rig body", async (_name, useRead, original) => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => original })
      .mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) }); vi.stubGlobal("fetch", fetch);
    const { Wrapper } = wrapper(); const { result, rerender } = renderHook(({ rig }) => useRead(rig), { initialProps: { rig: "rig-a" }, wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(original)); rerender({ rig: "rig-b" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); expect(result.current.data).toBeUndefined();
  });
  it.each([cases[1], cases[3]])("%s manual empty-ID refetch refuses the GET", async (_name, useRead) => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ nodes: [], edges: [] }) })); vi.stubGlobal("fetch", fetch);
    const { Wrapper } = wrapper(); const { result } = renderHook(() => useRead(""), { wrapper: Wrapper });
    let response: any; await act(async () => { response = await result.current.refetch(); });
    expect(fetch).not.toHaveBeenCalled(); expect(response.error).toMatchObject({ code: "invalid_request" });
  });
  it("inventory rejects a response from another exact rig instead of publishing its sessions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [{ ...unconfiguredNode, rigId: "rig-b" }] })));
    const { Wrapper } = wrapper(); const { result } = renderHook(() => useNodeInventory("rig-a"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" }); expect(result.current.data).toBeUndefined();
  });
  it.each([cases[2], cases[3]])("%s rejects malformed containers and rows", async (_name, useRead) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [null] })));
    const { Wrapper } = wrapper(); const { result } = renderHook(() => useRead("rig-a"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({ code: "invalid_contract" });
  });
  it("inventory aborts its pending body on host change and ignores a late same-ID session", async () => {
    let complete!: (v: unknown) => void; const cancel = vi.fn(async () => {});
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, body: { cancel }, json: () => new Promise(done => { complete = done; }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ ...unconfiguredNode, rigName: "Remote" }] }); vi.stubGlobal("fetch", fetch);
    const { Wrapper, client } = wrapper(); const { result, rerender } = renderHook(() => useNodeInventory("rig-a"), { wrapper: Wrapper });
    await waitFor(() => expect(complete).toBeTypeOf("function")); selection.host = "remote"; rerender();
    await waitFor(() => expect(result.current.data?.[0].rigName).toBe("Remote"));
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
    await act(async () => { complete([unconfiguredNode]); }); expect(result.current.data?.[0].rigName).toBe("Remote");
    expect(client.getQueryData(["rig", "rig-a", "nodes", "local"])).toBeUndefined();
  });
  it.each(cases)("%s does not restore old-host rows after the new host fails", async (_name, useRead, original) => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => original })
      .mockResolvedValueOnce(Response.json({ error: "remote_read_failed" }, { status: 502 })); vi.stubGlobal("fetch", fetch);
    const { Wrapper } = wrapper(); const { result, rerender } = renderHook(() => useRead("rig-a"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual(original)); selection.host = "unavailable"; rerender();
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.data).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([cases[2], cases[3]])("%s cancels the body on unmount", async (_name, useRead) => {
    let started = false; const cancel = vi.fn(async () => {}); const fetch = vi.fn(async () => ({ ok: true,
      body: { cancel }, json: () => { started = true; return new Promise(() => {}); } })); vi.stubGlobal("fetch", fetch);
    const { Wrapper } = wrapper(); const { unmount } = renderHook(() => useRead("rig-a"), { wrapper: Wrapper });
    await waitFor(() => expect(started).toBe(true)); unmount();
    expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
  });
  it("retains valid partial graph entries and nullable summary names rather than discarding siblings", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("graph")
      ? { nodes: [null, { id: "valid" }], edges: [null] } : [{ id: "rig-a", name: null }, { id: "rig-b", name: "B" }] })));
    const { Wrapper } = wrapper(); const { result } = renderHook(() => ({ graph: useRigGraph("rig-a"), summary: useRigSummary() }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.graph.isSuccess && result.current.summary.isSuccess).toBe(true));
    expect(result.current.graph.data).toEqual({ nodes: [null, { id: "valid" }], edges: [null] });
    expect(result.current.summary.data).toEqual([{ id: "rig-a", name: null }, { id: "rig-b", name: "B" }]);
  });
});
