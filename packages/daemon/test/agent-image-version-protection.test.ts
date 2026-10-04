import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService, agentImageId } from "../src/domain/agent-images/agent-image-library-service.js";
import { evaluateProtection } from "../src/domain/agent-images/evidence-guard.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";

interface Fixture { id: string; path: string; }

describe("agent-image version protection", () => {
  let temp: string;
  let imageRoot: string;
  let specRoot: string;
  let lib: AgentImageLibraryService;
  let app: Hono;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "agent-image-version-protection-"));
    imageRoot = join(temp, "images");
    specRoot = join(temp, "specs");
    mkdirSync(imageRoot);
    mkdirSync(specRoot);
    lib = new AgentImageLibraryService({ roots: [{ path: imageRoot, sourceType: "user_file" }] });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentImageLibrary" as never, lib);
      await next();
    });
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [specRoot] }));
  });
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  function seed(name: string, version: string, lineage: string[] = []): Fixture {
    const path = join(imageRoot, `${name}-${version}`);
    mkdirSync(path);
    writeFileSync(join(path, "manifest.yaml"), JSON.stringify({
      name, version, lineage, runtime: "claude-code", source_seat: "fixture",
      source_session_id: "fixture-session", source_resume_token: "private-fixture-token", files: [],
    }));
    return { id: agentImageId(name, version), path };
  }
  function scan(expected: number): void {
    expect(lib.scan()).toEqual({ count: expected, errors: [] });
  }
  function statuses(reverse = false) {
    const images = lib.list();
    if (reverse) images.reverse();
    const result = evaluateProtection({ images, specRoots: [specRoot] });
    expect(result.map(p => p.imageId)).toEqual(images.map(img => img.id));
    expect(result.map(p => p.imageVersion)).toEqual(images.map(img => img.version));
    return result;
  }
  function request(fixture: Fixture, suffix = "", method = "DELETE") {
    return app.request(`/api/agent-images/library/${encodeURIComponent(fixture.id)}${suffix}`, { method });
  }
  function prune(body: { dryRun: boolean; force?: boolean }) {
    return app.request("/api/agent-images/prune", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }
  function reference(filename: string, name: string): string {
    const path = join(specRoot, filename);
    writeFileSync(path, JSON.stringify({
      name: "reference", session_source: { mode: "agent_image", ref: { kind: "image_name", value: name } },
    }));
    return path;
  }

  for (const version of ["1", "2"]) {
    it.each([false, true])(`pin version ${version} is independent of input reorder=%s`, reverse => {
      const first = seed("worker", "1"), second = seed("worker", "2");
      scan(2);
      const pinned = version === "1" ? first : second, unpinned = version === "1" ? second : first;
      lib.pin(pinned.id);
      const result = statuses(reverse);
      expect(result.find(p => p.imageId === pinned.id)).toMatchObject({ protected: true, reasons: ["pinned"] });
      expect(result.find(p => p.imageId === unpinned.id)).toMatchObject({ protected: false, reasons: [], references: [] });
    });
  }

  it("unpin changes only that version's independent protection", async () => {
    const first = seed("worker", "1"), second = seed("worker", "2");
    scan(2);
    lib.pin(first.id);
    lib.pin(second.id);
    const response = await request(first, "/unpin", "POST");
    expect(response.status).toBe(200);
    expect(existsSync(join(first.path, ".pinned"))).toBe(false);
    expect(existsSync(join(second.path, ".pinned"))).toBe(true);
    expect(statuses().map(p => ({ id: p.imageId, protected: p.protected }))).toEqual([
      { id: first.id, protected: false }, { id: second.id, protected: true },
    ]);
  });

  it.each(["agent.yaml", "rig.yaml"])("name reference from %s protects both exact versions", async filename => {
    const first = seed("worker", "1"), second = seed("worker", "2");
    scan(2);
    const path = reference(filename, "worker");
    const reason = filename === "agent.yaml" ? "referenced_by_agent_spec" : "referenced_by_rig_spec";
    for (const reverse of [false, true]) {
      const result = statuses(reverse);
      expect(result).toHaveLength(2);
      for (const status of result) expect(status).toMatchObject({ protected: true, reasons: [reason], references: [path] });
    }
    for (const fixture of [first, second]) {
      const response = await request(fixture);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "image_referenced", reasons: [reason], references: [path] });
    }
    const forced = await request(first, "?force=true");
    expect(forced.status).toBe(200);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(true);
    expect((await request(second)).status).toBe(409);
  });

  it.each([false, true])("any protected version conservatively protects name-based lineage transitively under reorder=%s", reverse => {
    const ancestor = seed("ancestor", "1"), otherAncestor = seed("ancestor", "2");
    const child = seed("child", "1", ["ancestor"]), otherChild = seed("child", "2");
    const grandchild = seed("grandchild", "1", ["child"]), unrelated = seed("unrelated", "1");
    scan(6);
    lib.pin(ancestor.id);
    const result = statuses(reverse);
    expect(result.find(p => p.imageId === ancestor.id)).toMatchObject({ protected: true, reasons: ["pinned"] });
    for (const fixture of [otherAncestor, otherChild, unrelated]) {
      expect(result.find(p => p.imageId === fixture.id)).toMatchObject({ protected: false, reasons: [], references: [] });
    }
    for (const [fixture, name] of [[child, "ancestor"], [grandchild, "child"]] as const) {
      expect(result.find(p => p.imageId === fixture.id)).toMatchObject({
        protected: true, reasons: ["lineage_descendant_of_protected"], references: [`lineage-of:${name}`],
      });
    }
  });

  it.each(["1", "2"])("prune dry-run and actual prune preserve pinned version %s and remove only evictable versions", async version => {
    const first = seed("worker", "1"), second = seed("worker", "2"), unrelated = seed("unrelated", "1");
    scan(3);
    const pinned = version === "1" ? first : second, evictable = version === "1" ? second : first;
    lib.pin(pinned.id);
    const preview = await prune({ dryRun: true });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { protected: Array<{ imageId: string }>; evictable: Array<{ imageId: string }> };
    expect(previewBody.protected.map(p => p.imageId)).toEqual([pinned.id]);
    expect(previewBody.evictable.map(p => p.imageId).sort()).toEqual([evictable.id, unrelated.id].sort());
    for (const fixture of [first, second, unrelated]) expect(existsSync(fixture.path)).toBe(true);
    const response = await prune({ dryRun: false });
    expect(response.status).toBe(200);
    const body = await response.json() as { deleted: string[]; protected: Array<{ imageId: string }>; errors: unknown[] };
    expect(body.deleted.sort()).toEqual([evictable.id, unrelated.id].sort());
    expect(body.protected.map(p => p.imageId)).toEqual([pinned.id]);
    expect(body.errors).toEqual([]);
    expect(existsSync(join(pinned.path, ".pinned"))).toBe(true);
    expect(existsSync(evictable.path)).toBe(false);
    expect(existsSync(unrelated.path)).toBe(false);
    expect(lib.list().map(img => img.id)).toEqual([pinned.id]);
  });

  it.each(["1", "2"])("DELETE protects pinned version %s independently; force overrides only its exact target", async version => {
    const first = seed("worker", "1"), second = seed("worker", "2");
    scan(2);
    const pinned = version === "1" ? first : second, evictable = version === "1" ? second : first;
    lib.pin(pinned.id);
    const rejected = await request(pinned);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "image_referenced", reasons: ["pinned"] });
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
    const deleted = await request(evictable);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, id: evictable.id, forced: false });
    expect(existsSync(evictable.path)).toBe(false);
    expect(existsSync(join(pinned.path, ".pinned"))).toBe(true);
    const forced = await request(pinned, "?force=true");
    expect(forced.status).toBe(200);
    expect(await forced.json()).toEqual({ ok: true, id: pinned.id, forced: true });
    expect(existsSync(pinned.path)).toBe(false);
  });

  it("explicit force prune deletes each protected exact version once", async () => {
    const first = seed("worker", "1"), second = seed("worker", "2");
    scan(2);
    lib.pin(first.id);
    reference("agent.yaml", "worker");
    const response = await prune({ dryRun: false, force: true });
    expect(response.status).toBe(200);
    const body = await response.json() as { forced: boolean; deleted: string[]; protected: unknown[]; errors: unknown[] };
    expect(body).toMatchObject({ forced: true, protected: [], errors: [] });
    expect(body.deleted.sort()).toEqual([first.id, second.id]);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
    expect(lib.list()).toEqual([]);
  });
});
