import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService, agentImageId, parseAgentImageId } from "../src/domain/agent-images/agent-image-library-service.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import { workflowLibraryId, parseWorkflowLibraryId } from "../src/domain/spec-library-workflow-scanner.js";

const temps: string[] = [];
afterEach(() => temps.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(pairs: Array<[string, string]> = [["worker:one", "2"], ["worker", "one:2"]]) {
  const temp = mkdtempSync(join(tmpdir(), "openrig-agent-image-tuple-private-")); temps.push(temp);
  const roots = pairs.map((_, index) => { const path = join(temp, `root-${index}`); mkdirSync(path); return { path, sourceType: "user_file" as const }; });
  const paths = pairs.map(([name, version], index) => {
    const path = join(roots[index]!.path, "image"); mkdirSync(path);
    writeFileSync(join(path, "manifest.yaml"), JSON.stringify({ name, version, runtime: "claude-code", source_seat: `fixture-${index}`, source_session_id: `fixture-session-${index}`, source_resume_token: `FIXTURE-ONLY-${index}`, files: [] }));
    return path;
  });
  const lib = new AgentImageLibraryService({ roots });
  const scan = lib.scan();
  const app = new Hono(); app.use("*", async (c, next) => { c.set("agentImageLibrary" as never, lib); await next(); });
  app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [] }));
  return { lib, app, paths, scan, pairs };
}
function route(id: string, suffix = "") { return `/api/agent-images/library/${encodeURIComponent(id)}${suffix}`; }

it("distinct accepted name/version tuples retain distinct catalog entries", async () => {
  const { app, scan } = fixture(); expect(scan.errors).toEqual([]);
  const entries = await (await app.request("/api/agent-images/library")).json() as Array<{ id: string }>;
  expect(entries).toHaveLength(2); expect(new Set(entries.map(e => e.id)).size).toBe(2);
});
it("structured getByNameVersion returns the requested tuple's native identity", () => {
  const { lib, paths } = fixture();
  expect(lib.getByNameVersion("worker:one", "2")).toMatchObject({ name: "worker:one", version: "2", sourcePath: paths[0], sourceSessionId: "fixture-session-0" });
});
it("route read preserves the first tuple and its source path", async () => {
  const { app, paths } = fixture();
  const response = await app.request(route(agentImageId("worker:one", "2"))); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: "worker:one", version: "2", sourcePath: paths[0], sourceResumeToken: "(redacted)" });
});
it("route pin affects only the requested tuple's image", async () => {
  const { app, paths } = fixture();
  expect((await app.request(route(agentImageId("worker:one", "2"), "/pin"), { method: "POST" })).status).toBe(200);
  expect(paths.map(path => existsSync(join(path, ".pinned")))).toEqual([true, false]);
});
it("route delete affects only the requested tuple's image", async () => {
  const { app, paths } = fixture();
  expect((await app.request(route(agentImageId("worker:one", "2")), { method: "DELETE" })).status).toBe(200);
  expect(paths.map(path => existsSync(join(path, "manifest.yaml")))).toEqual([false, true]);
});
it("consumption stats target only the requested tuple", () => {
  const { lib, paths } = fixture(); lib.recordConsumption(agentImageId("worker:one", "2"));
  expect(paths.map(path => existsSync(join(path, "stats.json")))).toEqual([true, false]);
});
it("parser round-trips a colon-bearing version", () => {
  expect(parseAgentImageId(agentImageId("worker", "one:2"))).toEqual({ name: "worker", version: "one:2" });
});
it("same exact tuple preserves intentional last-root precedence", () => {
  const { lib, paths, scan } = fixture([["worker", "1"], ["worker", "1"]]);
  expect(scan).toEqual({ count: 1, errors: [] }); expect(lib.getByNameVersion("worker", "1")?.sourcePath).toBe(paths[1]);
});
it("ordinary distinct versions retain exact route and mutation identity", async () => {
  const { lib, app, paths, scan } = fixture([["worker", "1"], ["worker", "2"]]); expect(scan).toEqual({ count: 2, errors: [] });
  const id = agentImageId("worker", "1"); expect(parseAgentImageId(id)).toEqual({ name: "worker", version: "1" });
  const response = await app.request(route(id)); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ name: "worker", version: "1", sourcePath: paths[0] });
  expect((await app.request(route(id, "/pin"), { method: "POST" })).status).toBe(200); expect(paths.map(path => existsSync(join(path, ".pinned")))).toEqual([true, false]);
  lib.recordConsumption(id); expect(JSON.parse(readFileSync(join(paths[0]!, "stats.json"), "utf8")).forkCount).toBe(1);
});
it("workflow tuple encoding already separates this delimiter collision", () => {
  const pairs = [["worker:one", "2"], ["worker", "one:2"]] as const;
  const ids = pairs.map(([name, version]) => workflowLibraryId(name, version)); expect(new Set(ids).size).toBe(2);
  for (const [name, version] of pairs) expect(parseWorkflowLibraryId(workflowLibraryId(name, version))).toEqual({ name, version });
});
it.each(["", "0", "01", " version ", "%3A/?#&雪"])("accepted version string %j is retained exactly", async version => {
  const { lib, app, paths, scan } = fixture([["@worker", version]]);
  expect(scan).toEqual({ count: 1, errors: [] });
  const id = agentImageId("@worker", version);
  expect(parseAgentImageId(id)).toEqual({ name: "@worker", version });
  expect(lib.getByNameVersion("@worker", version)?.sourcePath).toBe(paths[0]);
  const response = await app.request(route(id)); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: "@worker", version, sourcePath: paths[0] });
});

const encoded = (value: unknown) => `agent-image:@${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
it.each([["worker:one", "2"], ["worker", "one:2"], [" 雪:%2F ", ""], ["@worker", " 0:01 "]])("colon tuple %j uses canonical opaque encoding", (name, version) => {
  const id = agentImageId(name, version);
  expect(id).toBe(encoded([name, version]));
  expect(parseAgentImageId(id)).toEqual({ name, version });
});
it.each(["agent-image:worker:one:2", "agent-image:a:b:", "agent-image:::"])("ambiguous historical ID %s is not parsed or aliased", async id => {
  const { lib, app, paths } = fixture();
  expect(parseAgentImageId(id)).toBeNull(); expect(lib.get(id)).toBeNull();
  for (const [method, suffix] of [["GET", ""], ["POST", "/pin"], ["POST", "/unpin"], ["DELETE", ""]]) {
    expect((await app.request(route(id, suffix), { method })).status).toBe(404);
  }
  expect(() => lib.recordConsumption(id)).toThrow(/not found/);
  expect(paths.map(path => existsSync(join(path, "manifest.yaml")))).toEqual([true, true]);
  expect(paths.map(path => existsSync(join(path, ".pinned")) || existsSync(join(path, "stats.json")))).toEqual([false, false]);
});
it.each([null, {}, ["a:"], ["a:", "1", "extra"], [1, "v:"], ["a:", false], ["a:", {}]].map(value => [value]))("rejects encoded non-two-string tuple %j", value => {
  expect(parseAgentImageId(encoded(value))).toBeNull();
});
it.each(["", "=", "!", "\n"])("rejects noncanonical base64 suffix %j", suffix => {
  const id = encoded(["worker:", "1"]);
  expect(parseAgentImageId(suffix ? id + suffix : "agent-image:@")).toBeNull();
});
it("requires canonical JSON and the builder spelling, never accepts another ID for one tuple", () => {
  const whitespace = `agent-image:@${Buffer.from('[ "worker:", "1" ]').toString("base64url")}`;
  expect(parseAgentImageId(whitespace)).toBeNull();
  expect(parseAgentImageId(encoded(["worker", "1"]))).toBeNull();
  const id = encoded(["worker:", "12"]), alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const changed = id.slice(0, -1) + alphabet[alphabet.indexOf(id.at(-1)!) + 1];
  expect(Buffer.from(changed.slice("agent-image:@".length), "base64url")).toEqual(Buffer.from(id.slice("agent-image:@".length), "base64url"));
  expect(parseAgentImageId(changed)).toBeNull();
});
it.each(["", "0", "01", " version ", "%3A/?#&雪"])("legacy no-colon spelling remains stable for version %j", version => {
  const id = `agent-image:@worker:${version}`;
  expect(agentImageId("@worker", version)).toBe(id);
  expect(parseAgentImageId(id)).toEqual({ name: "@worker", version });
});
it("same exact encoded tuple retains last-root precedence", () => {
  const { lib, paths, scan } = fixture([["worker:one", "2"], ["worker:one", "2"]]);
  expect(scan).toEqual({ count: 1, errors: [] });
  expect(lib.getByNameVersion("worker:one", "2")?.sourcePath).toBe(paths[1]);
});
