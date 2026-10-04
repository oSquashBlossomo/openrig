import { afterEach, describe, expect, it, vi } from "vitest";
import { isTopologyGraph, isTopologyRigSummary, topologyRead } from "../src/lib/topology-read.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bounded host-forwarded topology read", () => {
  it("accepts and preserves the served summary DTO and additive inventory fields", async () => {
    const payload = [{ id: "rig-exact", name: "acme", nodeCount: 2, latestSnapshotAt: null,
      latestSnapshotId: null, hasServices: true, archivedAt: null, lifecycleState: "running", hasLiveAgents: true }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    expect(isTopologyRigSummary(payload)).toBe(true);
    await expect(topologyRead("/api/rigs/summary", "hostB", undefined, isTopologyRigSummary)).resolves.toEqual(payload);
  });

  it("keeps malformed graph entries as explicit parser issues while rejecting missing containers", async () => {
    const partial = { nodes: [null, { id: "valid", data: { logicalId: "valid" } }], edges: [null], additiveField: "preserved" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(partial)));
    await expect(topologyRead("/api/rigs/exact/graph", "local", undefined, isTopologyGraph)).resolves.toEqual(partial);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nodes: [] })));
    await expect(topologyRead("/api/rigs/exact/graph", "local", undefined, isTopologyGraph)).rejects.toMatchObject({ code: "invalid_contract", message: "Invalid topology graph payload." });
  });

  it.each([
    ["local", "/api/rigs/summary"],
    ["remote / beta", "/api/rigs/summary?host=remote%20%2F%20beta"],
  ])("reads the same payload shape through the %s host envelope", async (hostId, route) => {
    const payload = [{ id: "same-id", name: "served", additiveField: "preserved" }];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    await expect(topologyRead("/api/rigs/summary", hostId)).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([route, expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) })]);
  });

  it.each(["headers", "body"])("bounds ignored-abort %s hangs and cleans the deadline/listener", async stage => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const cancel = vi.fn(async () => {});
    const response = { ok: true, json: () => new Promise(() => {}), body: { cancel } } as unknown as Response;
    const fetch = vi.fn<typeof globalThis.fetch>(() => stage === "headers" ? new Promise(() => {}) : Promise.resolve(response));
    vi.stubGlobal("fetch", fetch);
    const result = topologyRead("/api/rigs/ra/graph", "hostB", caller.signal).catch(e => e);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "timeout", message: "Topology read timed out after 5 seconds." });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(stage === "body" ? 1 : 0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("caller cancellation interrupts an ignored-abort %s read immediately", async stage => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const cancel = vi.fn(async () => {});
    const response = { ok: true, json: () => new Promise(() => {}), body: { cancel } } as unknown as Response;
    const fetch = vi.fn<typeof globalThis.fetch>(() => stage === "headers" ? new Promise(() => {}) : Promise.resolve(response));
    vi.stubGlobal("fetch", fetch);
    const result = topologyRead("/api/rigs/ra/graph", "hostB", caller.signal).catch(e => e);
    await Promise.resolve();
    caller.abort();
    expect(await result).toMatchObject({ code: "cancelled" });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(stage === "body" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a late response body after the header deadline without decoding it", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const result = topologyRead("/api/rigs/ra/graph", "hostB").catch(e => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toMatchObject({ code: "timeout" });
    const cancel = vi.fn(async () => {});
    const json = vi.fn(async () => ({ nodes: [], edges: [] }));
    release({ ok: true, body: { cancel }, json } as unknown as Response);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects an already-cancelled read before starting a fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const caller = new AbortController(); caller.abort();
    await expect(topologyRead("/api/rigs/summary", "hostB", caller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cleans successful reads and preserves caller cancellation ownership", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ nodes: [], edges: [] }));
    vi.stubGlobal("fetch", fetch);
    await topologyRead("/api/rigs/ra/graph", "local", caller.signal);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    caller.abort();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("reports HTTP failure without waiting for an error body's JSON", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => {});
    const json = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, body: { cancel }, json } as unknown as Response)));
    await expect(topologyRead("/api/rigs/ra/graph", "hostB")).rejects.toThrow("HTTP 503");
    expect(json).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
