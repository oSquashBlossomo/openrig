import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { seatRoutes } from "../src/routes/seat.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Real Hono decoding, resolution, guard and SQLite effects. No native process,
// settings, transcript or filesystem mutation; all tmux seams are inert spies.
describe("seat routes preserve once-decoded opaque references", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let guard: SeatDeliveryGuard;
  let outbox: OutboxHandler;
  let rigId: string;
  const tmux = {
    hasSession: vi.fn(async () => true),
    listClients: vi.fn(async () => [{ name: "private-client", session: "elsewhere" }]),
    switchClient: vi.fn(async () => ({ ok: true })),
    probeSession: vi.fn(async () => { throw new Error("Unexpected native probe"); }),
    killSession: vi.fn(async () => { throw new Error("Unexpected native kill"); }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    outbox = new OutboxHandler(db);
    rigId = rigRepo.createRig("private-seat-fixture").id;
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("rigRepo" as never, rigRepo as never);
      c.set("sessionRegistry" as never, registry as never);
      c.set("discoveryRepo" as never, new DiscoveryRepository(db) as never);
      c.set("eventBus" as never, new EventBus(db) as never);
      c.set("tmuxAdapter" as never, { ...tmux, deliveryGuard: guard } as unknown as TmuxAdapter as never);
      await next();
    });
    app.route("/api/seat", seatRoutes);
  });

  afterEach(() => {
    expect(tmux.probeSession).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    db.close();
  });

  function seed(logicalId: string) {
    return rigRepo.addNode(rigId, logicalId, { runtime: "codex", model: "original-model" });
  }

  function post(verb: string, ref: string, body: Record<string, unknown>, actor: string | null = "operator@private-seat-fixture") {
    return app.request(`/api/seat/${verb}/${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(actor ? { "x-openrig-session": actor } : {}) },
      body: JSON.stringify(body),
    });
  }

  function retain(nodeId: string, id: string) {
    const binding = guard.target(nodeId);
    return outbox.retain({ outboxId: id, senderSession: "operator", destinationSession: binding.session, body: id }, binding);
  }

  it.each(["worker%2Ftail", "worker%20tail", "worker%252Ftail", "worker%"])("status resolves literal reference %s, including its guard", async ref => {
    const node = seed(ref);
    if (ref !== "worker%") seed(decodeURIComponent(ref));
    await guard.set(node.id, true, "operator", "private preference");
    const res = await app.request(`/api/seat/status/${encodeURIComponent(ref)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seat_ref: ref, logical_id: ref, typingGuard: { nodeId: node.id, effective: true } });
  });

  it.each(["worker%2Ftail", "worker%"])("set-model writes only the exact seat %s", async ref => {
    const target = seed(ref), sibling = seed(ref === "worker%" ? "worker" : decodeURIComponent(ref));
    const res = await post("set-model", `${ref}@private-seat-fixture`, { model: "new-model", reason: "private change", operator: "operator" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, seat: { nodeId: target.id, logicalId: ref }, from: "original-model", to: "new-model" });
    expect(db.prepare("SELECT id, model FROM nodes ORDER BY id").all()).toEqual(
      [{ id: target.id, model: "new-model" }, { id: sibling.id, model: "original-model" }].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("set-typing-guard changes only the exact node and retains wire actor", async () => {
    const target = seed("worker%2Ftail"), sibling = seed("worker/tail");
    const res = await post("set-typing-guard", "worker%2Ftail", { enabled: true, reason: "draft in progress", actor: "ignored-body-actor" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nodeId: target.id, effective: true });
    expect(guard.preference(sibling.id).effective).toBe(false);
    expect(db.prepare("SELECT actor, reason FROM seat_delivery_guards WHERE node_id=?").get(target.id))
      .toEqual({ actor: "operator@private-seat-fixture", reason: "draft in progress" });
  });

  it("held history and exact-id lookup never disclose the decode-equivalent sibling", async () => {
    const target = seed("worker%2Ftail"), sibling = seed("worker/tail");
    retain(target.id, "target-held"); retain(sibling.id, "sibling-held");
    const list = await app.request(`/api/seat/held-messages/${encodeURIComponent("worker%2Ftail")}`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ outboxId: "target-held" }], total: 1 });
    const foreign = await app.request(`/api/seat/held-messages/${encodeURIComponent("worker%2Ftail")}?id=sibling-held`);
    expect(foreign.status).toBe(404);
  });

  it("retirement cannot use a literal-percent seat ref to retire a sibling's history", async () => {
    const target = seed("worker%2Ftail"), sibling = seed("worker/tail");
    retain(target.id, "target-held"); retain(sibling.id, "sibling-held");
    const res = await app.request(`/api/seat/retire-held-message/${encodeURIComponent("worker%2Ftail")}/sibling-held`, {
      method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "operator" }, body: JSON.stringify({ reason: "private retirement" }),
    });
    expect(res.status).toBe(404);
    expect(outbox.getById("sibling-held")?.deliveryState).toBe("retained");
    const own = await app.request(`/api/seat/retire-held-message/${encodeURIComponent("worker%2Ftail")}/target-held`, {
      method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "operator" }, body: JSON.stringify({ reason: "private retirement" }),
    });
    expect(own.status).toBe(200);
    expect(outbox.getById("target-held")).toMatchObject({ deliveryState: "retired", retiredBy: "operator" });
  });

  it("permissions persist only on the exact node without native permission changes", async () => {
    const target = seed("worker%2Ftail"), sibling = seed("worker/tail");
    const res = await post("set-permissions", "worker%2Ftail", { mode: "floor", reason: "private future-launch preference", actor: "ignored-body-actor" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seat: { nodeId: target.id }, changed: true });
    const permissions = new NativePermissionStore(db);
    expect(permissions.read(target.id)).toEqual({ runtime: "codex", mode: "floor", actor: "operator@private-seat-fixture", reason: "private future-launch preference", updatedAt: expect.any(String) });
    expect(permissions.read(sibling.id)).toBeNull();
  });

  it.each(["stop", "clean", "launch"])("%s resolves the exact guarded seat before any native effect", async verb => {
    const target = seed("worker%2Ftail"); seed("worker/tail");
    await guard.set(target.id, true, "operator", "protect private seat");
    const res = await post(verb, "worker%2Ftail", { reason: "private operation", fresh: true, stop: true, operator: "operator" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "typing_guard_enabled" });
    expect(guard.preference(target.id).effective).toBe(true);
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  it("handover dry-run resolves the exact seat without changing topology", async () => {
    const target = seed("worker%2Ftail"); seed("worker/tail");
    const before = db.prepare("SELECT * FROM nodes ORDER BY id").all();
    const res = await post("handover", "worker%2Ftail", { reason: "private plan", source: "fresh", dryRun: true, operator: "operator" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, seat: { ref: "worker%2Ftail", logicalId: target.logicalId }, dryRun: true, willMutate: false, reason: "private plan", operator: "operator" });
    expect(db.prepare("SELECT * FROM nodes ORDER BY id").all()).toEqual(before);
    expect(tmux.hasSession).not.toHaveBeenCalled();
  });

  it("switch-client resolves and passes the exact canonical session to the inert view boundary", async () => {
    const target = seed("worker%2Ftail"), sibling = seed("worker/tail");
    for (const node of [target, sibling]) {
      const name = `${node.id === target.id ? "target" : "sibling"}@private-seat-fixture`;
      registry.registerSession(node.id, name);
      registry.updateBinding(node.id, { tmuxSession: name, attachmentType: "tmux" });
    }
    const res = await post("switch-client", "worker%2Ftail", { client: "private-client" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seat_ref: "worker%2Ftail", session: "target@private-seat-fixture", mutated: false });
    expect(tmux.hasSession).toHaveBeenCalledWith("target@private-seat-fixture");
    expect(tmux.switchClient).toHaveBeenCalledExactlyOnceWith("private-client", "=target@private-seat-fixture:0");
  });

  it("ordinary identities keep the status/model and explicit-input controls", async () => {
    const node = seed("ordinary");
    const status = await app.request("/api/seat/status/ordinary");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ logical_id: "ordinary" });
    expect((await post("set-model", "ordinary", { model: "new-model", reason: "control" })).status).toBe(200);
    expect((await post("set-typing-guard", "ordinary", { enabled: true, reason: "control" }, null)).status).toBe(400);
    expect((await post("set-permissions", "ordinary", { mode: "floor", reason: "control" }, null)).status).toBe(400);
    const launch = await post("launch", "ordinary", { reason: "control" });
    expect(launch.status).toBe(400);
    expect(await launch.json()).toMatchObject({ code: "fresh_required" });
    expect(guard.preference(node.id).desired).toBe(false);
  });
});
