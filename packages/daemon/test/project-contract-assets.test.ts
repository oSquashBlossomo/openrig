import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { slicesRoutes } from "../src/routes/slices.js";
let root: string, app: Hono, db: ReturnType<typeof createDb>;
const source = (label: string) => `---\nid: same-id\nstatus: active\n---\n# ${label}\n`;
function file(name: string, text: string) { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, text); }
const slice = (id: string) => path.join(root, id, "missions/trial/slices/one");
const request = (id: string, family = "doc", leaf = "README.md", selectedRoot = path.join(root, id)) => `/api/slices/one/${family}/${leaf}?${new URLSearchParams({ project: id, projectRoot: selectedRoot, mission: "trial" })}`;
async function get(url: string) { const response = await app.request(url); return { response, status: response.status, body: await response.json() as {error?: string; content?: string} }; }
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-contract-assets-")));
  file(path.join(root, "workspace.yaml"), "projects:\n  - id: a\n    root: a\n  - id: b\n    root: b\n");
  for (const id of ["a", "b"]) { file(path.join(root, id, "project.yaml"), `metadata:\n  id: ${id}\n`); file(path.join(root, id, "SPEC.md"), source(`${id} project`)); file(path.join(root, id, "missions/trial/SPEC.md"), source(`${id} mission`)); file(path.join(slice(id), "SPEC.md"), source(`${id} slice`)); file(path.join(slice(id), "README.md"), source(`${id} document only`)); }
  const proofRoot = path.join(root, "default-proof"); file(path.join(proofRoot, "one-evidence/PROOF.md"), "Default project proof"); file(path.join(proofRoot, "one-evidence/shot.png"), "DEFAULT PROJECT IMAGE");
  db = createDb(); migrate(db, ALL_MIGRATIONS);
  const indexer = new SliceIndexer({ db, slicesRoot: path.join(root, "b/missions"), dogfoodEvidenceRoot: proofRoot });
  const projector = new SliceDetailProjector({ db, indexer });
  app = new Hono(); app.use("*", async (c, next) => { c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? root : path.join(root, "workspace.yaml") }) }); c.set("sliceIndexer" as never, indexer); c.set("sliceDetailProjector" as never, projector); await next(); }); app.route("/api/slices", slicesRoutes());
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("exact project document/proof read routes", () => {
  it("serves same-named docs from each exact catalog project", async () => { for (const id of ["a", "b"]) { const read = await get(request(id)); expect(read.status).toBe(200); expect(read.body.content).toContain(`${id} document only`); } });
  it("never serves a default same-name proof packet for a selected project", async () => { const legacy = await app.request("/api/slices/one/proof-asset/shot.png"); expect(legacy.status).toBe(200); expect(await legacy.text()).toBe("DEFAULT PROJECT IMAGE"); for (const id of ["a", "b"]) { const read = await get(request(id, "proof-asset", "shot.png")); expect(read.status).toBe(404); expect(read.body.error).toBe("proof_packet_not_found"); } });
  it.each(["doc", "proof-asset"])("surfaces %s root mismatch, unregistered identity and moved roots without fallback", async family => { let read = await get(request("a", family, family === "doc" ? "README.md" : "shot.png", path.join(root, "old-a"))); expect(read.status).toBe(409); expect(read.body.error).toBe("project_changed"); read = await get(request("unknown", family)); expect(read.status).toBe(409); expect(read.body.error).toBe("project_not_found"); fs.renameSync(path.join(root, "a"), path.join(root, "retained-a")); read = await get(request("a", family)); expect(read.status).toBe(409); expect(read.body.error).toBe("project_root_missing"); });
  it("requires exact mission/slice and reports missing documents locally", async () => { let read = await get(`/api/slices/one/doc/README.md?${new URLSearchParams({ project: "a", projectRoot: path.join(root, "a") })}`); expect(read.status).toBe(400); expect(read.body.error).toBe("exact_mission_and_slice_required"); read = await get(request("a", "doc", "missing.md")); expect(read.status).toBe(404); expect(read.body.error).toBe("doc_not_found"); });
  it("refuses symlink escapes outside the selected project and outside the slice", async () => { file(path.join(root, "outside.md"), "Outside project"); fs.symlinkSync(path.join(root, "outside.md"), path.join(slice("a"), "outside.md")); let read = await get(request("a", "doc", "outside.md")); expect(read.status).toBe(409); expect(read.body.error).toBe("project_path_escape"); file(path.join(root, "a/private.md"), "Outside slice"); fs.symlinkSync(path.join(root, "a/private.md"), path.join(slice("a"), "outside-slice.md")); read = await get(request("a", "doc", "outside-slice.md")); expect(read.status).toBe(409); expect(read.body.error).toBe("project_path_escape"); });
  it("permits contained nested documents and contained symlinks", async () => { file(path.join(slice("a"), "docs/NOTE.md"), "A nested document"); fs.symlinkSync(path.join(slice("a"), "docs/NOTE.md"), path.join(slice("a"), "alias.md")); for (const leaf of ["docs/NOTE.md", "alias.md"]) { const read = await get(request("a", "doc", leaf)); expect(read.status).toBe(200); expect(read.body.content).toBe("A nested document"); } });
  it.each(["doc", "proof-asset"])("retains encoded traversal refusal for %s", async family => { const response = await app.request(request("a", family, "%252e%252e%252fprivate.md")); expect(response.status).not.toBe(200); expect(await response.text()).not.toContain("DEFAULT PROJECT IMAGE"); });
});
