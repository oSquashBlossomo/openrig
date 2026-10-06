import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { specLibraryRoutes } from "../src/routes/spec-library.js";
const temps: string[] = [];
afterEach(() => temps.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const yaml = (name: string) => `name: ${name}\nversion: "1"\nprofiles:\n  default: {}\nresources: {}\nstartup: {}\n`;
function temp() { const path = realpathSync(mkdtempSync(join(tmpdir(), "spec-address-test-"))); temps.push(path); return path; }
function file(root: string, relative: string, name: string) { const path = join(root, relative); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, yaml(name)); return path; }
function library(roots: Array<{ path: string; sourceType: "builtin" | "user_file" }>) {
  const service = new SpecReviewService(); const lib = new SpecLibraryService({ roots, specReviewService: service }); lib.scan();
  const app = new Hono(); app.use("*", async (c, next) => { c.set("specLibraryService" as never, lib); c.set("specReviewService" as never, service); await next(); }); app.route("/api/specs/library", specLibraryRoutes());
  return { lib, app };
}
const user = (path: string) => ({ path, sourceType: "user_file" as const });
const legacy = createHash("sha256").update("user_file:agent.yaml").digest("hex").slice(0, 16);
it("retains same-relative files in two roots and reviews the exact opaque source", async () => {
  const base = temp(), a = join(base, "current"), b = join(base, "legacy"); const fa = file(a, "agent.yaml", "current"), fb = file(b, "agent.yaml", "legacy"); const { lib, app } = library([user(a), user(b)]);
  expect(lib.list()).toHaveLength(2); expect(new Set(lib.list().map(e => e.id)).size).toBe(2);
  for (const [name, path] of [["current", fa], ["legacy", fb]]) { const entry = lib.list().find(e => e.name === name)!; expect(entry.id).toBe("specfile:v2:" + createHash("sha256").update(JSON.stringify(["spec-file", 2, realpathSync(path!)])).digest("hex")); const response = await app.request(`/api/specs/library/${encodeURIComponent(entry.id)}/review`); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ libraryEntryId: entry.id, name, sourcePath: realpathSync(path!) }); }
});
it("surviving IDs are independent of restart, root order and collision appearance/removal", () => {
  const base = temp(), a = join(base, "current"), b = join(base, "legacy"); file(a, "agent.yaml", "current"); mkdirSync(b); const initial = library([user(a)]).lib.list()[0]!; const { lib } = library([user(b), user(a)]); expect(lib.list()[0]!.id).toBe(initial.id);
  file(b, "agent.yaml", "legacy"); lib.scan(); const other = lib.list().find(e => e.name === "legacy"); expect(other).toBeDefined(); expect(lib.get(initial.id)?.entry.name).toBe("current"); expect(other!.id).not.toBe(initial.id); expect(library([user(a), user(b)]).lib.get(initial.id)?.entry.name).toBe("current");
  expect(lib.remove(initial.id).ok).toBe(true); expect(lib.get(initial.id)).toBeNull(); expect(lib.get(other!.id)?.entry.name).toBe("legacy"); expect(library([user(b)]).lib.list()[0]!.id).toBe(other!.id);
});
it("overlapping/realpath aliases deduplicate and builtin read-only classification wins independently of order", () => {
  const base = temp(), root = join(base, "physical"), alias = join(base, "alias"); const source = file(root, "agents/shared/agent.yaml", "shared"); symlinkSync(root, alias);
  const roots = [user(alias), user(join(root, "agents")), { path: root, sourceType: "builtin" as const }]; const first = library(roots).lib, second = library([...roots].reverse()).lib;
  expect(first.list()).toHaveLength(1); expect(second.list()).toEqual(first.list()); const entry = first.list()[0]!; expect(entry).toMatchObject({ sourceType: "builtin", sourcePath: realpathSync(source) }); expect(first.remove(entry.id)).toMatchObject({ ok: false, code: "read_only" }); expect(first.rename(entry.id, "renamed")).toMatchObject({ ok: false, code: "read_only" }); expect(existsSync(source)).toBe(true);
});
it("distinct hardlink addresses are not merged merely because bytes/inode match", () => {
  const base = temp(), a = file(base, "a.yaml", "shared"); linkSync(a, join(base, "b.yaml")); const { lib } = library([user(base)]); expect(lib.list()).toHaveLength(2); expect(new Set(lib.list().map(e => e.id)).size).toBe(2);
});
it("content edits retain source ID; file rename and builtin physical-directory moves produce a new ID", () => {
  const base = temp(), root = join(base, "builtin"); const source = file(root, "agents/shared/agent.yaml", "shared"); const { lib } = library([{ path: root, sourceType: "builtin" }]); const id = lib.list()[0]!.id; writeFileSync(source, yaml("changed")); lib.scan(); expect(lib.list()[0]!.id).toBe(id);
  renameSync(root, join(base, "moved")); const moved = library([{ path: join(base, "moved"), sourceType: "builtin" }]).lib; expect(moved.list()[0]!.id).not.toBe(id); expect(lib.get(id)).toBeNull();
  const userRoot = join(base, "user"); file(userRoot, "agent.yaml", "one"); const userLib = library([user(userRoot)]).lib, previous = userLib.list()[0]!.id; const renamed = userLib.rename(previous, "two"); expect(renamed.ok).toBe(true); if (renamed.ok) expect(renamed.entry.id).not.toBe(previous); expect(userLib.get(previous)).toBeNull();
});
it.each(["get", "review", "remove", "rename"])("root-alias retarget after scan rejects %s without touching either private source", async operation => {
  const base = temp(), a = join(base, "a"), b = join(base, "b"), alias = join(base, "selected"); const fa = file(a, "agent.yaml", "A"), fb = file(b, "agent.yaml", "B"); symlinkSync(a, alias); const { lib, app } = library([user(alias)]), id = lib.list()[0]!.id;
  unlinkSync(alias); symlinkSync(b, alias);
  if (operation === "remove" || operation === "rename") {
    expect(operation === "remove" ? lib.remove(id) : lib.rename(id, "changed")).toMatchObject({ ok: false, code: "source_changed" });
    const response = await app.request(`/api/specs/library/${encodeURIComponent(id)}${operation === "rename" ? "/rename" : ""}`, { method: operation === "remove" ? "DELETE" : "POST", ...(operation === "rename" ? { body: JSON.stringify({ name: "changed" }), headers: { "Content-Type": "application/json" } } : {}) }); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "source_changed" });
  }
  else { const response = await app.request(`/api/specs/library/${encodeURIComponent(id)}${operation === "review" ? "/review" : ""}`); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "source_changed" }); }
  expect(readFileSync(fa, "utf8")).toBe(yaml("A")); expect(readFileSync(fb, "utf8")).toBe(yaml("B")); expect(existsSync(join(b, "changed.yaml"))).toBe(false); lib.scan(); expect(lib.list()[0]!.id).not.toBe(id); expect(lib.get(id)).toBeNull();
});
it.each([0, 1, 2])("all legacy IDs require explicit reselect with %s current candidates; every route/mutation is inert", async count => {
  const base = temp(), roots = Array.from({ length: count }, (_, index) => { const root = join(base, String(index)); file(root, "agent.yaml", `agent-${index}`); return user(root); }); const { lib, app } = library(roots);
  for (const [suffix, method, body] of [["", "GET", undefined], ["/review", "GET", undefined], ["", "DELETE", undefined], ["/rename", "POST", JSON.stringify({ name: "changed" })]]) { const res = await app.request(`/api/specs/library/${legacy}${suffix}`, { method, ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}) }); expect(res.status).toBe(409); expect(await res.json()).toMatchObject({ code: "legacy_spec_id" }); }
  expect(lib.list()).toHaveLength(count); for (const root of roots) expect(existsSync(join(root.path, "agent.yaml"))).toBe(true);
  if (count) { rmSync(roots[0]!.path, { recursive: true }); lib.scan(); expect((await app.request(`/api/specs/library/${legacy}`)).status).toBe(409); }
});
it("unknown current/malformed IDs stay404 and workflow entries preserve their existing IDs/get behavior", async () => {
  const { lib, app } = library([]); for (const id of ["specfile:v2:missing", "unknown", "e81a4bfbead405bc0x"]) expect((await app.request(`/api/specs/library/${id}`)).status).toBe(404);
  const root = temp(), path = file(root, "workflow.yaml", "inert"); lib.setWorkflowEntries([{ id: "workflow:exact:1", kind: "workflow", name: "exact", version: "1", sourceType: "user_file", sourcePath: path, relativePath: "workflow.yaml", updatedAt: "2026-10-04T00:00:00Z" }]); expect(lib.get("workflow:exact:1")).toMatchObject({ entry: { id: "workflow:exact:1" }, yaml: yaml("inert") });
});
