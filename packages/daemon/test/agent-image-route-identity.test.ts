import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService, agentImageId } from "../src/domain/agent-images/agent-image-library-service.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";

interface Fixture { name: string; version: string; id: string; path: string; }
interface IdentityPair {
  axis: "name" | "version";
  first: readonly [string, string];
  second: readonly [string, string];
}
const pairs: readonly [IdentityPair, IdentityPair] = [
  { axis: "name", first: ["worker%2Fchild", "1"], second: ["worker/child", "1"] },
  { axis: "version", first: ["worker", "v%2Fnext"], second: ["worker", "v/next"] },
] as const;

describe("agent-image route identity", () => {
  let temp: string;
  let imageRoot: string;
  let specRoot: string;
  let lib: AgentImageLibraryService;
  let app: Hono;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "agent-image-route-identity-"));
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

  function seed(directory: string, name: string, version: string): Fixture {
    const path = join(imageRoot, directory);
    mkdirSync(path);
    writeFileSync(join(path, "manifest.yaml"), JSON.stringify({
      name, version, runtime: "claude-code", source_seat: `fixture-${directory}`,
      source_session_id: `session-${directory}`, source_resume_token: `PRIVATE-TOKEN-${directory}`,
      files: [],
    }));
    return { name, version, id: agentImageId(name, version), path };
  }
  function scan(expected: number): void {
    expect(lib.scan()).toEqual({ count: expected, errors: [] });
  }
  function request(fixture: Pick<Fixture, "id">, suffix = "", method = "GET") {
    return app.request(`/api/agent-images/library/${encodeURIComponent(fixture.id)}${suffix}`, { method });
  }
  function assertIntact(fixture: Fixture): void {
    expect(existsSync(join(fixture.path, "manifest.yaml"))).toBe(true);
    expect(JSON.parse(readFileSync(join(fixture.path, "manifest.yaml"), "utf8"))).toMatchObject({
      name: fixture.name, version: fixture.version,
    });
  }

  for (const pair of pairs) {
    it.each(["", "/preview"])(`read %s preserves decode-equivalent ${pair.axis} siblings and redacts tokens`, async suffix => {
      const first = seed("percent", ...pair.first), second = seed("slash", ...pair.second);
      scan(2);
      for (const fixture of [first, second]) {
        const response = await request(fixture, suffix);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ id: fixture.id, name: fixture.name, version: fixture.version });
        expect(JSON.stringify(body)).not.toContain("PRIVATE-TOKEN-");
        if (!suffix) expect(body).toMatchObject({ sourcePath: fixture.path, sourceResumeToken: "(redacted)" });
        else expect(body).toMatchObject({ sourceSeat: `fixture-${fixture.path === first.path ? "percent" : "slash"}` });
      }
    });

    it(`pin preserves exact ${pair.axis} target on disk`, async () => {
      const first = seed("percent", ...pair.first), second = seed("slash", ...pair.second);
      scan(2);
      const response = await request(first, "/pin", "POST");
      expect(response.status).toBe(200);
      expect(existsSync(join(first.path, ".pinned"))).toBe(true);
      expect(existsSync(join(second.path, ".pinned"))).toBe(false);
      expect(lib.get(first.id)?.pinned).toBe(true);
      expect(lib.get(second.id)?.pinned).toBe(false);
      expect(await response.json()).toEqual({ ok: true, id: first.id, pinned: true });
    });

    it(`unpin preserves exact ${pair.axis} target on disk`, async () => {
      const first = seed("percent", ...pair.first), second = seed("slash", ...pair.second);
      scan(2);
      lib.pin(first.id);
      lib.pin(second.id);
      const response = await request(first, "/unpin", "POST");
      expect(response.status).toBe(200);
      expect(existsSync(join(first.path, ".pinned"))).toBe(false);
      expect(existsSync(join(second.path, ".pinned"))).toBe(true);
      expect(lib.get(first.id)?.pinned).toBe(false);
      expect(lib.get(second.id)?.pinned).toBe(true);
      expect(await response.json()).toEqual({ ok: true, id: first.id, pinned: false });
    });

    it.each([false, true])(`delete preserves exact ${pair.axis} target with force=%s`, async force => {
      const first = seed("percent", ...pair.first), second = seed("slash", ...pair.second);
      scan(2);
      const response = await request(first, force ? "?force=true" : "", "DELETE");
      expect(response.status).toBe(200);
      expect(existsSync(first.path)).toBe(false);
      assertIntact(second);
      expect(lib.get(first.id)).toBeNull();
      expect(lib.get(second.id)?.sourcePath).toBe(second.path);
      expect(await response.json()).toEqual({ ok: true, id: first.id, forced: force });
    });

    it(`missing percent ${pair.axis} never substitutes the slash sibling for reads or mutations`, async () => {
      const missing = { id: agentImageId(...pair.first) }, second = seed("slash", ...pair.second);
      scan(1);
      lib.pin(second.id);
      for (const [suffix, method] of [["", "GET"], ["/preview", "GET"], ["/pin", "POST"], ["/unpin", "POST"], ["", "DELETE"], ["?force=true", "DELETE"]]) {
        expect((await request(missing, suffix, method)).status).toBe(404);
        assertIntact(second);
        expect(existsSync(join(second.path, ".pinned"))).toBe(true);
      }
    });
  }

  it.each([
    ["literal%", "version%"],
    ["雪 /?#&: worker", "β/?#&: 2"],
    ["ordinary-worker", "1.0"],
  ])("read/pin/unpin/delete accepts exact name %s and version %s", async (name, version) => {
    const fixture = seed("target", name, version);
    scan(1);
    for (const suffix of ["", "/preview"]) {
      const response = await request(fixture, suffix);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ id: fixture.id, name, version });
      expect(JSON.stringify(body)).not.toContain("PRIVATE-TOKEN-");
    }
    expect((await request(fixture, "/pin", "POST")).status).toBe(200);
    expect(existsSync(join(fixture.path, ".pinned"))).toBe(true);
    expect((await request(fixture, "/unpin", "POST")).status).toBe(200);
    expect(existsSync(join(fixture.path, ".pinned"))).toBe(false);
    expect((await request(fixture, "", "DELETE")).status).toBe(200);
    expect(existsSync(fixture.path)).toBe(false);
  });

  it.each(["pinned", "referenced_by_agent_spec"])("exact percent target retains %s protection and force deletes only it", async protection => {
    const first = seed("percent", ...pairs[0].first), second = seed("slash", ...pairs[0].second);
    scan(2);
    if (protection === "pinned") lib.pin(first.id);
    else {
      writeFileSync(join(specRoot, "agent.yaml"), JSON.stringify({
        name: "reference", session_source: { mode: "agent_image", ref: { kind: "image_name", value: first.name } },
      }));
    }
    const rejected = await request(first, "", "DELETE");
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "image_referenced", reasons: [protection] });
    assertIntact(first);
    assertIntact(second);
    const forced = await request(first, "?force=true", "DELETE");
    expect(forced.status).toBe(200);
    expect(await forced.json()).toEqual({ ok: true, id: first.id, forced: true });
    expect(existsSync(first.path)).toBe(false);
    assertIntact(second);
  });
});
