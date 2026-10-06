import { afterEach, describe, expect, it, vi } from "vitest";
import { readNodeInventory, readPsEntries } from "../src/lib/fleet-inventory-reads.js";
const reads = [
  ["ps", (signal?: AbortSignal) => readPsEntries("remote/exact", { signal })],
  ["nodes", (signal?: AbortSignal) => readNodeInventory("rig/exact", "remote/exact", { signal })],
] as const;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("fleet inventory total deadlines and cancellation", () => {
  it.each(reads)("%s counts headers and body against one five-second budget", async (_name, read) => {
    vi.useFakeTimers(); let headers!: (v: unknown) => void; const cancel = vi.fn(async () => {});
    const fetch = vi.fn(() => new Promise(done => { headers = done; })); vi.stubGlobal("fetch", fetch);
    const pending = read().catch(e => e); await vi.advanceTimersByTimeAsync(4000);
    headers({ ok: true, body: { cancel }, json: () => new Promise(() => {}) }); await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(reads)("%s aborts a pending body and disposes its caller listener and timer", async (_name, read) => {
    vi.useFakeTimers(); const caller = new AbortController(); const remove = vi.spyOn(caller.signal, "removeEventListener");
    const cancel = vi.fn(async () => {}); let finish!: (v: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: { cancel }, json: () => new Promise(done => { finish = done; }) })));
    const pending = read(caller.signal).catch(e => e); await Promise.resolve(); await Promise.resolve(); caller.abort();
    expect(await pending).toMatchObject({ code: "cancelled" }); finish([]); await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(reads)("%s never starts a pre-cancelled request", async (_name, read) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const caller = new AbortController(); caller.abort();
    await expect(read(caller.signal)).rejects.toMatchObject({ code: "cancelled" }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(reads)("%s bounds error-response bodies as well as successful reads", async (_name, read) => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: () => new Promise(() => {}) })));
    const pending = read().catch(e => e); await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ code: "timeout" }); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(reads)("%s retains the actual origin error and makes no fallback request", async (_name, read) => {
    const fetch = vi.fn(async (_url: string) => Response.json({ error: "remote_read_failed", message: "Origin unavailable" }, { status: 502 })); vi.stubGlobal("fetch", fetch);
    await expect(read()).rejects.toMatchObject({ code: "http", status: 502, serverCode: "remote_read_failed" }); expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toContain("host=remote%2Fexact");
  });
  it.each([{}, null, [null], [{ rigId: "", name: "bad" }]])("ps rejects a malformed successful DTO (%s)", async value => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value))); await expect(readPsEntries("local")).rejects.toMatchObject({ code: "invalid_contract" });
  });
  it.each([{}, null, [null], [{ rigId: "rig/exact", logicalId: "" }]])("inventory rejects a malformed successful DTO (%s)", async value => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(value))); await expect(readNodeInventory("rig/exact", "local")).rejects.toMatchObject({ code: "invalid_contract" });
  });
  it("retains original additive facts, nullable unconfigured bindings and unknown evidence", async () => {
    const inventory = [{ rigId: "rig/exact", rigName: "R", logicalId: "seat", podId: null, canonicalSessionName: null,
      nodeKind: "agent", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "none",
      tmuxAttachCommand: null, resumeCommand: null, latestError: null, contextUsage: null,
      agentActivity: { state: "unknown", reason: "no capture", evidenceSource: "none", sampledAt: "now", eventAt: null },
      identityVerdict: null, currentQitems: [], futureFact: { originPath: "/private/origin-only" } }];
    const processes = [{ rigId: "rig/exact", name: "R", nodeCount: 1, runningCount: 0, status: "stopped",
      uptime: null, latestSnapshot: null, rigName: "R", attentionCount: 0, futureFact: ["origin"] }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => inventory })
      .mockResolvedValueOnce({ ok: true, json: async () => processes }));
    expect(await readNodeInventory("rig/exact", "remote/exact")).toBe(inventory);
    expect(await readPsEntries("remote/exact")).toBe(processes);
  });
  it("refuses missing identities without fetching or substituting the connected host", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(readNodeInventory(null, "local")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readNodeInventory(" ", "local")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readNodeInventory("rig", "")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readPsEntries(" ")).rejects.toMatchObject({ code: "invalid_request" }); expect(fetch).not.toHaveBeenCalled();
  });
});
