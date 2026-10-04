import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_OPERATOR_INSTANCE, OperatorReadError, operatorRead } from "../src/lib/operator-read.js";

const decode = (v: unknown): v is { value: string } =>
  typeof v === "object" && v !== null && "value" in v && typeof v.value === "string";
const read = (signal?: AbortSignal) => operatorRead(LOCAL_OPERATOR_INSTANCE, "/api/example", decode, { signal });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("bounded operator GET", () => {
  it("returns validated facts with one read and caller-controlled cancellation", async () => {
    const fetch = vi.fn(async () => Response.json({ value: "served" })); vi.stubGlobal("fetch", fetch);
    await expect(read()).resolves.toEqual({ value: "served" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("never substitutes local data for unsupported remote scope", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(operatorRead({ kind: "remote-instance", hostId: "host-b" }, "/api/example", decode)).rejects.toMatchObject({ code: "unsupported_scope" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"])("bounds a hung %s even when fetch ignores abort", async (stage) => {
    vi.useFakeTimers();
    const stalled = new Promise<Response>(() => {});
    const body = { ok: true, status: 200, json: () => new Promise(() => {}), body: null } as unknown as Response;
    const fetch = vi.fn(() => stage === "headers" ? stalled : Promise.resolve(body)); vi.stubGlobal("fetch", fetch);
    const promise = read().catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000); expect(await promise).toMatchObject({ code: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels while headers hang and cleans its deadline/listener", async () => {
    vi.useFakeTimers(); const abort = new AbortController(); const remove = vi.spyOn(abort.signal, "removeEventListener");
    const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
    const promise = read(abort.signal).catch(error => error);
    abort.abort(); expect(await promise).toMatchObject({ code: "cancelled" });
    expect(fetch.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels while a response body hangs, including HTTP errors", async () => {
    vi.useFakeTimers(); const abort = new AbortController(); const cancel = vi.fn(async () => {});
    const fetch = vi.fn(async () => ({ ok: false, status: 503, json: () => new Promise(() => {}), body: { cancel } } as unknown as Response)); vi.stubGlobal("fetch", fetch);
    const promise = read(abort.signal).catch(error => error); await Promise.resolve(); await Promise.resolve(); abort.abort();
    expect(await promise).toMatchObject({ code: "cancelled" }); expect(cancel).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a late response body after the header deadline", async () => {
    vi.useFakeTimers(); let resolve!: (response: Response) => void; const cancel = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const promise = read().catch(error => error); await vi.advanceTimersByTimeAsync(5_000); expect(await promise).toMatchObject({ code: "timeout" });
    resolve({ body: { cancel } } as unknown as Response); await Promise.resolve(); await Promise.resolve(); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not start a read with a cancelled caller signal", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const abort = new AbortController(); abort.abort();
    await expect(read(abort.signal)).rejects.toMatchObject({ code: "cancelled" }); expect(fetch).not.toHaveBeenCalled();
  });

  it("cleans the deadline and caller listener after a successful body", async () => {
    vi.useFakeTimers(); const abort = new AbortController(); const remove = vi.spyOn(abort.signal, "removeEventListener");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ value: "served" })));
    await read(abort.signal); expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each([
    [() => Response.json({ error: "source_unavailable", message: "Source could not be read" }, { status: 503 }), "http", 503],
    [() => new Response("not JSON", { status: 401 }), "http", 401],
    [() => new Response("not JSON"), "invalid_json", undefined],
    [() => Response.json({ value: false }), "invalid_contract", undefined],
    [() => Promise.reject(new TypeError("offline")), "network", undefined],
  ] as const)("classifies response failures as %s / %s", async (response, code, status) => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal("fetch", fetch);
    const error = await read().catch(e => e);
    expect(error).toBeInstanceOf(OperatorReadError); expect(error).toMatchObject({ code, status }); expect(fetch).toHaveBeenCalledTimes(1);
    if (status === 503) expect(error).toMatchObject({ serverCode: "source_unavailable", message: expect.stringContaining("Source could not be read") });
  });
});
