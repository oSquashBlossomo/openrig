import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useGlobalEvents, operatorFamiliesForEvent } from "../src/hooks/useGlobalEvents.js";
import { useCanonicalAttention, useDeliveredHumanUpdates } from "../src/hooks/useCanonicalAttention.js";
import { useCanonicalHealth } from "../src/hooks/useCanonicalHealth.js";
import { LOCAL_OPERATOR_INSTANCE } from "../src/lib/operator-read.js";

const attentionKey = ["operator", "local-instance", "attention", "list", null];
const deliveriesKey = ["operator", "local-instance", "attention", "human-updates", 20];
const healthKey = ["operator", "local-instance", "health", "list", 200, null, null, null, null];
const at = "2026-10-04T03:00:00.000Z";
const attention = { scope: "instance", readAt: at, items: [], sources: [], detail: null, detailError: null };
const health = { schema: "openrig.health-list/v0alpha1", evaluatedAt: at, total: 0, limit: 200, truncated: false, records: [], coverage: [] };
const deliveries = { items: [], limit: 20, truncated: false };
interface Read { url: string; signal: AbortSignal; completed: boolean; body?: (value: unknown) => void }
let client: QueryClient;
let emit: (name: string, data?: string) => void;
let reads: Read[];

function setup(delay = 1_500, hungBody = false, seed = true) {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); reads = [];
  vi.stubGlobal("EventSource", class {
    listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    constructor() { emit = (name, data) => { for (const listener of this.listeners.get(name) ?? []) listener({ data }); }; }
    addEventListener(name: string, listener: (event: { data?: string }) => void) {
      this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]);
    }
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
    const read: Read = { url, signal: options.signal as AbortSignal, completed: false }; reads.push(read);
    const body = url.startsWith("/api/health") ? health : url.startsWith("/api/queue/") ? deliveries : { ...attention, readAt: new Date(Date.now()).toISOString() };
    if (hungBody) {
      const response = Response.json(body);
      response.json = () => new Promise(resolve => { read.body = value => { read.completed = true; resolve(value); }; });
      return Promise.resolve(response);
    }
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { read.completed = true; resolve(Response.json(body)); }, delay);
      read.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  if (seed) client.setQueryData(attentionKey, attention);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const events = renderHook(() => useGlobalEvents(), { wrapper });
  const reader = renderHook(() => useCanonicalAttention(LOCAL_OPERATOR_INSTANCE), { wrapper });
  return { wrapper, events, reader };
}
function event(type = "queue.created") { act(() => emit("message", JSON.stringify({ type, rigId: "rig-one" }))); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

afterEach(() => { cleanup(); client?.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("canonical operator SSE refresh scheduling", () => {
  it("finishes bounded reads and advances cached facts throughout sustained one-second activity windows", async () => {
    const { reader } = setup();
    for (let window = 0; window < 6; window++) { event(); await tick(1_000); }
    expect(reads.every(read => !read.signal.aborted)).toBe(true);
    expect(reads.filter(read => read.completed).length).toBeGreaterThanOrEqual(3);
    expect(reader.result.current.data?.readAt).not.toBe(at);
    await tick(4_000);
    expect(reads.every(read => read.completed)).toBe(true);
    expect(reader.result.current.isFetching).toBe(false);
  });

  it("follows up an initial uncached read when an event arrives before its answer", async () => {
    const { reader } = setup(1_500, false, false);
    expect(reader.result.current.data).toBeUndefined();
    expect(reads).toHaveLength(1);
    event(); await tick(1_000); await tick(501);
    expect(reads).toHaveLength(2);
    expect(reads[0]!.completed).toBe(true);
    expect(reads[0]!.signal.aborted).toBe(false);
    await tick(1_501);
    expect(reader.result.current.data?.readAt).not.toBe(at);
    expect(reader.result.current.error).toBeNull();
  });

  it("coalesces family/all reconnect overlap into one follow-up per active actual query", async () => {
    const { wrapper } = setup(2_500);
    client.setQueryData(deliveriesKey, deliveries); client.setQueryData(healthKey, health);
    renderHook(() => useDeliveredHumanUpdates(LOCAL_OPERATOR_INSTANCE), { wrapper });
    renderHook(() => useCanonicalHealth(LOCAL_OPERATOR_INSTANCE), { wrapper });
    const inactiveKey = ["operator", "local-instance", "gateway", "connections"];
    client.setQueryData(inactiveKey, { cached: true });
    act(() => emit("open"));
    for (let burst = 0; burst < 50; burst++) event();
    await tick(1_000); expect(reads).toHaveLength(3);
    for (let burst = 0; burst < 50; burst++) { event("queue.delivered"); event("node.startup_failed"); }
    act(() => { emit("error"); emit("open"); });
    await tick(1_000);
    for (let burst = 0; burst < 50; burst++) event("workflow.completed");
    await tick(1_000);
    expect(reads).toHaveLength(3); expect(reads.every(read => !read.signal.aborted)).toBe(true);
    await tick(501); expect(reads).toHaveLength(6);
    expect(client.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
    await tick(3_000);
    expect(reads).toHaveLength(6); expect(reads.every(read => read.completed && !read.signal.aborted)).toBe(true);
    expect(reads.filter(read => read.url === "/api/attention")).toHaveLength(2);
    expect(reads.filter(read => read.url.startsWith("/api/health"))).toHaveLength(2);
    expect(reads.filter(read => read.url.startsWith("/api/queue/human-updates"))).toHaveLength(2);
  });

  it("deduplicates multiple owners while refreshing each exact detail ID independently", async () => {
    const { wrapper } = setup(2_500);
    for (const id of ["queue:one", "queue:two"]) {
      client.setQueryData(["operator", "local-instance", "attention", "detail", id], attention);
      renderHook(() => useCanonicalAttention(LOCAL_OPERATOR_INSTANCE, id), { wrapper });
    }
    renderHook(() => useCanonicalAttention(LOCAL_OPERATOR_INSTANCE, "queue:one"), { wrapper });
    const remoteKey = ["operator", "remote-instance", "other-host", "attention", "list", null];
    client.setQueryData(remoteKey, attention);
    renderHook(() => useCanonicalAttention({ kind: "remote-instance", hostId: "other-host" }), { wrapper });
    act(() => emit("open")); event(); await tick(1_000);
    act(() => { emit("error"); emit("open"); });
    event(); await tick(1_000); await tick(1_501);
    expect(reads).toHaveLength(6);
    await tick(3_000);
    for (const url of ["/api/attention", "/api/attention?item=queue%3Aone", "/api/attention?item=queue%3Atwo"]) {
      expect(reads.filter(read => read.url === url)).toHaveLength(2);
    }
    expect(reads.every(read => read.completed && !read.signal.aborted)).toBe(true);
    expect(client.getQueryState(remoteKey)?.isInvalidated).toBe(false);
  });

  it("keeps the five-second body deadline during activity and allows the event-driven follow-up to recover", async () => {
    const { reader } = setup(1_500, true);
    event(); await tick(1_000);
    for (let window = 0; window < 5; window++) { event(); await tick(1_000); }
    // React Query delivers its observer notification on the next timer turn.
    await tick(1);
    expect(reader.result.current.error?.code).toBe("timeout");
    expect(reader.result.current.data?.readAt).toBe(at);
    expect(reads[0]!.signal.aborted).toBe(true); expect(reads).toHaveLength(2);
    await act(async () => { reads[1]!.body!({ ...attention, readAt: "2026-10-04T03:00:06.000Z" }); });
    await tick(1);
    expect(reader.result.current.error).toBeNull();
    expect(reader.result.current.data?.readAt).toBe("2026-10-04T03:00:06.000Z");
  });

  it("drops pending follow-ups on event-owner unmount without cancelling a surviving reader", async () => {
    const { events, reader } = setup();
    event(); await tick(1_000); event(); await tick(1_000); events.unmount(); await tick(2_000);
    expect(reads).toHaveLength(1); expect(reads[0]!.completed).toBe(true); expect(reads[0]!.signal.aborted).toBe(false);
    expect(reader.result.current.data?.readAt).not.toBe(at);
  });

  it("cleans up a follow-up queued after read settlement", async () => {
    const { events } = setup(1_500, true);
    event(); await tick(1_000); event(); await tick(1_000);
    await act(async () => { reads[0]!.body!({ ...attention, readAt: "2026-10-04T03:00:02.000Z" }); });
    expect(client.getQueryState(attentionKey)?.fetchStatus).toBe("idle");
    events.unmount(); await tick(1_000);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.signal.aborted).toBe(false);
    expect(client.getQueryData(attentionKey)).toMatchObject({ readAt: "2026-10-04T03:00:02.000Z" });
  });

  it("cleans up a scheduled window before it starts", async () => {
    const { events } = setup(); event(); events.unmount(); await tick(2_000); expect(reads).toHaveLength(0);
  });

  it("does not follow up after the affected query loses its active reader", async () => {
    const { reader } = setup(2_500);
    event(); await tick(1_000); event(); await tick(1_000); reader.unmount(); await tick(4_000);
    expect(reads).toHaveLength(1);
  });

  it("refreshes both Health and its dependent canonical Attention on a startup event", async () => {
    const { wrapper } = setup(); client.setQueryData(healthKey, health);
    renderHook(() => useCanonicalHealth(LOCAL_OPERATOR_INSTANCE), { wrapper });
    event("node.startup_failed"); await tick(1_000);
    expect(reads.map(read => read.url).sort()).toEqual(["/api/attention", "/api/health?limit=200"].sort());
  });

  it.each(["node.startup_ready", "session.status_changed", "rig.stopped", "pod.deleted", "restore.completed", "bootstrap.partial"])("covers Health-derived Attention for %s", type => {
    expect(operatorFamiliesForEvent(type)).toEqual(["attention", "health"]);
  });
});
