// The ACTUAL /specs/library/$entryId route + LibraryReview honour `?source=`:
// View Spec from a connected-instance workflow opens the connected instance's
// review even while topology selects a remote host with a same-ID spec; a
// link without `source` keeps the selected-host default. Same real daemon
// spec-library/host read-through harness as workflow-spec-identity.test.tsx
// (private in-memory SQLite, temporary spec files, two in-process origins).
// Mounted through the real routeTree, root providers and AppShell.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { Hono } from "hono";
import YAML from "yaml";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { WorkflowSpecCache } from "../../daemon/src/domain/workflow-spec-cache.js";
import { SpecReviewService } from "../../daemon/src/domain/spec-review-service.js";
import { SpecLibraryService } from "../../daemon/src/domain/spec-library-service.js";
import { specLibraryRoutes } from "../../daemon/src/routes/spec-library.js";
import { hostReadThrough } from "../../daemon/src/domain/hosts/read-through.js";
import { routeTree } from "../src/routes.js";
import { queryClient } from "../src/lib/query-client.js";
import { shellRouterOptions } from "../src/components/shell/history-scroll.js";

const at = "2026-10-04T12:00:00Z";
const disposers: Array<() => void> = [];
const requests: Array<{ method: string; url: string }> = [];
afterEach(() => { cleanup(); queryClient.clear(); disposers.splice(0).reverse().forEach((f) => f()); requests.length = 0; vi.unstubAllGlobals(); });

const instance = (instanceId: string, workflowName: string, workflowVersion: string) => ({
  instanceId, workflowName, workflowVersion, createdBySession: "lead@rig", createdAt: at, status: "active", currentFrontier: [], currentStepId: null,
  hopCount: 1, fallbackSynthesis: null, lastContinuationDecision: null, completedAt: null, version: 2, resumeCount: 0, hopsBaseline: 0,
  deadline: { state: "healthy", evidence: null },
});
const current = { status: "current", adopted: true, boundDigest: "d1", proposedDigest: "d1", boundVersion: "1", proposedVersion: "1", compatible: true, changes: [], reasons: [],
  composition: { mode: "extend", explanation: "Running plan matches its sources.", boundSlices: [], executableSteps: [] }, nextAction: "nothing to apply", expectedVersion: 2 };

/** One real spec-library origin with the given cached workflow specs. */
function library(specs: Array<{ name: string; version: string; step: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "openrig-workflow-spec-identity-"));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = createDb();
  disposers.push(() => db.close());
  migrate(db, ALL_MIGRATIONS);
  const cache = new WorkflowSpecCache(db);
  for (const [n, s] of specs.entries()) {
    const path = join(dir, `spec-${n}.yaml`);
    writeFileSync(path, YAML.stringify({ workflow: { id: s.name, version: s.version, objective: "Fictional review", roles: { worker: {} },
      steps: [{ id: s.step, actor_role: "worker", allowed_exits: ["done"] }], invariants: { allowed_exits: ["done"] } } }));
    cache.readThrough(path);
  }
  const review = new SpecReviewService();
  const service = new SpecLibraryService({ roots: [], specReviewService: review });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("rigRepo" as never, { db } as never); c.set("specLibraryService" as never, service as never); c.set("specReviewService" as never, review as never); await next(); });
  app.route("/api/specs/library", specLibraryRoutes());
  return app;
}

/** Browser transport: connected-local library behind real host read-through
 * (remote origin `far`), stubbed workflow trace routes, hosts selection. */
function serve(opts: { local: Hono | Response; remote?: Hono; selected?: "local" | "far"; traces: Record<string, ReturnType<typeof instance>> }) {
  const edge = new Hono();
  edge.use("*", async (c, next) => {
    c.set("hostRegistryLoader" as never, (() => ({ ok: true, registry: { hosts: [{ id: "far", transport: "http", url: "http://private.invalid" }] } })) as never);
    c.set("remoteFetchImpl" as never, (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      return opts.remote ? opts.remote.request(url.pathname + url.search, { method: init?.method, headers: init?.headers }) : Response.json({ error: "unreachable" }, { status: 503 });
    }) as never);
    await next();
  });
  edge.use("/api/*", hostReadThrough());
  edge.all("*", (c) => (opts.local instanceof Response ? opts.local.clone() : opts.local.request(c.req.raw)));
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} } as never);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://private");
    requests.push({ method: init?.method ?? "GET", url: url.pathname + url.search });
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "connected", selected: opts.selected ?? "local", hosts: [] });
    if (url.pathname.startsWith("/api/specs/library")) return edge.request(url.pathname + url.search, { method: init?.method, headers: init?.headers });
    if (url.pathname === "/api/workflow/list") return Response.json(Object.values(opts.traces));
    const m = url.pathname.match(/^\/api\/workflow\/([^/]+)\/(trace|revision)$/);
    if (m && m[2] === "trace") {
      const inst = opts.traces[decodeURIComponent(m[1]!)];
      return inst ? Response.json({ instance: inst, trail: [], failures: [], frontier: [], boundaryObligations: [], unknowns: [] }) : Response.json({ error: "instance_not_found" }, { status: 404 });
    }
    if (m) return Response.json(current);
    if (url.pathname === "/api/workflow/specs") return Response.json({ specs: [] });
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
}


function mountApp(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), ...shellRouterOptions() });
  render(<RouterProvider router={router} />);
  return router;
}
const reviewReads = () => requests.filter((r) => /^\/api\/specs\/library\/[^?]+\/review/.test(r.url));

describe("library review read origin (actual route + LibraryReview)", () => {
  it("View Spec from a connected-instance workflow opens the connected review while a remote host is selected; Back returns", async () => {
    const local = library([{ name: "release", version: "1", step: "connected-only-step" }]);
    const remote = library([{ name: "release", version: "1", step: "remote-only-step" }]);
    serve({ local, remote, selected: "far", traces: { "wf-a": instance("wf-a", "release", "1") } });
    const router = mountApp("/workflow/instance/wf-a");
    const view = await screen.findByTestId("workflow-view-spec") as HTMLButtonElement;
    await waitFor(() => expect(view.disabled).toBe(false));
    fireEvent.click(view);
    await waitFor(() => expect(router.state.location.pathname.startsWith("/specs/library/")).toBe(true));
    expect(new URLSearchParams(router.state.location.publicHref.split("?")[1]).get("source")).toBe("local");
    expect((await screen.findByTestId("library-review-origin")).textContent).toBe("From the connected instance");
    await waitFor(() => expect(document.body.textContent).toContain("connected-only-step"));
    expect(document.body.textContent).not.toContain("remote-only-step");
    expect(reviewReads().length).toBeGreaterThan(0);
    expect(reviewReads().some((r) => r.url.includes("host=far"))).toBe(false);
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflow/instance/wf-a"));
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("without `source` the destination keeps the selected-host default", async () => {
    const local = library([{ name: "release", version: "1", step: "connected-only-step" }]);
    const remote = library([{ name: "release", version: "1", step: "remote-only-step" }]);
    serve({ local, remote, selected: "far", traces: {} });
    const entries = await (await local.request("/api/specs/library")).json() as Array<{ id: string }>;
    mountApp(`/specs/library/${encodeURIComponent(entries[0]!.id)}`);
    await waitFor(() => expect(document.body.textContent).toContain("remote-only-step"));
    expect(screen.queryByTestId("library-review-origin")).toBeNull();
    // Existing selected-host default (unchanged here): reads follow the
    // selection. Before /api/hosts lands, useSelectedHostId presumes local,
    // so an earlier local read can precede it — recorded for the Library owner.
    expect(reviewReads().some((r) => r.url.includes("host=far"))).toBe(true);
  });

  it("an empty `source` reads nothing and says the source is unknown, never local", async () => {
    const local = library([{ name: "release", version: "1", step: "connected-only-step" }]);
    serve({ local, selected: "far", traces: {} });
    const entries = await (await local.request("/api/specs/library")).json() as Array<{ id: string }>;
    mountApp(`/specs/library/${encodeURIComponent(entries[0]!.id)}?source=`);
    expect(await screen.findByTestId("library-review-origin")).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).toMatch(/Spec Not Found|Spec source unknown/));
    expect(document.body.textContent).not.toContain("connected-only-step");
    expect(reviewReads()).toEqual([]);
  });
});
