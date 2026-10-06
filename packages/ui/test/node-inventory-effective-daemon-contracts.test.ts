// @vitest-environment node
// Private SQLite and directly mounted read routes; no listeners/native providers.
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { nodesRoutes } from "../../daemon/src/routes/sessions.js";
import { readNodeInventory } from "../src/lib/fleet-inventory-reads.js";
import { readNodeDetail } from "../src/lib/node-library-reads.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("accepts already-served exact effective bindings and nullable/unconfigured sibling facts", async () => {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS);
    const repo = new RigRepository(db), rig = repo.createRig("private-effective-contract");
    const configured = repo.addNode(rig.id, "bound%seat", { resolvedSpecName: "exact:name", resolvedSpecVersion: "1:2", resolvedSpecHash: "served:hash" });
    const unconfigured = repo.addNode(rig.id, "unconfigured");
    const app = new Hono(); app.use("*", async (c, next) => { c.set("rigRepo" as never, repo as never); await next(); });
    app.route("/api/rigs/:rigId/nodes", nodesRoutes);
    vi.stubGlobal("fetch", vi.fn((route: string, options?: RequestInit) => app.request(route, options)));
    const inventory = await readNodeInventory(rig.id, "local");
    const bound = inventory.find(row => row.logicalId === configured.logicalId);
    expect(bound).toMatchObject({ resolvedSpecName: "exact:name", resolvedSpecVersion: "1:2", resolvedSpecHash: "served:hash" });
    expect(["running", "detached", "recoverable", "attention_required"]).toContain(bound?.lifecycleState);
    expect(inventory.find(row => row.logicalId === unconfigured.logicalId)).toMatchObject({
      resolvedSpecName: null, resolvedSpecVersion: null, resolvedSpecHash: null, canonicalSessionName: null, runtime: null,
    });
    expect(bound).toHaveProperty("occupantLifecycle"); expect(bound).toHaveProperty("hostSelfId");
    const detail = await readNodeDetail(rig.id, configured.logicalId, "local");
    expect(detail).toMatchObject({ rigId: rig.id, logicalId: configured.logicalId,
      resolvedSpecName: "exact:name", resolvedSpecVersion: "1:2", resolvedSpecHash: "served:hash" });
    expect(detail).toHaveProperty("occupantLifecycle");
  } finally { db.close(); }
});
