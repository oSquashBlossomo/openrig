import { afterEach, describe, expect, it, vi } from "vitest";
import { readTerminalViews, readTerminalPreview } from "../src/lib/terminal-read.js";
const listing = { saved: [], rigs: [] };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("terminal read transport", () => {
  it("bounds headers and cancels a response arriving after timeout", async () => {
    vi.useFakeTimers(); let resolve!: (r: Response) => void; const cancel = vi.fn(async () => {}), json = vi.fn();
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const pending = readTerminalViews("local").catch(e => e);
    await vi.advanceTimersByTimeAsync(5000); expect(await pending).toMatchObject({ code: "timeout" });
    resolve({ body: { cancel }, json } as unknown as Response); await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("includes slow headers in the total body deadline", async () => {
    vi.useFakeTimers(); let resolve!: (r: Response) => void; const cancel = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = readTerminalViews("local").catch(e => e);
    await vi.advanceTimersByTimeAsync(4000);
    resolve({ ok: true, json: () => new Promise(() => {}), body: { cancel } } as unknown as Response);
    await vi.advanceTimersByTimeAsync(1000); expect(await pending).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels while body is pending and cleans its deadline/listener", async () => {
    vi.useFakeTimers(); const caller = new AbortController(); const remove = vi.spyOn(caller.signal, "removeEventListener"), cancel = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}), body: { cancel } })));
    const pending = readTerminalViews("local", { signal: caller.signal }).catch(e => e);
    await Promise.resolve(); await Promise.resolve(); caller.abort();
    expect(await pending).toMatchObject({ code: "cancelled" }); expect(cancel).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not fetch for a pre-cancelled signal or blank view/provider/host", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const caller = new AbortController(); caller.abort();
    await expect(readTerminalViews("local", { signal: caller.signal })).rejects.toMatchObject({ code: "cancelled" });
    await expect(readTerminalPreview("local", "", "herdr")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readTerminalPreview("local", "saved:same", " ")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readTerminalViews(undefined)).rejects.toMatchObject({ code: "invalid_request" }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [() => new Response("broken"), "invalid_json", undefined],
    [() => new Response("broken", { status: 503 }), "http", 503],
    [() => Response.json({ error: "view_not_found" }, { status: 404 }), "http", 404],
    [() => Promise.reject(new Error("preview offline")), "network", undefined],
  ] as const)("preserves error classes and status (%s)", async (response, code, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await expect(readTerminalViews("local")).rejects.toMatchObject({ code, status });
  });
  it("cleans the successful read timer and preserves full served facts without auth invention", async () => {
    vi.useFakeTimers(); const fetch = vi.fn(async () => Response.json({ ...listing, extra: "kept" })); vi.stubGlobal("fetch", fetch);
    await expect(readTerminalViews("local")).resolves.toEqual({ ...listing, extra: "kept" });
    expect(vi.getTimerCount()).toBe(0); expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json" });
  });
});
