import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextPackLibraryService } from "../../daemon/src/domain/context-packs/context-pack-library-service.js";
import { SkillLibraryDiscoveryService } from "../../daemon/src/domain/skill-library-discovery.js";
import { contextPacksRoutes } from "../../daemon/src/routes/context-packs.js";
import { skillsRoutes } from "../../daemon/src/routes/skills.js";
import { useContextPackLibrary } from "../src/hooks/useContextPackLibrary.js";
import { useLibrarySkills } from "../src/hooks/useLibrarySkills.js";

const dirs: string[] = [], clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllGlobals(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openrig-context-skills-library-")); dirs.push(root);
  const packs = join(root, "packs"), pack = join(packs, "nested", "raw-pack"), managed = join(root, "managed"), skill = join(managed, "raw%2F:雪");
  mkdirSync(pack, { recursive: true }); mkdirSync(skill, { recursive: true });
  writeFileSync(join(pack, "manifest.yaml"), 'name: "raw:%2F 雪"\nversion: "01"\ntaxonomy: world\nfiles:\n  - path: empty.md\n    role: reference\n  - path: missing.md\n    role: proof\n');
  writeFileSync(join(pack, "empty.md"), ""); writeFileSync(join(skill, "SKILL.md"), "");
  const context = new ContextPackLibraryService({ roots: [{ path: packs, sourceType: "workspace" }] }); context.scan();
  const skills = new SkillLibraryDiscoveryService({ sharedSkillsDir: managed, filesAllowlist: [] });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("contextPackLibrary" as never, context as never); c.set("skillLibraryDiscoveryService" as never, skills as never); await next(); });
  app.route("/api/context-packs", contextPacksRoutes()); app.route("/api/skills", skillsRoutes());
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://private.invalid");
    return app.request(url.pathname + url.search, { method: init?.method, headers: init?.headers });
  }); vi.stubGlobal("fetch", fetch);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(qc);
  qc.setQueryData(["hosts"], { ownName: "private", selected: "remote", hosts: [] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { context, skills, app, fetch, wrapper };
}
it("actual private context route preserves raw ref, string version, additive taxonomy and missing/empty file facts", async () => {
  const f = fixture(), actual = await (await f.app.request("/api/context-packs/library")).json();
  const { result } = renderHook(useContextPackLibrary, { wrapper: f.wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true)); expect(result.current.data).toEqual(actual);
  expect(result.current.data?.[0]).toMatchObject({ id: "context-pack:nested/raw-pack", relativePath: "nested/raw-pack", name: "raw:%2F 雪", version: "01", purpose: null, manifestEstimatedTokens: null, derivedEstimatedTokens: 0,
    files: [{ path: "empty.md", summary: null, bytes: 0, estimatedTokens: 0 }, { path: "missing.md", absolutePath: null, bytes: null, estimatedTokens: null }] });
  expect(result.current.data?.[0]).toHaveProperty("taxonomy", "world");
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual(["/api/context-packs/library"]);
});
it("actual private discovery route preserves percent/Unicode skill IDs, absolute source and zero-byte file", async () => {
  const f = fixture(), actual = await (await f.app.request("/api/skills/library")).json();
  const { result } = renderHook(useLibrarySkills, { wrapper: f.wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true)); expect(result.current.data).toEqual(actual);
  expect(result.current.data?.[0]).toMatchObject({ id: "openrig-managed:raw%2F:雪", name: "raw%2F:雪", source: "openrig-managed", files: [{ name: "SKILL.md", path: "SKILL.md", size: 0 }] });
  expect(result.current.data?.[0]?.absolutePath).toContain("managed/raw%2F:雪");
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual(["/api/skills/library"]);
});
