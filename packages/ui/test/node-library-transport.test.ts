import { afterEach, describe, expect, it, vi } from "vitest";
import { readLibraryEntries, readLibraryReview, readNodeDetail } from "../src/lib/node-library-reads.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("node/library total read deadline and errors", () => {
  it("counts slow headers against the body deadline, including an unavailable HTTP body", async () => {
    vi.useFakeTimers(); let resolve!: (r: Response) => void; const cancel = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = readLibraryEntries(undefined, "remote/exact").catch(e => e);
    await vi.advanceTimersByTimeAsync(4000);
    resolve({ ok: false, status: 502, json: () => new Promise(() => {}), body: { cancel } } as unknown as Response);
    await vi.advanceTimersByTimeAsync(1000); expect(await pending).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a pending body, removes its listener/timer and ignores its late value", async () => {
    vi.useFakeTimers(); let resolve!: (r: unknown) => void; const cancel = vi.fn(async () => {}); const caller = new AbortController(); const remove = vi.spyOn(caller.signal, "removeEventListener");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: () => new Promise(done => { resolve = done; }), body: { cancel } })));
    const pending = readLibraryEntries(undefined, "local", { signal: caller.signal }).catch(e => e);
    await Promise.resolve(); await Promise.resolve(); caller.abort(); expect(await pending).toMatchObject({ code: "cancelled" });
    resolve([]); await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
  it("disposes headers arriving after the timeout without decoding them", async () => {
    vi.useFakeTimers(); let resolve!: (r: Response) => void; const cancel = vi.fn(async () => {}), json = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = readLibraryEntries(undefined, "local").catch(e => e); await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ code: "timeout" });
    resolve({ body: { cancel }, json } as unknown as Response); await Promise.resolve(); await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled();
  });
  it("refuses absent entity IDs even when a disabled query is manually refetched", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(readNodeDetail(null, "seat", "local")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readNodeDetail("rig", null, "local")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readLibraryReview(null, "local")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readLibraryEntries(undefined, " ")).rejects.toMatchObject({ code: "invalid_request" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not start a request for an already cancelled signal", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const caller = new AbortController(); caller.abort();
    await expect(readLibraryEntries(undefined, "local", { signal: caller.signal })).rejects.toMatchObject({ code: "cancelled" }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [() => new Response("broken"), "invalid_json", undefined],
    [() => new Response("broken", { status: 503 }), "http", 503],
    [() => Response.json({ error: "remote_read_failed", message: "Origin unavailable" }, { status: 502 }), "http", 502],
    [() => Promise.reject(new Error("offline")), "network", undefined],
    [() => Response.json([{ id: "wrong-kind", kind: "agent" }]), "invalid_contract", undefined],
  ] as const)("distinguishes malformed, unavailable and network responses (%s)", async (response, code, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => response())); await expect(readLibraryEntries("rig", "remote/exact")).rejects.toMatchObject({ code, status });
  });
  it("retains workflow diagnostic empty versions, nullable paths and additive fields verbatim", async () => {
    const entry = { id: "workflow:error:/private/diagnostic.yaml", kind: "workflow", name: "diagnostic.yaml", version: "", sourceType: "user_file",
      sourcePath: "/private/diagnostic.yaml", relativePath: "/private/diagnostic.yaml", updatedAt: "2026-10-04", resolvedSourcePath: null,
      targetRig: null, status: "error", errorMessage: "Invalid YAML", futureFact: { exact: true } };
    vi.useFakeTimers(); const fetch = vi.fn(async (_url: string, _options?: RequestInit) => Response.json([entry])); vi.stubGlobal("fetch", fetch);
    expect(await readLibraryEntries("workflow", "remote/exact")).toEqual([entry]); expect(vi.getTimerCount()).toBe(0);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/specs/library?kind=workflow&host=remote%2Fexact"); expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json" });
  });
});
