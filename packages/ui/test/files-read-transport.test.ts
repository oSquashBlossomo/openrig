import { afterEach, describe, expect, it, vi } from "vitest";
import { readFilesRoots, readFilesFile, readFilesList, FilesReadError } from "../src/lib/files-read.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("Files bounded read transport and compatibility", () => {
  it("includes slow headers in the total roots 503 body deadline", async () => {
    vi.useFakeTimers(); let resolve!: (r: Response) => void; const cancel = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = readFilesRoots("local").catch(e => e); await vi.advanceTimersByTimeAsync(4000);
    resolve({ status: 503, ok: false, json: () => new Promise(() => {}), body: { cancel } } as unknown as Response);
    await vi.advanceTimersByTimeAsync(1000); expect(await pending).toMatchObject({ code: "timeout" }); expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels and disposes late headers without reading JSON", async () => {
    vi.useFakeTimers(); const caller = new AbortController(); let resolve!: (r: Response) => void; const cancel = vi.fn(async () => {}), json = vi.fn();
    const remove = vi.spyOn(caller.signal, "removeEventListener"); vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = readFilesRoots("local", { signal: caller.signal }).catch(e => e); caller.abort(); expect(await pending).toMatchObject({ code: "cancelled" });
    resolve({ body: { cancel }, json } as unknown as Response); await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce(); expect(json).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a pending body and ignores its eventual bytes", async () => {
    vi.useFakeTimers(); const caller = new AbortController(); let resolve!: (r: unknown) => void; const cancel = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: () => new Promise(done => { resolve = done; }), body: { cancel } })));
    const pending = readFilesRoots("local", { signal: caller.signal }).catch(e => e); await Promise.resolve(); await Promise.resolve(); caller.abort();
    expect(await pending).toMatchObject({ code: "cancelled" }); resolve({ roots: [{ name: "local", path: "/private" }] }); await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([undefined, "remote/exact"])("blocks direct unknown/remote scope %s", async host => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(readFilesRoots(host)).rejects.toMatchObject({ code: host ? "unsupported_scope" : "invalid_request" });
    await expect(readFilesList(host, "ws", "")).rejects.toMatchObject({ code: host ? "unsupported_scope" : "invalid_request" });
    await expect(readFilesFile(host, "ws", "a.md")).rejects.toMatchObject({ code: host ? "unsupported_scope" : "invalid_request" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks caller-disabled reads and absent targets before fetch", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(readFilesRoots("local", { enabled: false })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readFilesList("local", "ws", "", { enabled: false })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readFilesFile("local", "ws", "a.md", { enabled: false })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readFilesList("local", null, "")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(readFilesFile("local", "ws", null)).rejects.toMatchObject({ code: "invalid_request" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a pre-cancelled request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const caller = new AbortController(); caller.abort();
    await expect(readFilesRoots("local", { signal: caller.signal })).rejects.toMatchObject({ code: "cancelled" }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[404, "absent"], [400, "bad_path"], [500, "read_error"], [503, "read_error"]] as const)("preserves FilesReadError %s without waiting for an error body", async (status, code) => {
    const cancel = vi.fn(async () => {}), json = vi.fn(() => new Promise(() => {})); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, body: { cancel }, json })));
    const error = await readFilesFile("local", "ws", "a.md").catch(e => e);
    expect(error).toBeInstanceOf(FilesReadError); expect(error).toMatchObject({ status, code, message: `HTTP ${status}`, name: "Error" }); expect(json).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  });
  it("retains roots' 503 setup-unavailable shape/hint and invalid-body fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "files_routes_unavailable", hint: "Set allowlist" }, { status: 503 })));
    expect(await readFilesRoots("local")).toEqual({ unavailable: true, error: "files_routes_unavailable", hint: "Set allowlist" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid", { status: 503 })));
    expect(await readFilesRoots("local")).toEqual({ unavailable: true, error: "files_routes_unavailable", hint: undefined });
  });
  it.each([[() => new Response("broken"), "invalid_json"], [() => Response.json({ roots: "bad" }), "invalid_contract"], [() => Promise.reject(new Error("offline")), "network"]] as const)("distinguishes transport/JSON/shape errors (%s)", async (response, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => response())); await expect(readFilesRoots("local")).rejects.toMatchObject({ code });
  });
});
