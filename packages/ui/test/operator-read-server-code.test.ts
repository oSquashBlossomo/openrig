// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpecLibraryService } from "../../daemon/src/domain/spec-library-service.js";
import { SpecReviewService } from "../../daemon/src/domain/spec-review-service.js";
import { specLibraryRoutes } from "../../daemon/src/routes/spec-library.js";
import { LOCAL_OPERATOR_INSTANCE, operatorRead } from "../src/lib/operator-read.js";
import { readLibraryReview } from "../src/lib/node-library-reads.js";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
it.each([
  [{ code: "source_changed", error: "Source address changed" }, "source_changed", "Source address changed"],
  [{ code: "legacy_spec_id", error: "Legacy address", message: "Reselect exact source" }, "legacy_spec_id", "Reselect exact source"],
  [{ error: "source_unavailable", message: "Cannot read source" }, "source_unavailable", "Cannot read source"],
  [{ code: "only_code" }, "only_code", undefined],
  [{ code: null, error: "old_server" }, "old_server", "old_server"],
  [{ code: 409, error: "old_server" }, "old_server", "old_server"],
  [{ code: "", error: "Human explanation" }, "", "Human explanation"],
  [null, undefined, undefined],
] as const)("preserves structured code and legacy message contract for %j", async (body, serverCode, detail) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status: 409 })));
  const error = await operatorRead(LOCAL_OPERATOR_INSTANCE, "/api/example", (_): _ is never => false).catch(e => e);
  expect(error).toMatchObject({ code: "http", status: 409, serverCode });
  expect(error.message).toBe(`GET /api/example returned HTTP 409${detail ? `: ${detail}` : "."}`);
});

function library() {
  const dir = mkdtempSync(join(tmpdir(), "openrig-operator-code-")); dirs.push(dir);
  const a = join(dir, "a"), b = join(dir, "b"), alias = join(dir, "authored");
  mkdirSync(a); mkdirSync(b);
  const yaml = 'version: "1"\nname: private-agent\nprofiles:\n  default: {}\nresources: {}\nstartup: {}\n';
  writeFileSync(join(a, "agent.yaml"), yaml); writeFileSync(join(b, "agent.yaml"), yaml); symlinkSync(a, alias);
  const service = new SpecReviewService(), lib = new SpecLibraryService({ roots: [{ path: alias, sourceType: "user_file" }], specReviewService: service });
  lib.scan(); expect(lib.list()).toHaveLength(1);
  const app = new Hono(); app.use("*", async (c, next) => { c.set("specLibraryService" as never, lib as never); c.set("specReviewService" as never, service as never); await next(); });
  app.route("/api/specs/library", specLibraryRoutes());
  vi.stubGlobal("fetch", vi.fn(async (route: string, options?: RequestInit) => app.request(route, options)));
  return { app, lib, alias, b };
}
it.each(["legacy_spec_id", "source_changed"] as const)("actual private library %s remains exact in the read error", async code => {
  const { app, lib, alias, b } = library(); let id = lib.list()[0]!.id;
  if (code === "legacy_spec_id") id = "0123456789abcdef";
  else { unlinkSync(alias); symlinkSync(b, alias); }
  const route = `/api/specs/library/${encodeURIComponent(id)}/review`;
  const real = await app.request(route); expect(real.status).toBe(409);
  const served = await real.json() as { code: string; error: string };
  expect(served.code).toBe(code); expect(served.error).not.toBe(code);
  const error = await readLibraryReview(id, "local").catch(e => e);
  expect(error).toMatchObject({ code: "http", status: 409, serverCode: served.code });
  expect(error.message).toContain(served.error);
});
