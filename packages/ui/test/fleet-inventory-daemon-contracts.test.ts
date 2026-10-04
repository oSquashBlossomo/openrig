// @vitest-environment node
// Actual Hono/private in-memory SQLite and origin read-through; no listeners,
// installed state, native processes or user files.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFullTestDb, createTestApp } from "../../daemon/test/helpers/test-app.js";
import { hostReadThrough } from "../../daemon/src/domain/hosts/read-through.js";
import { readNodeInventory, readPsEntries } from "../src/lib/fleet-inventory-reads.js";
import { topologyRead, isTopologyGraph, isTopologyRigSummary } from "../src/lib/topology-read.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("fleet inventory actual daemon projections", () => {
  it("accepts actual nullable seats, process rows and partial graph contracts through the selected origin", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db); const rig = setup.rigRepo.createRig("private-fleet-read");
      const seat = setup.rigRepo.addNode(rig.id, "unconfigured.agent"); const forwarded: string[] = []; let localHits = 0;
      const edge = new Hono(); edge.use("*", async (c, next) => {
        c.set("hostRegistryLoader" as never, (() => ({ ok: true, registry: { hosts: [{ id: "remote/exact", transport: "http", url: "http://private-origin.invalid" }] } })) as never);
        c.set("remoteFetchImpl" as never, (async (input: string, init?: RequestInit) => {
          const url = new URL(input); forwarded.push(url.pathname + url.search); return setup.app.request(url.pathname + url.search, init);
        }) as never); await next();
      }); edge.use("/api/*", hostReadThrough()); edge.all("*", c => { localHits++; return c.json({ error: "no local fallback" }, 500); });
      vi.stubGlobal("fetch", vi.fn((route: string, options?: RequestInit) => edge.request(route, options)));
      const nodes = await readNodeInventory(rig.id, "remote/exact");
      expect(nodes).toHaveLength(1); expect(nodes[0]).toMatchObject({ rigId: rig.id, logicalId: seat.logicalId, runtime: null, canonicalSessionName: null,
        sessionStatus: null, startupStatus: null, latestError: null, hasAssignedWork: false });
      expect(nodes[0]?.terminalActive).toBeUndefined();
      expect(nodes[0]).toHaveProperty("occupantLifecycle"); expect(nodes[0]).toHaveProperty("hostSelfId");
      const processes = await readPsEntries("remote/exact"); expect(processes).toHaveLength(1);
      expect(processes[0]).toMatchObject({ rigId: rig.id, name: rig.name, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null });
      expect(processes[0]).toHaveProperty("rigName", rig.name); expect(processes[0]).toHaveProperty("attentionCount", 0);
      await expect(topologyRead(`/api/rigs/${rig.id}/graph`, "remote/exact", undefined, isTopologyGraph)).resolves.toMatchObject({ nodes: expect.any(Array), edges: [] });
      await expect(topologyRead("/api/rigs/summary", "remote/exact", undefined, isTopologyRigSummary)).resolves.toMatchObject([{ id: rig.id, name: rig.name }]);
      await expect(readNodeInventory(rig.id, "unknown/origin")).rejects.toMatchObject({ code: "http", status: 502, serverCode: "remote_read_failed" });
      await expect(readNodeInventory("missing-rig", "remote/exact")).rejects.toMatchObject({ code: "http", status: 404 });
      expect(forwarded.every(path => !path.includes("host="))).toBe(true); expect(localHits).toBe(0);
      expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});
