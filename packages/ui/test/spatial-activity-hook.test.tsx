// useSpatialActivity — driven through the REAL shared topology event hub with
// a controllable EventSource, so hub cache replay, fresh-stream history
// replay, reconnect and teardown behave as in production.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSpatialActivity } from "../src/hooks/useSpatialActivity.js";
import {
  MAX_SPATIAL_TRAFFIC_PULSES,
  SPATIAL_TRAFFIC_FRESH_MS,
  SPATIAL_TRAFFIC_REMOTE_REASON,
  SPATIAL_TRAFFIC_SOURCE_MISMATCH_REASON,
} from "../src/lib/spatial-activity.js";
import { buildSpatialModel, parseSpatialRig, spatialKey, type SpatialModel } from "../src/lib/spatial-topology.js";
import { __test_internals as hubInternals } from "../src/lib/topology-events.js";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

type Listener = (event: { data?: unknown }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() { this.closed = true; }
  fire(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function stream(): FakeEventSource {
  const open = FakeEventSource.instances.filter((s) => !s.closed);
  expect(open).toHaveLength(1);
  return open[0]!;
}

function sqlite(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function queued(seq: number, from: string, to: string, at = Date.now(), extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "queue.created", seq, createdAt: sqlite(at), qitemId: `q-${seq}`, sourceSession: from, destinationSession: to, priority: "routine", tier: null, summary: null, ...extra });
}

function deliver(data: string) {
  act(() => { stream().fire("message", data); });
}

function connect() {
  act(() => { stream().fire("open"); });
}

/** Open at NOW, then move into the next whole second: whole-second stamps
 *  only prove "after the baseline" when strictly greater than it. */
const LIVE_AT = NOW + 1_000;
function connectLive() {
  connect();
  vi.setSystemTime(NOW + 1_500);
}

function agentNode(id: string, session: string) {
  return { id, type: "rigNode", data: { logicalId: id, runtime: "codex", status: "running", canonicalSessionName: session } };
}

function makeModel(host = "local", extraSessions: string[] = []): SpatialModel {
  const nodes = [agentNode("n1", "lead@acme"), agentNode("n2", "builder@acme"), ...extraSessions.map((s, i) => agentNode(`x${i}`, s))];
  return buildSpatialModel(host, [parseSpatialRig(host, { rigId: "rig_a", rigName: "acme", graph: { nodes, edges: [] } })]);
}

const LEAD = spatialKey("local", "rig_a", "agent", "n1");
const BUILDER = spatialKey("local", "rig_a", "agent", "n2");

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  FakeEventSource.instances = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSpatialActivity — live projection", () => {
  it("pulses a fresh live queue event in its recorded direction using canonical time", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    expect(result.current).toMatchObject({ connected: true, reconnecting: false, unavailableReason: null });
    // Arrives at :01.500, stamped :01 by the daemon: canonical time wins.
    deliver(queued(41, "lead@acme", "builder@acme", LIVE_AT));
    expect(result.current.pulses).toHaveLength(1);
    expect(result.current.pulses[0]).toMatchObject({ sourceKey: LEAD, targetKey: BUILDER, type: "queue.created", occurredAt: LIVE_AT, qitemId: "q-41" });
    expect(result.current.pulses[0]!.label).toMatch(/not a read receipt/);
    expect(result.current.records).toEqual(result.current.pulses);
  });

  it("orients a fallback reroute from the original destination to the fallback seat", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(JSON.stringify({ type: "qitem.fallback_routed", seq: 5, createdAt: sqlite(LIVE_AT), qitemId: "q-5", originalDestination: "builder@acme", rerouteDestination: "lead@acme", reason: "unreachable" }));
    expect(result.current.pulses[0]).toMatchObject({ sourceKey: BUILDER, targetKey: LEAD });
  });

  it("retires a pulse with one bounded timer and leaves no timer while idle", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    expect(vi.getTimerCount()).toBe(0);
    deliver(queued(1, "lead@acme", "builder@acme", LIVE_AT));
    expect(result.current.pulses).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(LIVE_AT + SPATIAL_TRAFFIC_FRESH_MS - Date.now() - 10); });
    expect(result.current.pulses).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.pulses).toEqual([]);
    expect(result.current.records).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates a repeated source+seq", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(queued(9, "lead@acme", "builder@acme"));
    deliver(queued(9, "lead@acme", "builder@acme"));
    expect(result.current.records).toHaveLength(1);
  });

  it("bounds concurrent pulses", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => `w${i}@acme`);
    const model = makeModel("local", sessions);
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    sessions.forEach((s, i) => deliver(queued(i + 1, "lead@acme", s)));
    expect(result.current.records).toHaveLength(10);
    expect(result.current.pulses).toHaveLength(MAX_SPATIAL_TRAFFIC_PULSES);
  });

  it("rejects malformed traffic and counts only honestly unplaced endpoints", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(queued(1, "lead@acme", "builder@acme", NOW, { createdAt: null }));
    deliver(queued(2, "lead@acme", "builder@acme", NOW, { seq: "2" }));
    deliver(queued(3, "lead@acme", "", NOW));
    deliver(JSON.stringify({ type: "chat.message", seq: 4, createdAt: sqlite(NOW), sender: "lead@acme", body: "hi" }));
    deliver(queued(5, "lead@acme", "operator@human"));
    deliver(queued(6, "other@rig", "else@rig"));
    deliver("not json");
    expect(result.current.records).toEqual([]);
    expect(result.current.pulses).toEqual([]);
    expect(result.current.unplacedCount).toBe(1);
  });
});

describe("useSpatialActivity — replay is history", () => {
  it("never pulses history replayed by a fresh stream, even if recent by canonical time", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connect();
    // Fresh-connection replay: stamped before this connection's baseline.
    deliver(queued(1, "lead@acme", "builder@acme", NOW - 60_000));
    deliver(queued(2, "builder@acme", "lead@acme", NOW - 3_000));
    act(() => { vi.advanceTimersByTime(150); });
    expect(result.current.records.map((r) => r.id)).toHaveLength(2);
    expect(result.current.pulses).toEqual([]);
  });

  // Independent review P2: whole-second stamps within a second before (or
  // equal to) the open baseline are replay-indistinguishable, never live.
  it("never pulses a row persisted within the same second before a cold connect", () => {
    vi.setSystemTime(NOW + 600);
    const { result } = renderHook(() => useSpatialActivity(makeModel(), "local", false));
    connect();
    deliver(queued(70, "lead@acme", "builder@acme", NOW));
    act(() => { vi.advanceTimersByTime(101); });
    expect(result.current.records).toHaveLength(1);
    expect(result.current.pulses).toEqual([]);
  });

  it("treats a stamp exactly equal to the open baseline as history", () => {
    const { result } = renderHook(() => useSpatialActivity(makeModel(), "local", false));
    connect(); // baseline is exactly NOW (.000)
    deliver(queued(74, "lead@acme", "builder@acme", NOW));
    act(() => { vi.advanceTimersByTime(101); });
    expect(result.current.records).toHaveLength(1);
    expect(result.current.pulses).toEqual([]);
  });

  it("does not re-pulse a live row replayed by a fresh stream after a rapid last-subscriber remount", () => {
    const first = renderHook(() => useSpatialActivity(makeModel(), "local", false));
    connectLive();
    deliver(queued(71, "lead@acme", "builder@acme", LIVE_AT));
    expect(first.result.current.pulses).toHaveLength(1);
    first.unmount();
    // The last subscriber left: the hub closed its stream and dropped its cache.
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    vi.setSystemTime(LIVE_AT + 600);
    const reopened = renderHook(() => useSpatialActivity(makeModel(), "local", false));
    connect();
    // A new EventSource starts at Last-Event-ID 0, so the daemon replays it.
    deliver(queued(71, "lead@acme", "builder@acme", LIVE_AT));
    act(() => { vi.advanceTimersByTime(101); });
    expect(reopened.result.current.records).toHaveLength(1);
    expect(reopened.result.current.pulses).toEqual([]);
  });

  it("keeps a row written during a subsecond outage as history after reopen", () => {
    const { result } = renderHook(() => useSpatialActivity(makeModel(), "local", false));
    connect();
    vi.setSystemTime(NOW + 100);
    act(() => { stream().fire("error"); });
    vi.setSystemTime(NOW + 400);
    connect();
    // Written at :00.200 during the outage; SQLite stores :00.
    deliver(queued(72, "lead@acme", "builder@acme", NOW));
    act(() => { vi.advanceTimersByTime(101); });
    expect(result.current.records).toHaveLength(1);
    expect(result.current.pulses).toEqual([]);
  });

  it("bounds a live burst and refuses an evicted row replayed with a fresh stamp", () => {
    const { result } = renderHook(() => useSpatialActivity(makeModel(), "local", false));
    connectLive();
    for (let seq = 1; seq <= 500; seq++) deliver(queued(seq, "lead@acme", "builder@acme", LIVE_AT));
    expect(result.current.records).toHaveLength(50);
    expect(result.current.records[0]!.id).toBe(JSON.stringify(["local", 500]));
    expect(result.current.records[49]!.id).toBe(JSON.stringify(["local", 451]));
    expect(result.current.pulses).toHaveLength(1);
    const pulses = result.current.pulses;
    deliver(queued(1, "lead@acme", "builder@acme", LIVE_AT));
    expect(result.current.records).toHaveLength(50);
    expect(result.current.pulses).toBe(pulses);
    act(() => { vi.advanceTimersByTime(SPATIAL_TRAFFIC_FRESH_MS + 2); });
    expect(result.current.pulses).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not re-animate hub-cached traffic when another view subscribes or the dock reopens", () => {
    const model = makeModel();
    const first = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(queued(7, "lead@acme", "builder@acme", LIVE_AT));
    expect(first.result.current.pulses).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(500); });
    // A second subscriber receives the hub's synchronous cache replay.
    const second = renderHook(() => useSpatialActivity(model, "local", false));
    expect(second.result.current.records).toHaveLength(1);
    expect(second.result.current.pulses).toEqual([]);

    // Reopen: unmount and remount while the hub stays alive.
    second.unmount();
    const reopened = renderHook(() => useSpatialActivity(model, "local", false));
    expect(reopened.result.current.records).toHaveLength(1);
    expect(reopened.result.current.pulses).toEqual([]);
    // The original live observer still shows its own fresh pulse.
    expect(first.result.current.pulses).toHaveLength(1);
  });

  it("cannot upgrade a replayed seq to live when it is delivered again", () => {
    const model = makeModel();
    const first = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(queued(3, "lead@acme", "builder@acme", LIVE_AT));
    const late = renderHook(() => useSpatialActivity(model, "local", false));
    deliver(queued(3, "lead@acme", "builder@acme", LIVE_AT));
    expect(late.result.current.records).toHaveLength(1);
    expect(late.result.current.pulses).toEqual([]);
    expect(first.result.current.records).toHaveLength(1);
  });

  it("does not re-pulse on a cached model refresh after expiry", () => {
    let model = makeModel();
    const { result, rerender } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(queued(1, "lead@acme", "builder@acme", LIVE_AT));
    act(() => { vi.advanceTimersByTime(SPATIAL_TRAFFIC_FRESH_MS + 5); });
    expect(result.current.pulses).toEqual([]);
    model = makeModel();
    rerender();
    expect(result.current.pulses).toEqual([]);
    expect(result.current.records).toHaveLength(1);
  });

  it("keeps pulse identity stable across an unrelated model refresh", () => {
    let model = makeModel();
    const { result, rerender } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(queued(1, "lead@acme", "builder@acme", LIVE_AT));
    const pulses = result.current.pulses;
    model = makeModel();
    rerender();
    expect(result.current.pulses).toBe(pulses);
  });
});

describe("useSpatialActivity — suppression and connection", () => {
  it("disables pulses under reduced motion but keeps readable records", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", true));
    connectLive();
    deliver(queued(1, "lead@acme", "builder@acme", LIVE_AT));
    expect(result.current.records).toHaveLength(1);
    expect(result.current.pulses).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disables pulses while the document is hidden and does not revive expired ones on return", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(queued(1, "lead@acme", "builder@acme", LIVE_AT));
    act(() => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.pulses).toEqual([]);
    act(() => { vi.advanceTimersByTime(SPATIAL_TRAFFIC_FRESH_MS + 1); });
    act(() => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.pulses).toEqual([]);
    expect(result.current.records).toHaveLength(1);
  });

  it("pauses pulses while reconnecting and treats events missed during the outage as history", () => {
    const model = makeModel();
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    connectLive();
    deliver(queued(1, "lead@acme", "builder@acme", LIVE_AT));
    act(() => { stream().fire("error"); });
    expect(result.current).toMatchObject({ connected: false, reconnecting: true });
    expect(result.current.pulses).toEqual([]);
    expect(result.current.records).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(4_000); });
    connect(); // baseline :05.500
    // Stamped during the outage, delivered on resume: history, not live.
    deliver(queued(2, "builder@acme", "lead@acme", NOW + 2_000));
    // Stamped in the baseline's own second: indistinguishable from replay.
    deliver(queued(3, "builder@acme", "lead@acme", NOW + 5_000));
    act(() => { vi.advanceTimersByTime(150); });
    expect(result.current.records).toHaveLength(3);
    // Seq 1 was observed live before the outage and may finish its window;
    // the outage row and the baseline-second row never pulse.
    const replayed = [JSON.stringify(["local", 2]), JSON.stringify(["local", 3])];
    expect(result.current.pulses.some((p) => replayed.includes(p.id))).toBe(false);
    // A genuine event in a later second is live again.
    vi.setSystemTime(NOW + 6_200);
    deliver(queued(4, "lead@acme", "builder@acme", NOW + 6_000));
    expect(result.current.pulses.map((p) => p.id)).toEqual([JSON.stringify(["local", 4])]);
  });
});

describe("useSpatialActivity — source scope", () => {
  it("never subscribes for a registered remote source and says why", () => {
    const model = makeModel("remote-1");
    const { result } = renderHook(() => useSpatialActivity(model, "remote-1", false));
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current).toEqual({ records: [], pulses: [], connected: false, reconnecting: false, unavailableReason: SPATIAL_TRAFFIC_REMOTE_REASON, unplacedCount: 0 });
  });

  it("clears local observations and releases the stream on a switch to a remote source", () => {
    let host = "local";
    let model = makeModel();
    const { result, rerender } = renderHook(() => useSpatialActivity(model, host, false));
    connectLive();
    deliver(queued(1, "lead@acme", "builder@acme", LIVE_AT));
    expect(result.current.records).toHaveLength(1);

    host = "remote-1";
    model = makeModel("remote-1");
    rerender();
    expect(result.current.records).toEqual([]);
    expect(result.current.pulses).toEqual([]);
    expect(result.current.unavailableReason).toBe(SPATIAL_TRAFFIC_REMOTE_REASON);
    expect(FakeEventSource.instances.every((s) => s.closed)).toBe(true);
    expect(hubInternals.topologyEventHub.snapshot()).toEqual({ connected: false, reconnecting: false });

    // Returning to local starts clean: no carried-over observations.
    host = "local";
    model = makeModel();
    rerender();
    expect(result.current.records).toEqual([]);
  });

  it("projects nothing while the loaded model belongs to another source", () => {
    const model = makeModel("remote-1");
    const { result } = renderHook(() => useSpatialActivity(model, "local", false));
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current.unavailableReason).toBe(SPATIAL_TRAFFIC_SOURCE_MISMATCH_REASON);
  });
});
