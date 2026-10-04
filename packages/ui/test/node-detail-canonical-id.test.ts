// @vitest-environment node
// Canonical Health seat identity read prerequisite; no listener/native provider.
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { nodesRoutes } from "../../daemon/src/routes/sessions.js";
import { isNodeDetail, readNodeDetail } from "../src/lib/node-library-reads.js";

const base = { rigId: "rig%exact", rigName: "Private", logicalId: "seat:logical%2F", podId: null,
  canonicalSessionName: "other-session@Private", nodeKind: "agent", runtime: null, sessionStatus: null,
  startupStatus: null, restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, recoveryGuidance: null,
  latestError: null, model: null, agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: null,
  startupFiles: [], startupActions: [], recentEvents: [], infrastructureStartupCommand: null, peers: [],
  edges: { outgoing: [], incoming: [] }, transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 } };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("optional served canonical node identity", () => {
  it.each([null, 0, false, {}, []])("refuses supplied invalid nodeId %j rather than admitting it as a Health seat key", async nodeId => {
    const value = { ...base, nodeId };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => value })));
    expect(isNodeDetail(value)).toBe(false);
    await expect(readNodeDetail(base.rigId, base.logicalId, "local")).rejects.toMatchObject({ code: "invalid_contract" });
  });
  it.each([undefined, "", " ", " canonical:01 /%2F雪 "])("preserves compatible raw/unknown nodeId %j without logical/session fallback", async nodeId => {
    const value = nodeId === undefined ? { ...base } : { ...base, nodeId };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => value })));
    expect(isNodeDetail(value)).toBe(true);
    const observed = await readNodeDetail(base.rigId, base.logicalId, "local");
    expect(observed).toBe(value);
    if (nodeId === undefined) expect(observed).not.toHaveProperty("nodeId");
    else expect(observed).toHaveProperty("nodeId", nodeId);
    expect(observed.logicalId).toBe(base.logicalId); expect(observed.canonicalSessionName).toBe(base.canonicalSessionName);
    expectTypeOf(observed.nodeId).toEqualTypeOf<string | undefined>();
  });
  it("rejects invalid replacement bytes without changing the previously returned original DTO", async () => {
    const valid = { ...base, nodeId: "canonical%seat", futureFact: { preserved: true } };
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => valid })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...valid, nodeId: 12 }) });
    vi.stubGlobal("fetch", fetch);
    expect(await readNodeDetail(base.rigId, base.logicalId, "local")).toBe(valid);
    await expect(readNodeDetail(base.rigId, base.logicalId, "local")).rejects.toMatchObject({ code: "invalid_contract" });
    expect(valid.nodeId).toBe("canonical%seat"); expect(valid.futureFact).toEqual({ preserved: true });
  });
  it("reads the actual Hono/private SQLite canonical ID independently of logical/session address", async () => {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const repo = new RigRepository(db), rig = repo.createRig("private-canonical-node-read");
      const node = repo.addNode(rig.id, "logical%2F:雪");
      const exactId = " canonical:01 /%2F雪 ";
      // Real private canonical row identity; no bindings, sessions or native calls.
      db.prepare("UPDATE nodes SET id = ? WHERE id = ?").run(exactId, node.id);
      const app = new Hono(); app.use("*", async (c, next) => { c.set("rigRepo" as never, repo as never); await next(); });
      app.route("/api/rigs/:rigId/nodes", nodesRoutes);
      const route = `/api/rigs/${encodeURIComponent(rig.id)}/nodes/${encodeURIComponent(node.logicalId)}`;
      const response = await app.request(route); expect(response.status).toBe(200);
      const served = await response.json() as Record<string, unknown>;
      expect(served.nodeId).toBe(exactId); expect(served.logicalId).toBe(node.logicalId); expect(served.canonicalSessionName).toBeNull();
      vi.stubGlobal("fetch", vi.fn((input: string, options?: RequestInit) => app.request(input, options)));
      const observed = await readNodeDetail(rig.id, node.logicalId, "local");
      expect(observed.nodeId).toBe(exactId); expect(observed.logicalId).not.toBe(exactId);
      expect(observed).toHaveProperty("hostSelfId"); expect(observed.runtime).toBeNull();
    } finally { db.close(); }
  });
});
