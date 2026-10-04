// @vitest-environment node
// Actual Hono/private SQLite/YAML + in-process read-through origin. No listener,
// installed fleet, native launch or home writes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFullTestDb, createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { coreSchema } from "../../daemon/src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../../daemon/src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache } from "../../daemon/src/domain/workflow-spec-cache.js";
import { SpecLibraryService } from "../../daemon/src/domain/spec-library-service.js";
import { SpecReviewService } from "../../daemon/src/domain/spec-review-service.js";
import { specLibraryRoutes } from "../../daemon/src/routes/spec-library.js";
import { hostReadThrough } from "../../daemon/src/domain/hosts/read-through.js";
import { readNodeDetail, readLibraryEntries, readLibraryReview } from "../src/lib/node-library-reads.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function connectedEdge(origin: Hono) {
  const forwarded: string[] = []; let localHits = 0; const edge = new Hono();
  edge.use("*", async (c, next) => {
    c.set("hostRegistryLoader" as never, (() => ({ ok: true, registry: { hosts: [{ id: "remote/exact", transport: "http", url: "http://private-origin.invalid" }] } })) as never);
    c.set("remoteFetchImpl" as never, (async (input: string, init?: RequestInit) => { const url = new URL(input); forwarded.push(url.pathname + url.search); return origin.request(url.pathname + url.search, init); }) as never);
    await next();
  });
  edge.use("/api/*", hostReadThrough());
  edge.all("*", c => { localHits++; return c.json({ error: "local branch must not substitute for remote" }, 500); });
  vi.stubGlobal("fetch", vi.fn((route: string, options?: RequestInit) => edge.request(route, options)));
  return { forwarded, localHits: () => localHits };
}
describe("node/library readers against actual daemon contracts", () => {
  it("reads a nullable private seat remotely and never falls back on unknown host or missing seat", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db); const rig = setup.rigRepo.createRig("private-node-library"); const node = setup.rigRepo.addNode(rig.id, "unconfigured.agent");
      const edge = connectedEdge(setup.app); const observed = await readNodeDetail(rig.id, node.logicalId, "remote/exact");
      expect(observed).toMatchObject({ rigId: rig.id, logicalId: node.logicalId, runtime: null, model: null, canonicalSessionName: null, transcript: { enabled: false, path: null, tailCommand: null } });
      expect(observed).toHaveProperty("occupantLifecycle"); expect(observed).toHaveProperty("hostSelfId");
      await expect(readNodeDetail(rig.id, "wrong.agent", "remote/exact")).rejects.toMatchObject({ code: "http", status: 404 });
      await expect(readNodeDetail(rig.id, node.logicalId, "unknown/registry/id")).rejects.toMatchObject({ code: "http", status: 502, serverCode: "remote_read_failed" });
      expect(edge.forwarded).toHaveLength(2); expect(edge.forwarded.every(path => !path.includes("host="))).toBe(true); expect(edge.localHits()).toBe(0); expect(setup.tmuxAdapter.createSession).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it("accepts actual opaque rig/agent IDs and canonical source provenance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gui-node-library-contract-"));
    try {
      writeFileSync(join(dir, "rig.yaml"), 'version: "0.2"\nname: private-rig\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: worker\n        agent_ref: local:agents/private-agent\n        runtime: codex\n        profile: default\n        cwd: /private/inert-workspace\n    edges: []\nedges: []\n');
      writeFileSync(join(dir, "agent.yaml"), 'version: "1"\nname: private-agent\nprofiles:\n  default: {}\nresources: {}\nstartup: {}\n');
      const svc = new SpecReviewService(); svc.reviewRigSpec(readFileSync(join(dir, "rig.yaml"), "utf8"), "library_item"); const lib = new SpecLibraryService({ roots: [{ path: dir, sourceType: "user_file" }], specReviewService: svc }); lib.scan();
      const origin = new Hono(); origin.use("*", async (c, next) => { c.set("specLibraryService" as never, lib as never); c.set("specReviewService" as never, svc as never); await next(); }); origin.route("/api/specs/library", specLibraryRoutes());
      const edge = connectedEdge(origin); const entries = await readLibraryEntries(undefined, "remote/exact"); expect(entries).toHaveLength(2); expect(entries.map(e => e.kind).sort()).toEqual(["agent", "rig"]);
      for (const entry of entries) {
        expect(entry.id).not.toBe(entry.name); expect(entry.updatedAt).toEqual(expect.any(String)); expect(entry.resolvedSourcePath).toBe(realpathSync(entry.sourcePath));
        const review = await readLibraryReview(entry.id, "remote/exact"); expect(review).toMatchObject({ libraryEntryId: entry.id, kind: entry.kind, name: entry.name, sourcePath: entry.sourcePath, sourceState: "library_item" });
        if (review.kind === "agent") expect(review.resources).toHaveProperty("subagents", []);
      }
      expect(await readLibraryEntries("agent", "remote/exact")).toHaveLength(1);
      await expect(readLibraryReview("private-agent", "remote/exact")).rejects.toMatchObject({ code: "http", status: 404 }); expect(edge.localHits()).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("reads opaque colon-version workflow cache identity without inventing sourceState", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gui-library-workflow-contract-")); const db = createDb();
    try {
      migrate(db, [coreSchema, workflowSpecsSchema]); const path = join(dir, "workflow.yaml");
      writeFileSync(path, 'workflow:\n  id: private-workflow\n  version: "1:exact"\n  objective: Private review\n  roles:\n    worker: {}\n  steps:\n    - id: exact-step\n      actor_role: worker\n      allowed_exits: [done]\n  invariants:\n    allowed_exits: [done]\n');
      new WorkflowSpecCache(db).readThrough(path); const svc = new SpecReviewService(); const lib = new SpecLibraryService({ roots: [], specReviewService: svc });
      const origin = new Hono(); origin.use("*", async (c, next) => { c.set("specLibraryService" as never, lib as never); c.set("specReviewService" as never, svc as never); c.set("rigRepo" as never, { db } as never); await next(); }); origin.route("/api/specs/library", specLibraryRoutes());
      connectedEdge(origin); const entries = await readLibraryEntries("workflow", "remote/exact"); expect(entries).toHaveLength(1); expect(entries[0]!.id).toMatch(/^workflow:@/);
      const review = await readLibraryReview(entries[0]!.id, "remote/exact"); expect(review).toMatchObject({ libraryEntryId: entries[0]!.id, kind: "workflow", version: "1:exact", targetRig: null, sourcePath: path });
      expect(review).not.toHaveProperty("sourceState"); expect(review).not.toHaveProperty("raw");
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
