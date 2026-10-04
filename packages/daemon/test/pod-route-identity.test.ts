import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { rigsRoutes } from "../src/routes/rigs.js";

const names = ["%", "%2F", "/", "日本語 ?#&", "ordinary-pod"];
const dbs: Array<ReturnType<typeof createFullTestDb>> = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture() {
  const db = createFullTestDb(); dbs.push(db);
  const repo = new RigRepository(db), pods = new PodRepository(db), registry = new SessionRegistry(db);
  const eventBus = new EventBus(db), rig = repo.createRig("private-pod-identity");
  const targets = names.map(name => pods.createPod(rig.id, name, `Pod ${name}`));
  const effects: string[] = [];
  // Isolate only native launch. Lookup and persistence use private real repositories.
  const addMemberToPod = vi.fn(async (rigId: string, name: string, member: Record<string, unknown>, _root: string, options: unknown) => {
    const pod = pods.getPodByNamespace(rigId, name);
    if (!pod) return { ok: false, code: "pod_not_found" };
    const node = repo.addNode(rigId, `${name}.${member.id}`, { runtime: "terminal" });
    db.prepare("UPDATE nodes SET pod_id = ? WHERE id = ?").run(pod.id, node.id);
    effects.push(pod.id);
    return { ok: true, result: { podNamespace: name, node: { nodeId: node.id, logicalId: node.logicalId, status: "materialized" }, options } };
  });
  const lifecycle = new RigLifecycleService({
    db, rigRepo: repo, sessionRegistry: registry, discoveryRepo: new DiscoveryRepository(db), eventBus,
    // Empty pods have no queue members; prohibit unexpected queue mutation/native work.
    queueRepo: { db } as never,
  });
  const shrink = vi.spyOn(lifecycle, "shrinkPod");
  const app = new Hono(); app.onError(() => new Response("route error", { status: 500 }));
  app.use("*", async (c, next) => {
    c.set("podInstantiator" as never, { addMemberToPod } as never);
    c.set("rigLifecycleService" as never, lifecycle as never); await next();
  });
  app.route("/api/rigs", rigsRoutes);
  const request = (name: string, method: "POST" | "DELETE", body: unknown = { member: { id: "worker", runtime: "terminal", agent_ref: "builtin:terminal" }, rigRoot: "/fictional-root", edges: [] }) => app.request(`/api/rigs/${rig.id}/pods/${encodeURIComponent(name)}${method === "POST" ? "/members" : ""}`, {
    method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  return { db, repo, pods, rig, targets, effects, addMemberToPod, shrink, request };
}

describe("pod routes preserve Hono-decoded exact targets", () => {
  it.each(names)("add member to exact namespace %s", async name => {
    const f = fixture(), pod = f.targets.find(pod => pod.namespace === name)!;
    const response = await f.request(name, "POST"); expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ result: { podNamespace: name, node: { logicalId: `${name}.worker` } } });
    expect(f.effects).toEqual([pod.id]);
    expect(f.addMemberToPod).toHaveBeenCalledExactlyOnceWith(f.rig.id, name, { id: "worker", runtime: "terminal", agent_ref: "builtin:terminal" }, "/fictional-root", { cwdOverride: undefined, edges: [] });
    expect(f.db.prepare("SELECT pod_id FROM nodes").all()).toEqual([{ pod_id: pod.id }]);
    // These namespace bytes are accepted by the actual schema.
    expect(PodRigSpecSchema.validate({ version: "0.2", name: "private", pods: [{ id: name, label: "Private", members: [{ id: "worker", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" }], edges: [] }], edges: [] }).valid).toBe(true);
  });
  it.each(names)("DELETE exact namespace %s with real empty-pod lifecycle", async name => {
    const f = fixture(), target = f.targets.find(pod => pod.namespace === name)!;
    const response = await f.request(name, "DELETE"); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ podId: target.id, namespace: name, removedLogicalIds: [], sessionsKilled: 0 });
    expect(f.shrink).toHaveBeenCalledExactlyOnceWith(f.rig.id, name, { fallbackDestination: undefined });
    expect(f.pods.getPodsForRig(f.rig.id).map(pod => pod.namespace).sort()).toEqual(names.filter(value => value !== name).sort());
    expect(f.db.prepare("SELECT payload FROM events WHERE type = 'pod.deleted'").all()).toEqual([{ payload: JSON.stringify({ type: "pod.deleted", rigId: f.rig.id, podId: target.id }) }]);
  });
  it.each(["POST", "DELETE"] as const)("missing literal %%2F never changes slash sibling (%s)", async method => {
    const f = fixture(), target = f.targets.find(pod => pod.namespace === "%2F")!; f.pods.deletePod(target.id);
    const response = await f.request("%2F", method); expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "pod_not_found" });
    expect(f.effects).toEqual([]); expect(f.pods.getPodByNamespace(f.rig.id, "/")).not.toBeNull();
    expect(f.db.prepare("SELECT id FROM nodes").all()).toEqual([]);
    expect(f.db.prepare("SELECT seq FROM events WHERE type = 'pod.deleted'").all()).toEqual([]);
  });
  it("DELETE exact generated pod ID remains supported", async () => {
    const f = fixture(), pod = f.targets[0]!;
    const response = await f.request(pod.id, "DELETE"); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ podId: pod.id, namespace: "%" });
  });
  it("malformed member/edges fail before converging even on percent identity", async () => {
    const f = fixture();
    expect((await f.request("%2F", "POST", { member: [] })).status).toBe(400);
    expect((await f.request("%2F", "POST", { member: { id: "worker" }, edges: "wrong" })).status).toBe(400);
    expect(f.addMemberToPod).not.toHaveBeenCalled(); expect(f.effects).toEqual([]);
  });
});
