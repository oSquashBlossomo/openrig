import { afterEach, describe, expect, it, vi } from "vitest";
import { readSeatWork, readSeatWorkWindow } from "../src/lib/seat-work-reads.js";
import { LOCAL_OPERATOR_INSTANCE as local, OperatorReadError } from "../src/lib/operator-read.js";
const target = { rigId: "rig/%2F", logicalId: "pod.owner|exact", canonicalSessionName: "raw%2F/seat+&name" };
const qitem = { qitemId: "qitem-exact", sourceSession: "source@fixture", destinationSession: target.canonicalSessionName,
  state: "in-progress", priority: "routine", tsCreated: "2026-10-05T00:00:00Z", tsUpdated: "2026-10-05T01:00:00Z",
  body: "Exact work", summary: null, blockedOn: null, handedOffTo: null, claimedAt: null, additiveFact: { original: true } };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("reads three independent exact address/state/limit windows, preserving all rows and zero/empty facts", async () => {
  const pending = { ...qitem, state: "pending", claimedAt: "2026-10-05T00:00:01Z" };
  const rows = { current: [qitem, { ...qitem, qitemId: "blocked", state: "blocked", blockedOn: "not-automatically-a-human" }], pending: [pending], finished: [] };
  const fetch = vi.fn(async (route: string) => {
    const url = new URL(route, "http://fixture");
    expect(url.searchParams.get("destinationSession")).toBe(target.canonicalSessionName);
    expect(url.searchParams.has("host")).toBe(false);
    const state = url.searchParams.get("state");
    const key = state === "pending" ? "pending" : state === "done,handed-off" ? "finished" : "current";
    expect(url.searchParams.get("limit")).toBe({ current: "100", pending: "50", finished: "20" }[key]);
    return { ok: true, json: async () => rows[key] };
  }); vi.stubGlobal("fetch", fetch);
  const result = await readSeatWork(local, target);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(result.current.state).toBe("available");
  if (result.current.state === "available") {
    expect(result.current.data.rows).toBe(rows.current); expect(result.current.data.rows[0]).toBe(qitem);
    expect(result.current.data).toMatchObject({ target, limit: 100, totalCount: null, possiblyBounded: false, addressCoverage: "exact-session", sourceOrder: "created-desc" });
    expect(result.current.data.readAt).toBeGreaterThan(0);
  }
  expect(result.pending.state === "available" && result.pending.data.rows).toBe(rows.pending);
  expect(result.finished.state === "available" && result.finished.data.rows).toEqual([]);
});
it("keeps full-page bounds and never substitutes a served seat total or global finished total", async () => {
  const rows = Array.from({ length: 20 }, (_, n) => ({ ...qitem, qitemId: `q${n}`, state: n % 2 ? "done" : "handed-off" }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  const read = await readSeatWorkWindow(local, target, "finished");
  expect(read.rows).toBe(rows); expect(read.totalCount).toBeNull(); expect(read.possiblyBounded).toBe(true);
});
it("preserves healthy siblings and named HTTP failure instead of false empty", async () => {
  vi.stubGlobal("fetch", vi.fn(async (route: string) => route.includes("state=pending")
    ? Response.json({ code: "private_unavailable", error: "Pending read unavailable" }, { status: 503 }) : Response.json([])));
  const reads = await readSeatWork(local, target);
  expect(reads.current.state).toBe("available"); expect(reads.finished.state).toBe("available");
  expect(reads.pending).toMatchObject({ state: "unavailable", error: { code: "http", status: 503, serverCode: "private_unavailable" } });
  expect(reads.pending).not.toHaveProperty("data");
});
it.each([
  { kind: "remote-instance", hostId: "remote/exact" } as const,
])("refuses remote origin even with a valid target and zero local GET", async scope => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(readSeatWork(scope, target)).rejects.toMatchObject({ code: "unsupported_scope" }); expect(fetch).not.toHaveBeenCalled();
});
it.each([null, { ...target, rigId: "" }, { ...target, logicalId: " " }, { ...target, canonicalSessionName: "" }])("refuses unknown/missing target %j before GET", async bad => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(readSeatWork(local, bad)).rejects.toMatchObject({ code: "invalid_request" }); expect(fetch).not.toHaveBeenCalled();
});
it.each([
  [{ ...qitem, destinationSession: "decode-equivalent-sibling" }], [{ ...qitem, state: "pending" }], [{ ...qitem, priority: "invalid" }], [null], {},
  Array.from({ length: 101 }, () => qitem),
])("rejects malformed/foreign/state-mismatched/over-limit rows %j", async rows => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
  await expect(readSeatWorkWindow(local, target, "current")).rejects.toMatchObject({ code: "invalid_contract" });
});
it.each(["headers", "body"])("owns a total5s deadline despite ignored abort at %s", async phase => {
  vi.useFakeTimers(); const cancel = vi.fn(async () => {});
  vi.stubGlobal("fetch", vi.fn(() => phase === "headers" ? new Promise<Response>(() => {})
    : Promise.resolve({ ok: true, body: { cancel }, json: () => new Promise<unknown>(() => {}) })));
  const read = readSeatWorkWindow(local, target, "pending").catch(error => error);
  await vi.advanceTimersByTimeAsync(5000); const error = await read;
  expect(error).toBeInstanceOf(OperatorReadError); expect(error.code).toBe("timeout"); expect(vi.getTimerCount()).toBe(0);
  if (phase === "body") expect(cancel).toHaveBeenCalledOnce();
});
it("caller cancellation stays cancellation with cleanup and late body cannot become success", async () => {
  const controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
  let resolve!: (rows: unknown) => void; const cancel = vi.fn(async () => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: { cancel }, json: () => new Promise(done => { resolve = done; }) })));
  const read = readSeatWorkWindow(local, target, "current", { signal: controller.signal }).catch(error => error);
  await Promise.resolve(); await Promise.resolve(); controller.abort(); const error = await read;
  expect(error.code).toBe("cancelled"); resolve([qitem]); await Promise.resolve(); expect(await read).toBe(error);
  expect(cancel).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("aggregate keeps cancellation distinct from unavailable or empty windows", async () => {
  const caller = new AbortController(); const signals: AbortSignal[] = [];
  const fetch = vi.fn((_route: string, init: RequestInit) => { signals.push(init.signal!); return new Promise<Response>(() => {}); });
  vi.stubGlobal("fetch", fetch);
  const read = readSeatWork(local, target, { signal: caller.signal }).catch(error => error);
  expect(fetch).toHaveBeenCalledTimes(3); caller.abort();
  expect(await read).toMatchObject({ code: "cancelled" }); expect(signals.every(signal => signal.aborted)).toBe(true);
});
