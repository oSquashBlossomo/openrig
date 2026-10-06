import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { nodesRoutes, sessionAdminRoutes } from "../src/routes/sessions.js";

// Real Hono + private SQLite. Inert service boundaries never contact native
// sessions, tmux/cmux, providers, records, user files or an installed daemon.
const dbs: Array<ReturnType<typeof createFullTestDb>> = [];
const identities = ["%", "%2F", "/", "日本語 ?#&", "desk.worker"];
const bearer = "fictional-terminal-auth", resumeToken = "fictional-resume-id";
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture() {
  const db = createFullTestDb(); dbs.push(db);
  const repo = new RigRepository(db), registry = new SessionRegistry(db);
  const rig = repo.createRig("private-route-identity");
  const targets = identities.map(logicalId => {
    const node = repo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    const session = registry.registerClaimedSession(node.id, logicalId);
    registry.updateBinding(node.id, { tmuxSession: logicalId });
    return { node, session };
  });
  const effects: Array<{ kind: string; nodeId: string }> = [];
  const findNode = (id: string) => repo.getRig(rig.id)?.nodes.find(n => n.logicalId === id);
  const findSession = (name: string) => registry.findResumeContextByName(name);
  const capture = vi.fn(async (name: string, options: { lines: number }) => findSession(name)
    ? { ok: true, content: `Captured exact ${name}`, lines: options.lines }
    : { ok: false, reason: "session_not_found" });
  const open = vi.fn(async (_rigId: string, id: string) => {
    const node = findNode(id); if (!node) return { ok: false, code: "not_found" };
    effects.push({ kind: "open", nodeId: node.id }); return { ok: true, nodeId: node.id };
  });
  const remove = vi.fn(async (_rigId: string, id: string, options: { fallbackDestination?: string }) => {
    const node = findNode(id); if (!node) return { ok: false, code: "node_not_found" };
    effects.push({ kind: "remove", nodeId: node.id }); repo.deleteNode(node.id);
    return { ok: true, nodeId: node.id, fallbackDestination: options.fallbackDestination };
  });
  const reconcile = vi.fn(async (input: { sessionName: string; rigId?: string; logicalId?: string }) => {
    const ctx = findSession(input.sessionName); if (!ctx) return { ok: false, code: "session_not_found" };
    effects.push({ kind: "reconcile", nodeId: ctx.nodeId });
    return { ok: true, sessionName: input.sessionName, projectionDrift: [], continuity: "unverified" };
  });
  const clear = vi.fn(async (name: string, options?: { reason: string }) => {
    const ctx = findSession(name); if (!ctx) return { ok: false, code: "not_in_attention" };
    effects.push({ kind: "clear", nodeId: ctx.nodeId }); return { ok: true, sessionName: name, reason: options?.reason };
  });
  const unclaim = vi.fn(async (name: string) => {
    const ctx = findSession(name); if (!ctx) return { ok: false, code: "session_not_found" };
    effects.push({ kind: "unclaim", nodeId: ctx.nodeId }); registry.markDetached(ctx.sessionId);
    return { ok: true, sessionName: name };
  });
  const readRecord = vi.fn(() => ({ transcriptPath: null, sessionId: null }));
  const panePid = vi.fn(), emit = vi.fn((_event: Record<string, unknown>) => {});
  const app = new Hono(); app.onError(() => new Response("route error", { status: 500 }));
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({
      rigRepo: repo, sessionRegistry: registry, terminalBearerToken: bearer,
      sessionTransport: { capture }, nodeCmuxService: { openOrFocusNodeSurface: open },
      rigLifecycleService: { removeNode: remove, unclaimSession: unclaim },
      claimService: { reconcileSession: reconcile }, podInstantiator: {},
      seatAttentionReconciler: { clearAttention: clear }, eventBus: { emit },
      tmuxAdapter: { getPanePid: panePid },
    })) c.set(key as never, value as never);
    // No resolved transcriptPath: this read cannot open any native history.
    if (c.req.path.endsWith("/generation-record")) c.set("contextUsageStore" as never, { readAndNormalize: readRecord } as never);
    await next();
  });
  app.route("/api/rigs/:rigId/nodes", nodesRoutes); app.route("/api/sessions", sessionAdminRoutes);
  return { db, repo, registry, rig, targets, effects, capture, open, remove, reconcile, clear, unclaim, readRecord, panePid, emit, app };
}
const routes = [
  { name: "detail", area: "node", suffix: "", method: "GET", status: 200 },
  { name: "node-preview", area: "node", suffix: "/preview", method: "GET", status: 200 },
  { name: "open", area: "node", suffix: "/open-cmux", method: "POST", status: 200 },
  { name: "remove", area: "node", suffix: "", method: "DELETE", status: 200 },
  { name: "session-preview", area: "session", suffix: "/preview", method: "GET", status: 200 },
  { name: "reconcile", area: "session", suffix: "/reconcile", method: "POST", status: 200 },
  { name: "clear", area: "session", suffix: "/clear-attention", method: "POST", status: 200 },
  { name: "resume-token", area: "session", suffix: "/resume-token", method: "POST", status: 200 },
  { name: "unclaim", area: "session", suffix: "/unclaim", method: "POST", status: 200 },
  { name: "record", area: "session", suffix: "/generation-record", method: "GET", status: 409 },
] as const;
type Route = typeof routes[number];
function request(f: ReturnType<typeof fixture>, route: Route, identity: string, authorization: string | null = bearer) {
  const prefix = route.area === "node" ? `/api/rigs/${f.rig.id}/nodes` : "/api/sessions";
  return f.app.request(`${prefix}/${encodeURIComponent(identity)}${route.suffix}`, {
    method: route.method,
    headers: { "Content-Type": "application/json", ...(authorization === null ? {} : { Authorization: `Bearer ${authorization}` }) },
    ...(route.method === "POST" ? { body: JSON.stringify({ reason: " exact reason ", token: resumeToken }) } : {}),
  });
}
describe.each(routes)("$name preserves already-decoded Hono identity", route => {
  it.each(identities)("targets exact %s without another decode or wrong-target effects", async identity => {
    const f = fixture(), target = f.targets.find(t => t.node.logicalId === identity)!;
    const response = await request(f, route, identity); expect(response.status).toBe(route.status);
    const body = await response.json() as Record<string, unknown>;
    if (route.name === "detail") expect(body).toMatchObject({ logicalId: identity, rigId: f.rig.id });
    else if (route.name.endsWith("preview")) {
      expect(body).toMatchObject({ sessionName: identity, content: `Captured exact ${identity}`, lines: 50 });
      expect(f.capture).toHaveBeenCalledExactlyOnceWith(identity, { lines: 50 });
    } else if (route.name === "resume-token") {
      expect(body).toMatchObject({ sessionName: identity, redacted: true, provenance: "operator" });
      const rows = f.db.prepare("SELECT id, resume_token FROM sessions").all() as Array<{ id: string; resume_token: string | null }>;
      expect(rows.filter(row => row.resume_token !== null)).toEqual([{ id: target.session.id, resume_token: resumeToken }]);
      expect(f.emit).toHaveBeenCalledOnce(); expect(f.emit.mock.calls[0]?.[0]).toMatchObject({ sessionName: identity, nodeId: target.node.id, redacted: true });
      expect(JSON.stringify([body, f.emit.mock.calls])).not.toContain(resumeToken);
    } else if (route.name === "record") {
      expect(body.error).toBe("unsupported_runtime"); expect(f.readRecord).toHaveBeenCalledExactlyOnceWith(identity);
    } else {
      expect(f.effects).toEqual([{ kind: route.name, nodeId: target.node.id }]);
      if (route.name === "remove") expect(f.repo.getRig(f.rig.id)?.nodes.map(n => n.logicalId).sort()).toEqual(identities.filter(id => id !== identity).sort());
      if (route.name === "unclaim") expect(f.db.prepare("SELECT id FROM sessions WHERE status = 'detached'").all()).toEqual([{ id: target.session.id }]);
      if (route.name === "reconcile") expect(f.reconcile).toHaveBeenCalledExactlyOnceWith({ sessionName: identity, rigId: undefined, logicalId: undefined });
      if (route.name === "clear") expect(f.clear).toHaveBeenCalledExactlyOnceWith(identity, { reason: "exact reason" });
    }
    expect(f.panePid).not.toHaveBeenCalled();
  });
});
const guarded = routes.filter(route => route.name !== "detail" && route.name !== "remove");
describe.each(guarded)("$name bearer admission", route => {
  it.each([null, "wrong-fictional-auth"])("refuses %s before reads/effects or resume writes", async authorization => {
    const f = fixture(); expect((await request(f, route, "%2F", authorization)).status).toBe(401);
    for (const spy of [f.capture, f.open, f.remove, f.reconcile, f.clear, f.unclaim, f.readRecord, f.panePid, f.emit]) expect(spy).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]); expect(f.db.prepare("SELECT id FROM sessions WHERE resume_token IS NOT NULL").all()).toEqual([]);
  });
});
it.each(routes.filter(route => route.name !== "record"))("$name missing exact target never substitutes a decodable sibling", async route => {
  const f = fixture(), target = f.targets.find(t => t.node.logicalId === "%2F")!; f.repo.deleteNode(target.node.id);
  const response = await request(f, route, "%2F");
  expect(response.status).toBe(route.name === "session-preview" ? 502 : route.name === "clear" ? 409 : 404);
  expect(f.effects).toEqual([]); expect(f.db.prepare("SELECT id FROM sessions WHERE resume_token IS NOT NULL").all()).toEqual([]);
  expect(f.repo.getRig(f.rig.id)?.nodes.some(n => n.logicalId === "/")).toBe(true);
});
it("a Codex generation read keeps exact identity and rejects unverified pane binding before any native observation", async () => {
  const f = fixture(), target = f.targets.find(t => t.node.logicalId === "%2F")!;
  f.db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(target.node.id);
  const response = await request(f, routes.find(route => route.name === "record")!, "%2F");
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "record_identity_unverified" });
  expect(f.readRecord).not.toHaveBeenCalled(); expect(f.panePid).not.toHaveBeenCalled();
});
