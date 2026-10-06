// Spatial activity — pure parsing, dedupe/retention, exact endpoint
// resolution and freshness. Payload shapes follow the daemon's flat
// PersistedEvent (event fields + seq + SQLite created_at as createdAt).

import { describe, it, expect } from "vitest";
import {
  MAX_SPATIAL_TRAFFIC_PULSES,
  MAX_SPATIAL_TRAFFIC_RECORDS,
  SPATIAL_TRAFFIC_FRESH_MS,
  SPATIAL_TRAFFIC_FUTURE_SKEW_MS,
  canonicalEventTime,
  isLiveDelivery,
  isSpatialTrafficFresh,
  nextSpatialTrafficExpiry,
  parseSpatialTrafficEvent,
  projectSpatialTraffic,
  retainSpatialTraffic,
  spatialTrafficId,
  type SpatialTrafficObservation,
} from "../src/lib/spatial-activity.js";
import { buildSpatialModel, parseSpatialRig, spatialKey } from "../src/lib/spatial-topology.js";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function sqlite(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function agentNode(id: string, logicalId: string, session: string | null) {
  return { id, type: "rigNode", data: { logicalId, runtime: "claude-code", status: "running", ...(session ? { canonicalSessionName: session } : {}) } };
}

function model(host = "local") {
  const acme = parseSpatialRig(host, {
    rigId: "rig_a", rigName: "acme",
    graph: { nodes: [agentNode("n1", "lead", "lead@acme"), agentNode("n2", "builder", "builder@acme"), agentNode("n3", "dup", "dup@shared")], edges: [] },
  });
  // Same graph node id "n1" in another rig, and a colliding canonical name.
  const beta = parseSpatialRig(host, {
    rigId: "rig_b", rigName: "beta",
    graph: { nodes: [agentNode("n1", "lead", "lead@beta"), agentNode("n9", "dup", "dup@shared")], edges: [] },
  });
  return buildSpatialModel(host, [acme, beta]);
}

const LEAD_A = spatialKey("local", "rig_a", "agent", "n1");
const BUILDER_A = spatialKey("local", "rig_a", "agent", "n2");
const LEAD_B = spatialKey("local", "rig_b", "agent", "n1");

function observation(seq: number, overrides: Partial<SpatialTrafficObservation> = {}): SpatialTrafficObservation {
  return {
    id: spatialTrafficId("local", seq), sourceHost: "local", seq, type: "queue.created",
    fromSession: "lead@acme", toSession: "builder@acme", occurredAt: NOW - 1_000, live: true, ...overrides,
  };
}

describe("parseSpatialTrafficEvent", () => {
  it("reads each type's own endpoint fields in their recorded direction", () => {
    const created = parseSpatialTrafficEvent("local", { type: "queue.created", seq: 7, createdAt: "2026-10-05 11:59:58", qitemId: "q-1", sourceSession: "lead@acme", destinationSession: "builder@acme", priority: "routine", tier: null, summary: null });
    const handed = parseSpatialTrafficEvent("local", { type: "queue.handed_off", seq: 8, createdAt: "2026-10-05 11:59:58", qitemId: "q-1", fromSession: "builder@acme", toSession: "lead@beta", closureReason: "handed_off_to", summary: null });
    const rerouted = parseSpatialTrafficEvent("local", { type: "qitem.fallback_routed", seq: 9, createdAt: "2026-10-05 11:59:58", qitemId: "q-2", originalDestination: "builder@acme", rerouteDestination: "lead@acme", reason: "unreachable" });
    expect(created).toMatchObject({ kind: "traffic", observation: { fromSession: "lead@acme", toSession: "builder@acme", qitemId: "q-1", occurredAt: NOW - 2_000 } });
    expect(handed).toMatchObject({ kind: "traffic", observation: { fromSession: "builder@acme", toSession: "lead@beta" } });
    // Fallback: original destination → reroute destination (not sender → receiver).
    expect(rerouted).toMatchObject({ kind: "traffic", observation: { fromSession: "builder@acme", toSession: "lead@acme", type: "qitem.fallback_routed" } });
  });

  it.each([
    ["chat.message", { type: "chat.message", seq: 1, createdAt: "2026-10-05 11:59:58", sender: "lead@acme" }],
    ["queue.updated", { type: "queue.updated", seq: 1, createdAt: "2026-10-05 11:59:58", actorSession: "lead@acme", closureTarget: "builder@acme" }],
    ["agent.activity", { type: "agent.activity", seq: 1, createdAt: "2026-10-05 11:59:58", nodeId: "n1" }],
    ["non-object", "queue.created"],
  ])("ignores %s as inter-seat traffic", (_name, raw) => {
    expect(parseSpatialTrafficEvent("local", raw)).toEqual({ kind: "ignored" });
  });

  it.each([
    ["missing seq", { seq: undefined }],
    ["string seq", { seq: "7" }],
    ["zero seq", { seq: 0 }],
    ["fractional seq", { seq: 1.5 }],
    ["unsafe seq", { seq: 2 ** 53 }],
    ["missing createdAt", { createdAt: undefined }],
    ["unparseable createdAt", { createdAt: "yesterday" }],
    ["impossible date", { createdAt: "2026-02-30 10:00:00" }],
    ["epoch number time", { createdAt: NOW }],
    ["missing destination", { destinationSession: undefined }],
    ["empty source", { sourceSession: "" }],
    ["non-string endpoint", { sourceSession: { session: "lead@acme" } }],
  ])("rejects %s", (_name, patch) => {
    const raw = { type: "queue.created", seq: 7, createdAt: "2026-10-05 11:59:58", sourceSession: "lead@acme", destinationSession: "builder@acme", ...patch };
    expect(parseSpatialTrafficEvent("local", raw).kind).toBe("invalid");
  });

  it("treats SQLite UTC and explicit-zone ISO stamps as the same canonical instant", () => {
    expect(canonicalEventTime("2026-10-05 12:00:00")).toBe(NOW);
    expect(canonicalEventTime("2026-10-05T14:00:00+02:00")).toBe(NOW);
    expect(canonicalEventTime("2026-10-05T12:00:00")).toBeNull();
  });

  it("scopes identity by source as well as seq", () => {
    expect(spatialTrafficId("local", 7)).not.toBe(spatialTrafficId("other", 7));
  });
});

describe("retainSpatialTraffic", () => {
  it("deduplicates by id and keeps the first delivery's liveness", () => {
    const history = observation(5, { live: false });
    const once = retainSpatialTraffic([], history);
    const again = retainSpatialTraffic(once, observation(5, { live: true }));
    expect(again).toBe(once);
    expect(again[0]!.live).toBe(false);
  });

  it("keeps seq order, bounds retention, and never readmits evicted older events", () => {
    let list: readonly SpatialTrafficObservation[] = [];
    for (const seq of [3, 1, 2, 5, 4]) list = retainSpatialTraffic(list, observation(seq), 3);
    expect(list.map((o) => o.seq)).toEqual([3, 4, 5]);
    const replayedOld = retainSpatialTraffic(list, observation(1), 3);
    expect(replayedOld).toBe(list);
  });
});

describe("freshness", () => {
  it("requires live delivery and canonical time within the declared window", () => {
    expect(isSpatialTrafficFresh(observation(1, { occurredAt: NOW - SPATIAL_TRAFFIC_FRESH_MS }), NOW)).toBe(true);
    expect(isSpatialTrafficFresh(observation(1, { occurredAt: NOW - SPATIAL_TRAFFIC_FRESH_MS - 1 }), NOW)).toBe(false);
    expect(isSpatialTrafficFresh(observation(1, { occurredAt: NOW - 10, live: false }), NOW)).toBe(false);
    expect(isSpatialTrafficFresh(observation(1, { occurredAt: NOW + SPATIAL_TRAFFIC_FUTURE_SKEW_MS + 1 }), NOW)).toBe(false);
  });

  it("is live only strictly after a connection baseline and outside replay", () => {
    expect(isLiveDelivery(NOW, null, false)).toBe(false);
    expect(isLiveDelivery(NOW, NOW - 5_000, true)).toBe(false);
    expect(isLiveDelivery(NOW + 1_000, NOW + 600, false)).toBe(true);
    // A whole-second stamp at or before the baseline may be a replayed row.
    expect(isLiveDelivery(NOW, NOW, false)).toBe(false);
    expect(isLiveDelivery(NOW, NOW + 600, false)).toBe(false);
    expect(isLiveDelivery(NOW, NOW + 999, false)).toBe(false);
  });

  it("schedules expiry only while pulses exist", () => {
    expect(nextSpatialTrafficExpiry([], NOW)).toBeNull();
    expect(nextSpatialTrafficExpiry([{ occurredAt: NOW - 2_000 }, { occurredAt: NOW - 5_000 }], NOW)).toBe(SPATIAL_TRAFFIC_FRESH_MS - 5_000);
  });
});

describe("projectSpatialTraffic", () => {
  it("resolves endpoints exactly and uniquely, never by node id, label or case", () => {
    const m = model();
    const { records } = projectSpatialTraffic([
      observation(1, { fromSession: "lead@acme", toSession: "lead@beta" }),
      observation(2, { fromSession: "Lead@Acme", toSession: "builder@acme" }),
      observation(3, { fromSession: "lead", toSession: "builder@acme" }),
    ], m, "local", NOW);
    expect(records).toHaveLength(1);
    // Same node id "n1" in two rigs stays two distinct endpoints.
    expect(records[0]).toMatchObject({ sourceKey: LEAD_A, targetKey: LEAD_B });
  });

  it("counts only view-touching unresolved or ambiguous events as unplaced", () => {
    const m = model();
    const projection = projectSpatialTraffic([
      observation(1, { toSession: "human@host" }), // one end placed, other absent
      observation(2, { toSession: "dup@shared" }), // ambiguous canonical name
      observation(3, { fromSession: "x@elsewhere", toSession: "y@elsewhere" }), // wholly outside the view
    ], m, "local", NOW);
    expect(projection.records).toEqual([]);
    expect(projection.fresh).toEqual([]);
    expect(projection.unplacedCount).toBe(2);
  });

  it("projects nothing for a model of a different source", () => {
    const projection = projectSpatialTraffic([observation(1)], model("remote-1"), "local", NOW);
    expect(projection).toEqual({ records: [], fresh: [], unplacedCount: 0 });
  });

  it("labels queue semantics honestly and carries canonical time and qitem", () => {
    const { records } = projectSpatialTraffic([
      observation(1, { qitemId: "q-1" }),
      observation(2, { type: "queue.handed_off" }),
      observation(3, { type: "qitem.fallback_routed", fromSession: "builder@acme", toSession: "lead@acme" }),
    ], model(), "local", NOW);
    expect(records.map((r) => r.type)).toEqual(["qitem.fallback_routed", "queue.handed_off", "queue.created"]);
    expect(records[2]).toMatchObject({ qitemId: "q-1", occurredAt: NOW - 1_000 });
    expect(records[2]!.label).toMatch(/queue record, not a read receipt/);
    expect(records[1]!.label).toMatch(/handoff record, not a read receipt/);
    expect(records[0]).toMatchObject({ sourceKey: BUILDER_A, targetKey: LEAD_A });
    expect(records[0]!.label).toMatch(/original destination, not sender/);
  });

  it("keeps old, replayed and self-addressed traffic as history without pulses", () => {
    const projection = projectSpatialTraffic([
      observation(1, { occurredAt: NOW - SPATIAL_TRAFFIC_FRESH_MS - 1 }),
      observation(2, { live: false }),
      observation(3, { toSession: "lead@acme" }),
    ], model(), "local", NOW);
    expect(projection.records).toHaveLength(3);
    expect(projection.fresh).toEqual([]);
  });

  it("bounds records and concurrent pulses, coalescing a directed pair to its newest event", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => `s${i}@wide`);
    const wide = buildSpatialModel("local", [parseSpatialRig("local", {
      rigId: "rig_w", rigName: "wide",
      graph: { nodes: sessions.map((s, i) => agentNode(`w${i}`, `w${i}`, s)), edges: [] },
    })]);
    const many: SpatialTrafficObservation[] = [];
    for (let seq = 1; seq <= 80; seq += 1) many.push(observation(seq, { fromSession: "s0@wide", toSession: "s1@wide" }));
    for (let i = 2; i < 12; i += 1) many.push(observation(100 + i, { fromSession: "s0@wide", toSession: sessions[i]! }));
    const projection = projectSpatialTraffic(many, wide, "local", NOW);
    expect(projection.records).toHaveLength(MAX_SPATIAL_TRAFFIC_RECORDS);
    expect(projection.fresh).toHaveLength(MAX_SPATIAL_TRAFFIC_PULSES);
    const pairs = projection.fresh.map((r) => `${r.sourceKey}>${r.targetKey}`);
    expect(new Set(pairs).size).toBe(pairs.length);

    const single = projectSpatialTraffic(many.slice(0, 80), wide, "local", NOW);
    expect(single.fresh.map((r) => r.id)).toEqual([spatialTrafficId("local", 80)]);
  });
});
