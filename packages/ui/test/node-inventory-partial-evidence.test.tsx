import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNodeInventoryEntry, readNodeInventory } from "../src/lib/fleet-inventory-reads.js";
import { isNodeDetail, readNodeDetail } from "../src/lib/node-library-reads.js";
import { OperatorReadError } from "../src/lib/operator-read.js";
import { useNodeInventory } from "../src/hooks/useNodeInventory.js";

const rigId = "rig%opaque/one", hostId = "remote/exact";
const row = { rigId, rigName: "Private", logicalId: "seat%one", podId: null, canonicalSessionName: null,
  nodeKind: "agent", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "none",
  tmuxAttachCommand: null, resumeCommand: null, latestError: null };
const detail = { ...row, recoveryGuidance: null, model: null, agentRef: null, profile: null,
  resolvedSpecName: null, resolvedSpecVersion: null, cwd: null, startupFiles: [], startupActions: [], recentEvents: [],
  infrastructureStartupCommand: null, peers: [], edges: { outgoing: [], incoming: [] },
  transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 } };
function serve(value: unknown) {
  const fetch = vi.fn(async (_route: string, _options?: RequestInit) => ({ ok: true, json: async () => value }));
  vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("dated inventory partial evidence", () => {
  it("retains fully valid same-rig original rows/additive facts and excludes invalid or foreign rows", async () => {
    const valid = { ...row, resolvedSpecName: "served:name", resolvedSpecVersion: "1:2", resolvedSpecHash: "opaque-hash",
      lifecycleState: "detached", futureFact: { exact: "retained" } };
    const foreign = { ...row, rigId: "other-rig", logicalId: "foreign" };
    const fetch = serve([valid, null, { ...row, logicalId: "" }, foreign]);
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    const error = await readNodeInventory(rigId, hostId).catch(error => error);
    expect(error).toBeInstanceOf(OperatorReadError); expect(error.name).toBe("NodeInventoryPartialReadError");
    expect(error.code).toBe("invalid_contract");
    expect(error.partial).toEqual({ hostId, rigId, rows: [valid], rejectedCount: 3, receivedAt: 123456 });
    expect(error.partial.rows[0]).toBe(valid); expect(Object.keys(error.partial).sort()).toEqual(["hostId", "receivedAt", "rejectedCount", "rigId", "rows"]);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rigs/rig%25opaque%2Fone/nodes?host=remote%2Fexact"); now.mockRestore();
  });
  it("keeps successful empty arrays distinct from all-invalid evidence", async () => {
    const empty: unknown[] = []; serve(empty); expect(await readNodeInventory(rigId, hostId)).toBe(empty);
    serve([null, { ...row, rigId: "foreign" }]); const error = await readNodeInventory(rigId, hostId).catch(error => error);
    expect(error.name).toBe("NodeInventoryPartialReadError"); expect(error.partial).toMatchObject({ hostId, rigId, rows: [], rejectedCount: 2 });
  });
  it.each([null, {}, "not an array"])("keeps malformed top-level %j an ordinary contract error", async value => {
    serve(value); const error = await readNodeInventory(rigId, hostId).catch(error => error);
    expect(error).toBeInstanceOf(OperatorReadError); expect(error.name).toBe("OperatorReadError");
    expect(error.code).toBe("invalid_contract"); expect(error).not.toHaveProperty("partial");
  });
  it.each([undefined, null, "actual:binding"])("retains absent/nullable/string effective bindings (%j)", async value => {
    const valid = value === undefined ? { ...row } : { ...row, resolvedSpecName: value, resolvedSpecVersion: value, resolvedSpecHash: value };
    const rows = [valid]; serve(rows); expect(isNodeInventoryEntry(valid)).toBe(true); expect(await readNodeInventory(rigId, hostId)).toBe(rows);
    if (value === undefined) expect(rows[0]).not.toHaveProperty("resolvedSpecHash");
  });
  it.each(["running", "detached", "recoverable", "attention_required"])("accepts exact node lifecycle %s", async lifecycleState => {
    const rows = [{ ...row, lifecycleState }]; serve(rows); expect(isNodeInventoryEntry(rows[0])).toBe(true); expect(await readNodeInventory(rigId, hostId)).toBe(rows);
  });
  it.each([
    { resolvedSpecName: 7 }, { resolvedSpecVersion: {} }, { resolvedSpecHash: false },
    { lifecycleState: "stopped" }, { lifecycleState: "degraded" }, { lifecycleState: null }, { lifecycleState: "invented" },
  ])("rejects malformed effective field %j while retaining its healthy sibling", async invalid => {
    const bad = { ...row, logicalId: "bad", ...invalid }; expect(isNodeInventoryEntry(bad)).toBe(false);
    serve([row, bad]); const error = await readNodeInventory(rigId, hostId).catch(error => error);
    expect(error.partial).toMatchObject({ rows: [row], rejectedCount: 1 }); expect(error.partial.rows[0]).toBe(row);
  });
  it.each([undefined, null, "served-hash"])("detail retains optional nullable effective hash (%j)", async hash => {
    const value = hash === undefined ? { ...detail } : { ...detail, resolvedSpecHash: hash };
    serve(value); expect(isNodeDetail(value)).toBe(true); expect(await readNodeDetail(rigId, row.logicalId, hostId)).toBe(value);
    if (hash === undefined) expect(value).not.toHaveProperty("resolvedSpecHash");
  });
  it.each([42, {}, false])("detail refuses malformed effective hash %j", async resolvedSpecHash => {
    const value = { ...detail, resolvedSpecHash }; expect(isNodeDetail(value)).toBe(false); serve(value);
    await expect(readNodeDetail(rigId, row.logicalId, hostId)).rejects.toMatchObject({ code: "invalid_contract" });
  });
  it.each(["cancelled", "timeout"])("late malformed body cannot replace a %s receipt with partial evidence", async code => {
    vi.useFakeTimers(); const caller = new AbortController(), remove = vi.spyOn(caller.signal, "removeEventListener");
    let finish!: (value: unknown) => void; const cancel = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: { cancel }, json: () => new Promise(resolve => { finish = resolve; }) })));
    const pending = readNodeInventory(rigId, hostId, { signal: caller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); if (code === "cancelled") caller.abort(); else await vi.advanceTimersByTimeAsync(5000);
    const error = await pending; expect(error).toMatchObject({ code }); expect(error).not.toHaveProperty("partial");
    finish([row, null]); await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBe(error); expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("keeps same-key dated success separate from a newer partial read; never merges or relabels it", async () => {
    const old = [{ ...row, logicalId: "old-success" }], next = { ...row, logicalId: "new-partial", futureFact: "new" };
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => old })
      .mockResolvedValueOnce({ ok: true, json: async () => [next, null] }); vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    client.setQueryData(["hosts"], { ownName: "Private", selected: hostId, hosts: [] });
    const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    // Track error/freshness fields during render, as an actual disclosure consumer does.
    const hook = renderHook(() => ({ ...useNodeInventory(rigId) }), { wrapper });
    try {
      await waitFor(() => expect(hook.result.current.data).toBe(old)); const at = hook.result.current.dataUpdatedAt;
      await act(async () => { await hook.result.current.refetch(); });
      await waitFor(() => expect(hook.result.current.isRefetchError).toBe(true));
      expect(hook.result.current.data).toBe(old); expect(hook.result.current.dataUpdatedAt).toBe(at);
      expect(hook.result.current.error).toMatchObject({ code: "invalid_contract", partial: { hostId, rigId, rows: [next], rejectedCount: 1 } });
      expect(client.getQueryData(["rig", rigId, "nodes", hostId])).toBe(old);
    } finally { hook.unmount(); client.clear(); }
  });
});
