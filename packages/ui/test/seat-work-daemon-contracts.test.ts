// @vitest-environment node
// Real Hono/QueueRepository/node enrichment, private SQLite, no native provider.
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { SessionRegistry } from "../../daemon/src/domain/session-registry.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { nodesRoutes } from "../../daemon/src/routes/sessions.js";
import { readNodeInventory } from "../src/lib/fleet-inventory-reads.js";
import { readSeatWork } from "../src/lib/seat-work-reads.js";
import { LOCAL_OPERATOR_INSTANCE as local } from "../src/lib/operator-read.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("filters exact destination/state before SQL limit, separates raw/canonical totals, and retains served activity facts", async () => {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), rig = rigRepo.createRig("private-seat-work");
    const node = rigRepo.addNode(rig.id, "pod.owner");
    const sessionRegistry = new SessionRegistry(db), rawSession = "raw%2F/seat+&exact";
    sessionRegistry.registerClaimedSession(node.id, rawSession);
    const alias = "pod-owner@private-seat-work";
    const insert = db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session,
      destination_session, state, priority, body, summary, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let sequence = 0;
    function seed(destination: string, state: string, claimed = false) {
      const n = sequence++, id = `private-q${n}`, ts = new Date(Date.UTC(2026, 9, 5) + n * 1000).toISOString();
      insert.run(id, ts, ts, "source@fixture", destination, state, "routine", `Exact ${state} ${n}`, null, claimed ? ts : null);
      return id;
    }
    for (let n = 0; n < 100; n++) seed(rawSession, "in-progress");
    for (let n = 0; n < 3; n++) seed(rawSession, "blocked");
    for (let n = 0; n < 55; n++) seed(rawSession, "pending", true);
    for (let n = 0; n < 25; n++) seed(rawSession, n % 2 ? "done" : "handed-off");
    for (let n = 0; n < 7; n++) seed(alias, "pending");
    for (let n = 0; n < 2; n++) seed(alias, "blocked");
    // More than any limit, newer unrelated destinations. Post-limit filtering
    // would incorrectly return no seat rows in all three source windows.
    for (let n = 0; n < 120; n++) { seed("foreign@fixture", "pending"); seed("foreign@fixture", "in-progress"); seed("foreign@fixture", "done"); }
    const eventBus = new EventBus(db);
    const queueRepo = new QueueRepository(db, eventBus, { loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    const native = vi.fn(() => { throw new Error("Native adapter is inert"); });
    const seatActivityService = { getSeatActivity: () => null, getSeatStateBySession: () => ({ activity: "working",
      needsInput: { count: 2, reason: "permission prompt" }, decidedBy: "lifecycle-hooks", seq: 12, lastSwap: null }) };
    const app = new Hono(); app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries({ queueRepo, eventBus, rigRepo, sessionRegistry, seatActivityService,
        tmuxAdapter: { capturePane: native, createSession: native } })) c.set(key as never, value as never);
      await next();
    });
    app.route("/api/queue", queueRoutes()); app.route("/api/rigs/:rigId/nodes", nodesRoutes);
    const fetch = vi.fn((route: string, init?: RequestInit) => app.request(route, { method: init?.method, headers: init?.headers }));
    vi.stubGlobal("fetch", fetch);
    const inventory = await readNodeInventory(rig.id, "local"); expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ canonicalSessionName: rawSession, assignedWorkCount: 167, pendingWorkCount: 62,
      inProgressWorkCount: 100, blockedWorkCount: 5, terminalActive: null,
      activityState: { activity: "working", display: "needs-input", needsInput: { count: 2, reason: "permission prompt" },
        decidedBy: "lifecycle-hooks", seq: 12, lastSwap: null } });
    const exact = inventory[0]!;
    const target = { rigId: exact.rigId, logicalId: exact.logicalId, canonicalSessionName: exact.canonicalSessionName! };
    const reads = await readSeatWork(local, target);
    for (const [name, result] of Object.entries(reads)) {
      expect(result.state).toBe("available"); if (result.state !== "available") throw result.error;
      const states = name === "current" ? ["in-progress", "blocked"] : name === "pending" ? ["pending"] : ["done", "handed-off"];
      const limit = name === "current" ? 100 : name === "pending" ? 50 : 20;
      expect(result.data.rows).toEqual(queueRepo.list({ destinationSession: rawSession, state: states as never, limit }));
      expect(result.data.rows).toHaveLength(limit); expect(result.data.possiblyBounded).toBe(true);
      expect(result.data.totalCount).toBeNull(); expect(result.data.rows.every(q => q.destinationSession === rawSession)).toBe(true);
    }
    expect(reads.pending.state === "available" && reads.pending.data.rows.every(q => q.claimedAt !== null)).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(native).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM queue_items").get()).toEqual({ n: 552 });
  } finally { db.close(); }
});
