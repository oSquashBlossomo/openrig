import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";

const FIRST = "2026-10-04T21:00:00.000Z", SECOND = "2026-10-04T21:01:00.000Z", THIRD = "2026-10-04T21:02:00.000Z";
const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
function database() {
  const db = createDb(); dispose.push(() => db.close()); migrate(db, ALL_MIGRATIONS); return db;
}
function fixture(kind: "legacy" | "occurrence" | "parallel") {
  const db = database(), dir = mkdtempSync(join(tmpdir(), "workflow-completed-at-"));
  dispose.push(() => rmSync(dir, { recursive: true, force: true }));
  const specPath = join(dir, "workflow.yaml");
  writeFileSync(specPath, `workflow:
  id: private-completed-at-${kind}
  version: "01"
  entry: { role: root }
  roles:
    root: { preferred_targets: [root@rig] }
    left: { preferred_targets: [left@rig] }
    right: { preferred_targets: [right@rig] }
  exception_routing: { orchestrator_role: root }
  steps:
    - { id: root, actor_role: root, allowed_exits: [done, failed, waiting]${kind === "occurrence" ? ", depends_on: []" : ""} }
${kind === "parallel" ? "    - { id: left, actor_role: left, depends_on: [root], allowed_exits: [done, failed] }\n    - { id: right, actor_role: right, depends_on: [root], allowed_exits: [done, failed] }\n" : ""}`);
  const bus = new EventBus(db);
  db.prepare("INSERT INTO rigs (id,name) VALUES ('private-rig','rig')").run();
  const queue = new QueueRepository(db, bus, { validateRig: session => ["root", "left", "right", "human"].some(role => session === `${role}@rig`), loadHumanRegistry: () => ({ ok: true, entities: [] }) });
  queue.attachOutbox(new OutboxHandler(db)); // Same private DB; no native transport.
  let time = FIRST;
  const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, now: () => new Date(time),
    exceptionDial: { hostDefault: () => null, humanFallbackSeat: () => { throw new Error("No private human fallback configured"); } } });
  return { db, queue, runtime, specPath, clock: (value: string) => { time = value; } };
}

describe("explicit completedAt store contract", () => {
  it.each([{}, { completedAt: undefined }])("preserves an existing timestamp when completedAt is omitted/undefined (%j)", options => {
    const store = new WorkflowInstanceStore(database());
    const instance = store.create({ workflowName: "private", workflowVersion: "01", createdBySession: "human@rig" });
    store.updateFrontier(instance.instanceId, [], "failed", { completedAt: FIRST });
    store.updateFrontier(instance.instanceId, ["redrive"], "active", options);
    expect(store.getByIdOrThrow(instance.instanceId).completedAt).toBe(FIRST);
  });
  it("clears with explicit null and accepts a new terminal timestamp without clearing other recorded fields", () => {
    const store = new WorkflowInstanceStore(database());
    const instance = store.create({ workflowName: "private", workflowVersion: "01", createdBySession: "human@rig" });
    store.updateFrontier(instance.instanceId, [], "failed", { completedAt: FIRST, lastContinuationDecision: { exact: "prior decision" }, fallbackSynthesis: "retained" });
    store.updateFrontier(instance.instanceId, ["redrive"], "active", { completedAt: null });
    const active = store.getByIdOrThrow(instance.instanceId);
    expect(active.completedAt).toBeNull(); expect(active.lastContinuationDecision).toEqual({ exact: "prior decision" }); expect(active.fallbackSynthesis).toBe("retained");
    store.updateFrontier(instance.instanceId, [], "completed", { completedAt: SECOND });
    expect(store.getByIdOrThrow(instance.instanceId).completedAt).toBe(SECOND);
  });
  it("a stale version-guarded clear cannot change the prior terminal timestamp or frontier", () => {
    const store = new WorkflowInstanceStore(database());
    const instance = store.create({ workflowName: "private", workflowVersion: "01", createdBySession: "human@rig" });
    store.updateFrontier(instance.instanceId, [], "failed", { completedAt: FIRST, expectedVersion: instance.version });
    const before = store.getByIdOrThrow(instance.instanceId);
    expect(() => store.updateFrontier(instance.instanceId, ["wrong"], "active", { completedAt: null, expectedVersion: instance.version })).toThrow(expect.objectContaining({ code: "instance_version_conflict" }));
    expect(store.getByIdOrThrow(instance.instanceId)).toEqual(before);
  });
});

describe("current terminal episode timestamp through real workflow scribes", () => {
  it.each(["legacy", "occurrence"] as const)("%s resume clears the failed timestamp, preserves history and later stamps the new completion", async kind => {
    const { runtime, specPath, clock, db } = fixture(kind);
    const created = await runtime.instantiate({ specPath, rootObjective: "private terminal episode", createdBySession: "human@rig" });
    const id = created.instance.instanceId;
    await runtime.project({ instanceId: id, currentPacketId: created.entryQitemId, exit: "failed", actorSession: "root@rig" });
    expect(runtime.instanceStore.getByIdOrThrow(id).completedAt).toBe(FIRST);
    const failures = runtime.instanceStore.listFailureOccurrences(id);
    expect(failures).toHaveLength(kind === "legacy" ? 0 : 1); // Proves both distinct real resume paths.
    const history = runtime.trailLog.listForInstance(id);
    clock(SECOND);
    const input = { instanceId: id, actorSession: "human@rig", decision: "exact %2F:01 雪", ...(kind === "occurrence" ? { occurrenceId: failures[0]!.occurrenceId } : {}) };
    const resumed = await runtime.resume(input);
    const active = runtime.instanceStore.getByIdOrThrow(id);
    expect(active.status).toBe("active"); expect(active.completedAt).toBeNull(); expect(active.currentFrontier).toEqual([resumed.newPacketId]);
    expect(runtime.trailLog.listForInstance(id)).toEqual(history);
    clock(THIRD);
    await runtime.project({ instanceId: id, currentPacketId: resumed.newPacketId, exit: "done", actorSession: "root@rig" });
    const completed = runtime.instanceStore.getByIdOrThrow(id);
    expect(completed.status).toBe("completed"); expect(completed.completedAt).toBe(THIRD);
    expect(runtime.trailLog.listForInstance(id)).toEqual(expect.arrayContaining(history));
    if (kind === "occurrence") {
      const rowsBefore = db.prepare("SELECT count(*) AS n FROM events").get();
      const replay = await runtime.resume(input);
      expect(replay.absorbedReplay).toBe(true); expect(replay.newPacketId).toBe(resumed.newPacketId);
      expect(runtime.instanceStore.getByIdOrThrow(id)).toEqual(completed); // Replay cannot erase a later terminal episode.
      expect(db.prepare("SELECT count(*) AS n FROM events").get()).toEqual(rowsBefore);
    }
  });
  it.each(["legacy", "occurrence"] as const)("%s projector's explicit nonterminal null clears an old persisted timestamp while waiting", async kind => {
    const { runtime, specPath } = fixture(kind);
    const created = await runtime.instantiate({ specPath, rootObjective: "old persisted stamp", createdBySession: "human@rig" });
    runtime.instanceStore.updateFrontier(created.instance.instanceId, [created.entryQitemId], "active", { completedAt: FIRST });
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: created.entryQitemId, exit: "waiting", blockedOn: "private-input", actorSession: "root@rig" });
    const waiting = runtime.instanceStore.getByIdOrThrow(created.instance.instanceId);
    expect(waiting.status).toBe("waiting"); expect(waiting.completedAt).toBeNull(); expect(waiting.currentFrontier).toEqual([created.entryQitemId]);
  });
  it("resuming one of two real failures clears current terminal time, retains both episode facts and later stamps abort", async () => {
    const { runtime, specPath, clock } = fixture("parallel");
    const created = await runtime.instantiate({ specPath, rootObjective: "private parallel", createdBySession: "human@rig" });
    const id = created.instance.instanceId;
    await runtime.project({ instanceId: id, currentPacketId: created.entryQitemId, exit: "done", actorSession: "root@rig" });
    for (const packet of [...runtime.inspect(id).frontier]) await runtime.project({ instanceId: id, currentPacketId: packet.packetId, exit: "failed", actorSession: `${packet.stepId}@rig` });
    const failures = runtime.instanceStore.listFailureOccurrences(id), selected = failures.find(row => row.stepId === "left")!, sibling = failures.find(row => row.stepId === "right")!;
    expect(runtime.instanceStore.getByIdOrThrow(id).completedAt).toBe(FIRST);
    clock(SECOND);
    const resumed = await runtime.resume({ instanceId: id, occurrenceId: selected.occurrenceId, decision: "one only", actorSession: "human@rig" });
    expect(runtime.instanceStore.getByIdOrThrow(id).completedAt).toBeNull();
    expect(runtime.instanceStore.listFailureOccurrences(id).find(row => row.occurrenceId === sibling.occurrenceId)).toEqual(sibling);
    expect(runtime.instanceStore.listFailureOccurrences(id).find(row => row.occurrenceId === selected.occurrenceId)).toMatchObject({ failedAt: selected.failedAt, status: "resolved", redrivePacketId: resumed.newPacketId, resolvedAt: SECOND });
    clock(THIRD);
    await runtime.abort({ instanceId: id, reason: "stop private redrive", actorSession: "human@rig" });
    expect(runtime.instanceStore.getByIdOrThrow(id)).toMatchObject({ status: "aborted", completedAt: THIRD });
  });
});
