import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { workflowRoutes } from "../src/routes/workflow.js";

describe("sequential workflow resume selected failure", () => {
  let db: ReturnType<typeof createDb>;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let dir: string;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    const eventBus = new EventBus(db);
    db.prepare("INSERT INTO rigs(id,name) VALUES('private-rig','private-rig')").run();
    const queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo,
      exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" } });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime); c.set("eventBus" as never, eventBus); await next(); });
    app.route("/api/workflow", workflowRoutes());
    dir = mkdtempSync(join(tmpdir(), "sequential-resume-selection-"));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  async function fail(instanceId: string, packetId: string) {
    await runtime.project({ instanceId, currentPacketId: packetId, exit: "failed", resultNote: "controlled failure", actorSession: "owner@private-rig" });
    const instance = runtime.instanceStore.getByIdOrThrow(instanceId);
    return { version: instance.version, failedPacketId: packetId, stepId: "work" };
  }
  async function start(dependency = false) {
    const specPath = join(dir, "workflow.yaml");
    writeFileSync(specPath, `workflow:
  id: private-resume-selection
  version: 1
  entry: {role: owner}
  roles:
    owner: {preferred_targets: [owner@private-rig]}
  exception_routing: {orchestrator_role: owner}
  steps:
    - id: work
      actor_role: owner
${dependency ? "      depends_on: []\n" : ""}      allowed_exits: [done, failed]
`);
    const created = await runtime.instantiate({ specPath, rootObjective: "private recovery test", createdBySession: "owner@private-rig" });
    return { id: created.instance.instanceId, selection: await fail(created.instance.instanceId, created.entryQitemId) };
  }
  const post = (id: string, body: Record<string, unknown>) => app.request(`/api/workflow/${id}/resume`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorSession: "owner@private-rig", decision: "retry selected failure", ...body }),
  });
  const snapshot = () => ["workflow_instances", "workflow_failure_occurrences", "workflow_frontier_bindings", "workflow_step_trails", "queue_items", "queue_transitions", "outbox_entries", "events"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

  it("resumes the exact read version, failed packet and step through Hono without creating dependency occurrences", async () => {
    const { id, selection } = await start();
    const before = await (await app.request(`/api/workflow/${id}`)).json();
    expect(before).toMatchObject({ status: "failed", version: selection.version, failureOccurrences: [],
      lastContinuationDecision: { closedPacket: selection.failedPacketId, currentStep: selection.stepId } });
    const response = await post(id, { expectedFailure: selection });
    expect(response.status).toBe(200);
    const result = await response.json() as { newPacketId: string };
    expect(result).toMatchObject({ instanceId: id, stepId: "work", resumeCount: 1, ownerSession: "owner@private-rig" });
    const active = runtime.instanceStore.getByIdOrThrow(id);
    expect(active).toMatchObject({ status: "active", completedAt: null, currentFrontier: [result.newPacketId] });
    expect(runtime.inspect(id).failures).toEqual([]);
    expect(JSON.parse((db.prepare("SELECT chain_of_record FROM queue_items WHERE qitem_id=?").get(result.newPacketId) as { chain_of_record: string }).chain_of_record)).toEqual([selection.failedPacketId]);
  });

  it.each(["version", "failedPacketId", "stepId"] as const)("refuses a mismatching selected %s without any durable effects", async field => {
    const { id, selection } = await start();
    const before = snapshot();
    const response = await post(id, { expectedFailure: { ...selection, [field]: field === "version" ? selection.version + 1 : "different" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "resume_failure_changed" });
    expect(snapshot()).toEqual(before);
  });

  it("an old selection cannot redrive a newer failure episode", async () => {
    const { id, selection } = await start();
    const first = await runtime.resume({ instanceId: id, actorSession: "owner@private-rig" });
    const latest = await fail(id, first.newPacketId);
    const before = snapshot();
    const response = await post(id, { expectedFailure: selection });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "resume_failure_changed" });
    expect(snapshot()).toEqual(before);
    const fresh = await post(id, { expectedFailure: latest });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ instanceId: id, resumeCount: 2 });
  });

  it.each([null, {}, { version: 0 }, { version: -1, failedPacketId: "p", stepId: "s" },
    { version: 0.5, failedPacketId: "p", stepId: "s" }, { version: 1, failedPacketId: "", stepId: "s" },
    { version: 1, failedPacketId: "p", stepId: [] }])("rejects malformed selection %j before mutation", async expectedFailure => {
    const { id } = await start(); const before = snapshot();
    const response = await post(id, { expectedFailure });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "resume_selection_invalid" });
    expect(snapshot()).toEqual(before);
  });

  it("does not mix sequential selection with occurrence recovery", async () => {
    const { id, selection } = await start(true); const before = snapshot();
    const mixed = await post(id, { expectedFailure: selection, occurrenceId: selection.failedPacketId });
    expect(mixed.status).toBe(400);
    expect(await mixed.json()).toMatchObject({ error: "resume_selection_invalid" });
    expect(snapshot()).toEqual(before);
    const wrongFamily = await post(id, { expectedFailure: selection });
    expect(wrongFamily.status).toBe(409);
    expect(await wrongFamily.json()).toMatchObject({ error: "resume_failure_changed" });
    expect(snapshot()).toEqual(before);
    const exact = await post(id, { occurrenceId: selection.failedPacketId });
    expect(exact.status).toBe(200);
    expect(runtime.inspect(id).failures[0]?.status).toBe("resolved");
  });

  it("preserves existing unguarded sequential callers", async () => {
    const { id } = await start();
    const response = await post(id, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ instanceId: id, stepId: "work", resumeCount: 1 });
  });
});
