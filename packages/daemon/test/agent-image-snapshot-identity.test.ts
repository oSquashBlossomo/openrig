import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import { SnapshotCapturer } from "../src/domain/agent-images/snapshot-capturer.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
const dispose: Array<() => void> = [];
afterEach(() => dispose.splice(0).forEach(cleanup => cleanup()));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openrig-image-snapshot-tuple-"));
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  dispose.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const repo = new RigRepository(db), registry = new SessionRegistry(db), rig = repo.createRig("private-snapshot");
  const node = repo.addNode(rig.id, "source", { runtime: "codex" });
  const source = registry.registerClaimedSession(node.id, "private-source");
  db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run("fictional-native-id", source.id);
  const lib = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
  const capturer = new SnapshotCapturer({ db, rigRepo: repo, sessionRegistry: registry, agentImageLibrary: lib, targetRoot: root });
  const app = new Hono(); app.use("*", async (c, next) => {
    c.set("agentImageLibrary" as never, lib); c.set("snapshotCapturer" as never, capturer); await next();
  }); app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [] }));
  return { lib, app };
}
it.each([
  ["worker:one", "2"], ["worker", "one:2"], ["雪:worker", ""], ["worker", "01"],
  ["worker", " version "], ["worker", 0], ["worker", undefined],
])("actual snapshot %s/%j returns the scanner's exact string tuple ID", async (name, version) => {
  const { lib, app } = fixture();
  const response = await app.request("/api/agent-images/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceSession: "private-source", name, version }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { imageId: string; manifest: { sourceResumeToken: string } }, expectedVersion = String(version ?? "1");
  const expectedId = name.includes(":") || expectedVersion.includes(":") ? `agent-image:@${Buffer.from(JSON.stringify([name, expectedVersion])).toString("base64url")}` : `agent-image:${name}:${expectedVersion}`;
  expect(body).toMatchObject({ imageId: expectedId, manifest: { name, version: expectedVersion, sourceResumeToken: "(redacted)" } });
  expect(lib.get(body.imageId)).toMatchObject({ name, version: expectedVersion, sourceResumeToken: "fictional-native-id" });
  expect(body.manifest.sourceResumeToken).not.toBe("fictional-native-id");
});
