// @vitest-environment node
// Actual Hono/private SQLite contracts. No listener, native process, or installed fleet.
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { WorkflowRuntime } from "../../daemon/src/domain/workflow-runtime.js";
import { workflowRoutes } from "../../daemon/src/routes/workflow.js";
import { abortWorkflow, resumeWorkflowOccurrence } from "../src/hooks/useWorkflowMutations.js";
const local = { kind: "local-instance" } as const;
const input = { reason: " exact\nabort reason ", actorSession: "human@host" };
const dbs: any[] = [], dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); dbs.splice(0).forEach(db => db.close()); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "openrig-abort-contract-")); dirs.push(dir);
  const specPath = join(dir, "workflow.yaml");
  writeFileSync(specPath, `workflow:
  id: abort-review-parallel
  version: 1
  entry: { role: root }
  roles:
    root: { preferred_targets: [root@rig] }
    left: { preferred_targets: [left@rig] }
    right: { preferred_targets: [right@rig] }
  exception_routing: { orchestrator_role: root }
  steps:
    - id: root
      actor_role: root
      allowed_exits: [done, failed]
    - id: left
      actor_role: left
      depends_on: [root]
      allowed_exits: [done, failed]
    - id: right
      actor_role: right
      depends_on: [root]
      allowed_exits: [done, failed]
`);
  const db = createDb(); dbs.push(db); migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('private-abort-rig', 'rig')").run();
  const bus = new EventBus(db), queue = new QueueRepository(db, bus, { validateRig: () => true }); queue.attachOutbox(new OutboxHandler(db));
  const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
  const created = await runtime.instantiate({ specPath, rootObjective: "private fixture only", createdBySession: "orch@rig" });
  const id = created.instance.instanceId;
  await runtime.project({ instanceId: id, currentPacketId: created.entryQitemId, exit: "done", actorSession: "root@rig" });
  const packetIds = runtime.inspect(id).instance.currentFrontier;
  expect(packetIds).toHaveLength(2);
  const app = new Hono(); app.use("*", async (c, next) => { c.set("eventBus", bus); c.set("workflowRuntime", runtime); await next(); }); app.route("/api/workflow", workflowRoutes());
  const receipts: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (route: string, options: RequestInit) => { const response = await app.request(route, options); receipts.push({ status: response.status, body: await response.clone().json(), input: JSON.parse(options.body as string) }); return response; }));
  return { db, bus, queue, runtime, id, packetIds, receipts };
}
it("actual route success aborts both exact frontier packets and retains exact reason/actor; repeat is rejected", async () => {
  const f = await fixture(); const result = await abortWorkflow(local, f.id, input);
  expect(result).toEqual({ instanceId: f.id, closedPacketIds: f.packetIds, status: "aborted" });
  expect(f.runtime.inspect(f.id).instance.lastContinuationDecision).toMatchObject({ action: "abort", ...input, closedPacketIds: f.packetIds });
  expect(f.packetIds.map(id => f.queue.getById(id)?.state)).toEqual(["canceled", "canceled"]);
  await expect(abortWorkflow(local, f.id, input)).rejects.toMatchObject({ code: "rejected", status: 409, serverCode: "instance_not_abortable" });
});
it("actual missing frontier binding is a known rejection and rolls back an earlier frontier closure", async () => {
  const f = await fixture(); (f.runtime as any).instanceStore.removeFrontierBinding(f.id, f.packetIds[1]);
  const before = f.runtime.inspect(f.id).instance;
  await expect(abortWorkflow(local, f.id, input)).rejects.toMatchObject({ code: "rejected", status: 409, serverCode: "frontier_binding_indeterminate" });
  expect(f.runtime.inspect(f.id).instance).toEqual(before);
  expect(f.packetIds.map(id => f.queue.getById(id)?.state)).toEqual(["pending", "pending"]);
});
it("actual packet_not_found 404 before commit should be rejected, not an uncertain abort", async () => {
  const f = await fixture(); const readPacket = f.queue.getById.bind(f.queue);
  // Model the source repository's missing second frontier packet branch; the
  // first packet was already processed inside the transaction and must roll back.
  vi.spyOn(f.queue, "getById").mockImplementation(id => id === f.packetIds[1] ? null : readPacket(id));
  const before = f.runtime.inspect(f.id).instance;
  const error = await abortWorkflow(local, f.id, input).catch(e => e);
  expect(f.receipts[0]).toMatchObject({ status: 404, body: { error: "packet_not_found", packetId: f.packetIds[1] } });
  expect(f.runtime.inspect(f.id).instance).toEqual(before);
  expect(f.packetIds.map(id => readPacket(id)?.state)).toEqual(["pending", "pending"]);
  expect(error.code).toBe("rejected");
});
it("actual post-commit notify-drain failure stays unknown with immutable original attempt", async () => {
  const f = await fixture(); (f.bus as any).drainNotifyRowsToQuiescence = () => { throw new Error("private post-commit notify failure"); };
  const mutable = { ...input }; const error = await abortWorkflow(local, f.id, mutable).catch(e => e); mutable.reason = "later edits";
  expect(f.runtime.inspect(f.id).instance.status).toBe("aborted");
  expect(error).toMatchObject({ code: "outcome_unknown", status: 500, serverCode: "internal_error", attempt: { instanceId: f.id, kind: "abort", payload: input } });
  expect(Object.isFrozen(error.attempt)).toBe(true); expect(Object.isFrozen(error.attempt.payload)).toBe(true); expect(f.receipts).toHaveLength(1);
});
it("one total 5-second header/body budget cancels and retains exact abort bytes without retry", async () => {
  vi.useFakeTimers(); let resolve!: (response: any) => void; const cancel = vi.fn(async () => {});
  const caller = new AbortController(), remove = vi.spyOn(caller.signal, "removeEventListener");
  const fetch = vi.fn(() => new Promise(r => { resolve = r; })); vi.stubGlobal("fetch", fetch);
  const mutable = { ...input }; const pending = abortWorkflow(local, "wf/exact", mutable, { signal: caller.signal }).catch(e => e); mutable.reason = "later";
  await vi.advanceTimersByTimeAsync(4000); resolve({ ok: true, status: 200, json: () => new Promise(() => {}), body: { cancel } });
  await vi.advanceTimersByTimeAsync(1000); const error = await pending;
  expect(error).toMatchObject({ code: "outcome_unknown", status: 200, attempt: { kind: "abort", payload: input } });
  expect((fetch.mock.calls[0] as any)[1].signal.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("pre-dispatch cancellation and remote scope do not POST; post-dispatch cancellation stays unknown", async () => {
  const fetch = vi.fn(() => new Promise(() => {})); vi.stubGlobal("fetch", fetch);
  const pre = new AbortController(); pre.abort();
  await expect(abortWorkflow(local, "wf/exact", input, { signal: pre.signal })).rejects.toMatchObject({ code: "cancelled" });
  await expect(abortWorkflow({ kind: "remote-instance", hostId: "elsewhere" }, "wf/exact", input)).rejects.toMatchObject({ code: "unsupported_scope" }); expect(fetch).not.toHaveBeenCalled();
  const post = new AbortController(), pending = abortWorkflow(local, "wf/exact", input, { signal: post.signal }); post.abort();
  await expect(pending).rejects.toMatchObject({ code: "outcome_unknown", attempt: { kind: "abort", payload: input } }); expect(fetch).toHaveBeenCalledOnce();
});
it.each([400, 409, 500])("requires abort's exact packet_not_found status, keeping HTTP %i uncertain", async status => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "packet_not_found" }), { status }));
  vi.stubGlobal("fetch", fetch);
  await expect(abortWorkflow(local, "wf/exact", input)).rejects.toMatchObject({ code: "outcome_unknown", status, serverCode: "packet_not_found" });
  expect(fetch).toHaveBeenCalledOnce();
});
it("does not extend abort-only rollback evidence to another operation", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "packet_not_found" }), { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  await expect(resumeWorkflowOccurrence(local, "wf/exact", { occurrenceId: "exact-occurrence", actorSession: input.actorSession }))
    .rejects.toMatchObject({ code: "outcome_unknown", status: 404, serverCode: "packet_not_found", attempt: { kind: "resume" } });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each([
  { instanceId: "wrong-instance", status: "aborted", closedPacketIds: [] },
  { instanceId: "wf/exact", status: "waiting", closedPacketIds: [] },
  { instanceId: "wf/exact", status: "aborted", closedPacketIds: [null] },
])("retains the exact uncertain attempt for an invalid abort receipt %j", async receipt => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await expect(abortWorkflow(local, "wf/exact", input)).rejects.toMatchObject({ code: "outcome_unknown", attempt: { instanceId: "wf/exact", kind: "abort", payload: input } });
  expect(fetch).toHaveBeenCalledOnce();
});
it("rejects missing actor/reason/instance before dispatch", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(abortWorkflow(local, "wf/exact", { ...input, actorSession: " " })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(abortWorkflow(local, "wf/exact", { ...input, reason: " " })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(abortWorkflow(local, " ", input)).rejects.toMatchObject({ code: "invalid_request" });
  expect(fetch).not.toHaveBeenCalled();
});
