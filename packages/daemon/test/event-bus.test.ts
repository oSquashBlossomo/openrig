import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { RigEvent, PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  const db = createFullTestDb();
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
    "rig-1",
    "test-rig"
  );
  return db;
}

describe("EventBus", () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = setupDb();
    bus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  it("replays legacy audit payloads using their recorded type and seat columns without rewriting history", () => {
    const legacy = [
      { type: "node.primary_orchestrator_selected", payload: { reason: "recorded rollout", fromLabel: null, toLabel: "primary" } },
      { type: "node.primary_orchestrator_selected", payload: { reason: "recorded rollout", fromLabel: "old", toLabel: "new" } },
      { type: "edge.primary_dispatch_added", payload: { reason: "recorded rollout", edge: {
        id: "edge-1", rigId: "rig-1", sourceId: "node-1", targetId: "node-2", kind: "dispatch", createdAt: "2026-10-03T00:00:00Z",
      } } },
    ];
    for (const event of legacy) db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
      .run("rig-1", "node-1", event.type, JSON.stringify(event.payload));
    const stored = db.prepare("SELECT * FROM events ORDER BY seq").all();
    const status = bus.getNotifyDrainStatus();
    const replay = bus.replayAll(0);
    expect(replay).toEqual(legacy.map((event, index) => ({ ...event.payload, type: event.type, rigId: "rig-1", nodeId: "node-1",
      seq: index + 1, createdAt: expect.any(String) })));
    expect(bus.replaySince(1, "rig-1")).toEqual(replay.slice(1));
    expect(bus.replayAllSettled(0, 3)).toEqual(replay.map(event => ({ seq: event.seq, event })));
    expect(db.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(stored);
    expect(bus.getNotifyDrainStatus()).toEqual(status);
  });

  it.each([
    ["unrecognized legacy type", "other.audit", { reason: "fixture", fromLabel: null, toLabel: "primary" }, "rig-1", "node-1"],
    ["malformed label", "node.primary_orchestrator_selected", { reason: "fixture", fromLabel: null, toLabel: 7 }, "rig-1", "node-1"],
    ["explicit invalid discriminator", "node.primary_orchestrator_selected", { type: null, reason: "fixture", fromLabel: null, toLabel: "primary" }, "rig-1", "node-1"],
    ["unrecorded scope", "node.primary_orchestrator_selected", { reason: "fixture", fromLabel: null, toLabel: "primary" }, null, null],
    ["extra envelope fields", "node.primary_orchestrator_selected", { reason: "fixture", fromLabel: null, toLabel: "primary", rigId: "other" }, "rig-1", "node-1"],
    ["conflicting edge scope", "edge.primary_dispatch_added", { reason: "fixture", edge: { id: "edge", rigId: "other", sourceId: "node-1", targetId: "node-2", kind: "dispatch", createdAt: "fixture" } }, "rig-1", "node-1"],
  ])("keeps %s payloads invalid", (_name, type, payload, rigId, nodeId) => {
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
      .run(rigId, nodeId, type, JSON.stringify(payload));
    expect(() => bus.replayAll(0)).toThrow("invalid event payload shape");
    expect(bus.replayAllSettled(0, 1)).toEqual([{ seq: 1, error: "invalid event payload shape" }]);
  });

  it("emit persists event to DB with monotonic seq", () => {
    const e1 = bus.emit({ type: "rig.created", rigId: "rig-1" });
    const e2 = bus.emit({ type: "node.added", rigId: "rig-1", nodeId: "n1", logicalId: "worker" });

    expect(typeof e1.seq).toBe("number");
    expect(typeof e2.seq).toBe("number");
    expect(e2.seq).toBeGreaterThan(e1.seq);

    // Verify actually in DB
    const rows = db.prepare("SELECT seq FROM events ORDER BY seq").all() as { seq: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.seq).toBe(e1.seq);
    expect(rows[1]!.seq).toBe(e2.seq);
  });

  it("emit returns PersistedEvent with seq and createdAt", () => {
    const persisted = bus.emit({ type: "rig.created", rigId: "rig-1" });

    expect(persisted.seq).toBeDefined();
    expect(persisted.createdAt).toBeDefined();
    expect(persisted.type).toBe("rig.created");
    expect(persisted.rigId).toBe("rig-1");
  });

  it("subscribe receives PersistedEvent with seq", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    const emitted = bus.emit({ type: "rig.created", rigId: "rig-1" });

    expect(received).toHaveLength(1);
    expect(received[0]!.seq).toBe(emitted.seq);
    expect(received[0]!.type).toBe("rig.created");
    expect(received[0]!.createdAt).toBeDefined();
  });

  it("multiple subscribers all receive the same event", () => {
    const received1: PersistedEvent[] = [];
    const received2: PersistedEvent[] = [];
    bus.subscribe((event) => received1.push(event));
    bus.subscribe((event) => received2.push(event));

    bus.emit({ type: "rig.created", rigId: "rig-1" });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(received1[0]!.seq).toBe(received2[0]!.seq);
  });

  it("unsubscribe stops delivery", () => {
    const received: PersistedEvent[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    bus.emit({ type: "rig.created", rigId: "rig-1" });
    expect(received).toHaveLength(1);

    unsubscribe();
    bus.emit({ type: "rig.deleted", rigId: "rig-1" });
    expect(received).toHaveLength(1); // no new events
  });

  it("subscriber error does not break emitter or other subscribers", () => {
    const received: PersistedEvent[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    bus.subscribe(() => {
      throw new Error("subscriber boom");
    });
    bus.subscribe((event) => received.push(event));

    // Should not throw despite first subscriber erroring
    expect(() =>
      bus.emit({ type: "rig.created", rigId: "rig-1" })
    ).not.toThrow();

    // Second subscriber still received the event
    expect(received).toHaveLength(1);

    consoleError.mockRestore();
  });

  it("typed event discrimination works", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.emit({ type: "node.added", rigId: "rig-1", nodeId: "n1", logicalId: "worker" });

    const event = received[0]!;
    if (event.type === "node.added") {
      expect(event.nodeId).toBe("n1");
      expect(event.logicalId).toBe("worker");
    } else {
      expect.unreachable("expected node.added event");
    }
  });

  it("emit persists before notify — subscriber can query DB during callback", () => {
    let seqFoundInDb = false;

    bus.subscribe((event) => {
      // During the callback, the event should already be in the DB
      const row = db
        .prepare("SELECT seq FROM events WHERE seq = ?")
        .get(event.seq) as { seq: number } | undefined;
      seqFoundInDb = row?.seq === event.seq;
    });

    bus.emit({ type: "rig.created", rigId: "rig-1" });

    expect(seqFoundInDb).toBe(true);
  });

  it("replaySince returns events after given seq in order", () => {
    const e1 = bus.emit({ type: "rig.created", rigId: "rig-1" });
    const e2 = bus.emit({ type: "node.added", rigId: "rig-1", nodeId: "n1", logicalId: "a" });
    const e3 = bus.emit({ type: "node.added", rigId: "rig-1", nodeId: "n2", logicalId: "b" });

    const replay = bus.replaySince(e1.seq, "rig-1");
    expect(replay).toHaveLength(2);
    expect(replay[0]!.seq).toBe(e2.seq);
    expect(replay[1]!.seq).toBe(e3.seq);
    expect(replay[0]!.type).toBe("node.added");
  });

  it("replaySince filters by rigId", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-2",
      "other-rig"
    );

    bus.emit({ type: "rig.created", rigId: "rig-1" });
    bus.emit({ type: "rig.created", rigId: "rig-2" });
    bus.emit({ type: "node.added", rigId: "rig-1", nodeId: "n1", logicalId: "worker" });

    const replay = bus.replaySince(0, "rig-1");
    expect(replay).toHaveLength(2); // rig.created + node.added for rig-1 only
    expect(replay.every((e) => e.rigId === "rig-1")).toBe(true);
  });

  it("persistWithinTransaction inserts row, returns PersistedEvent with seq", () => {
    const persisted = bus.persistWithinTransaction({
      type: "rig.created",
      rigId: "rig-1",
    });

    expect(persisted.seq).toBeDefined();
    expect(typeof persisted.seq).toBe("number");
    expect(persisted.type).toBe("rig.created");
    expect(persisted.createdAt).toBeDefined();

    // Verify it's in the DB
    const row = db
      .prepare("SELECT seq FROM events WHERE seq = ?")
      .get(persisted.seq) as { seq: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.seq).toBe(persisted.seq);
  });

  // T12: AgentSpec reboot event types persist and round-trip
  it("new AgentSpec reboot event types persist via EventBus", () => {
    const events: RigEvent[] = [
      { type: "pod.created", rigId: "rig-1", podId: "p1", namespace: "dev", label: "Dev" },
      { type: "pod.deleted", rigId: "rig-1", podId: "p1" },
      { type: "node.startup_pending", rigId: "rig-1", nodeId: "n1" },
      { type: "node.startup_ready", rigId: "rig-1", nodeId: "n1" },
      { type: "node.startup_failed", rigId: "rig-1", nodeId: "n1", error: "timeout" },
      { type: "continuity.sync", rigId: "rig-1", podId: "p1", nodeId: "n1" },
      { type: "continuity.degraded", rigId: "rig-1", podId: "p1", nodeId: "n1", reason: "stale artifacts" },
    ];

    for (const event of events) {
      const persisted = bus.emit(event);
      expect(persisted.seq).toBeDefined();
      expect(persisted.type).toBe(event.type);
    }

    // Verify all 7 are in the DB
    const rows = db.prepare("SELECT type FROM events ORDER BY seq").all() as { type: string }[];
    const types = rows.map((r) => r.type);
    expect(types).toContain("pod.created");
    expect(types).toContain("pod.deleted");
    expect(types).toContain("node.startup_pending");
    expect(types).toContain("node.startup_ready");
    expect(types).toContain("node.startup_failed");
    expect(types).toContain("continuity.sync");
    expect(types).toContain("continuity.degraded");
  });

  it("notifySubscribers fans out to subscribers without DB insert", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    const eventCountBefore = (
      db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
    ).cnt;

    // Create a fake persisted event (not from DB)
    const fakeEvent: PersistedEvent = {
      type: "rig.created",
      rigId: "rig-1",
      seq: 9999,
      createdAt: "2026-03-23T00:00:00",
    };

    bus.notifySubscribers(fakeEvent);

    // Subscriber received it
    expect(received).toHaveLength(1);
    expect(received[0]!.seq).toBe(9999);

    // No new DB row
    const eventCountAfter = (
      db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number }
    ).cnt;
    expect(eventCountAfter).toBe(eventCountBefore);
  });
});
