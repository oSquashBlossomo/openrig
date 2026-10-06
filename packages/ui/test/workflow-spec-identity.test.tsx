// Workflow instance spec identity and read origin. The instance trace is a
// connected-instance read, so its cached shape and View Spec destination must
// come from the connected instance's own library, by the served catalog entry
// whose name/version bytes equal the instance's. Ported from the independent
// probe /private/tmp/openrig-workflow-spec-origin-independent.test.tsx: real
// daemon WorkflowSpecCache/SpecLibraryService/spec-library routes over private
// in-memory SQLite and temporary spec files, real host read-through with two
// in-process origins, actual WorkflowInstancePage/WorkflowsPage in an actual
// router. No sockets, fleet, native sessions or global host-selection writes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams, useRouterState } from "@tanstack/react-router";
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
import { WorkflowInstancePage } from "../src/components/workflow/WorkflowInstancePage.js";
import { WorkflowsPage } from "../src/components/workflow/WorkflowsPage.js";
import { matchWorkflowSpec, verifiedWorkflowReview } from "../src/components/workflow/workflow-spec-identity.js";
import { useLibraryReview, type SpecLibraryEntry } from "../src/hooks/useSpecLibrary.js";

const at = "2026-10-04T12:00:00Z";
const disposers: Array<() => void> = [];
const clients: QueryClient[] = [];
const requests: Array<{ method: string; url: string }> = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); disposers.splice(0).reverse().forEach((f) => f()); requests.length = 0; vi.unstubAllGlobals(); });

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
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://private");
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

/** Mirrors the published destination seam: `?source=` pins the review origin. */
function LibraryDestination() {
  const { entryId } = useParams({ from: "/specs/library/$entryId" });
  const publicHref = useRouterState({ select: (state) => state.location.publicHref });
  const source = new URLSearchParams(publicHref.split("?")[1] ?? "").get("source");
  const review = useLibraryReview(entryId, source === null ? {} : { sourceHostId: source });
  const data = review.data as { name?: string; version?: string; topology?: { nodes: Array<{ stepId: string }> } } | undefined;
  return <div data-testid="library-destination" data-entry={entryId} data-source={review.sourceHostId ?? "unknown"}>
    {data ? `${data.name} v${data.version}: ${data.topology?.nodes.map((n) => n.stepId).join(",")}` : "loading"}
  </div>;
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const root = createRootRoute({ component: () => <Outlet /> });
  function Instance() {
    const { instanceId } = useParams({ from: "/workflow/instance/$instanceId" });
    return <WorkflowInstancePage instanceId={instanceId} />;
  }
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/workflow/instance/$instanceId", component: Instance }),
      createRoute({ getParentRoute: () => root, path: "/workflows", component: WorkflowsPage }),
      createRoute({ getParentRoute: () => root, path: "/specs/library/$entryId", component: LibraryDestination }),
      createRoute({ getParentRoute: () => root, path: "/specs", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, client };
}
const reviewKeys = (client: QueryClient) => client.getQueryCache().findAll({ queryKey: ["spec-library", "review"] }).filter((q) => q.isActive()).map((q) => q.queryKey);

describe("exact workflow spec matching (pure)", () => {
  const entry = (id: string, name: string, version: string): SpecLibraryEntry => ({ id, kind: "workflow", name, version, sourceType: "user_file", sourcePath: `/s/${id}`, relativePath: id, updatedAt: at });
  it("matches name and version bytes exactly and never a colon sibling or coerced version", () => {
    const rows = [entry("workflow:release:1:2", "release:1", "2"), entry("workflow:@exact", "release", "1:2"), entry("workflow:release:1.0", "release", "1.0")];
    expect(matchWorkflowSpec(rows, "release", "1:2")).toMatchObject({ kind: "matched", entry: { id: "workflow:@exact" } });
    expect(matchWorkflowSpec(rows, "release", "1")).toEqual({ kind: "absent" });
    expect(matchWorkflowSpec(undefined, "release", "1")).toEqual({ kind: "pending" });
    expect(matchWorkflowSpec([...rows, entry("workflow:@dup", "release", "1:2")], "release", "1:2")).toMatchObject({ kind: "ambiguous", entries: [{ id: "workflow:@exact" }, { id: "workflow:@dup" }] });
  });
  it("uses a review only when it names the matched entry and tuple", () => {
    const ok = { kind: "workflow", libraryEntryId: "workflow:@exact", name: "release", version: "1:2" };
    expect(verifiedWorkflowReview(ok, "workflow:@exact", "release", "1:2")).toBe(ok);
    expect(verifiedWorkflowReview({ ...ok, name: "release:1", version: "2" }, "workflow:@exact", "release", "1:2")).toBeNull();
    expect(verifiedWorkflowReview({ ...ok, libraryEntryId: "workflow:release:1:2" }, "workflow:@exact", "release", "1:2")).toBeNull();
    expect(verifiedWorkflowReview({ ...ok, kind: "rig" }, "workflow:@exact", "release", "1:2")).toBeNull();
  });
});

describe("WorkflowInstancePage spec identity and origin", () => {
  it("reads the exact encoded colon-version entry, not its sibling, and View Spec opens that exact local entry; Back and reload keep it", async () => {
    const local = library([{ name: "release", version: "1:2", step: "correct-exact-step" }, { name: "release:1", version: "2", step: "wrong-sibling-step" }]);
    const entries = await (await local.request("/api/specs/library")).json() as SpecLibraryEntry[];
    const exactId = entries.find((e) => e.name === "release")!.id;
    expect(exactId).toMatch(/^workflow:@/);
    serve({ local, traces: { "wf-a": instance("wf-a", "release", "1:2") } });
    const { router, client } = mount("/workflow/instance/wf-a");
    const graph = await screen.findByTestId("workflow-instance-graph");
    expect(graph.textContent).toContain("correct-exact-step");
    expect(graph.textContent).not.toContain("wrong-sibling-step");
    expect(screen.getByTestId("workflow-spec-source").getAttribute("data-entry")).toBe(exactId);
    expect(reviewKeys(client)).toEqual([["spec-library", "review", exactId, "local"]]);

    fireEvent.click(screen.getByTestId("workflow-view-spec"));
    const dest = await screen.findByTestId("library-destination");
    expect(dest.getAttribute("data-entry")).toBe(exactId);
    expect(new URLSearchParams(router.state.location.publicHref.split("?")[1]).get("source")).toBe("local");
    await waitFor(() => expect(screen.getByTestId("library-destination").textContent).toContain("release v1:2: correct-exact-step"));

    act(() => router.history.back());
    expect((await screen.findByTestId("workflow-instance-graph")).textContent).toContain("correct-exact-step");
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);

    act(() => router.history.forward());
    await screen.findByTestId("library-destination");
    const destinationHref = router.state.location.publicHref;
    cleanup();
    const reloaded = mount(destinationHref);
    await waitFor(() => expect(screen.getByTestId("library-destination").textContent).toContain("release v1:2: correct-exact-step"));
    expect(reviewKeys(reloaded.client)).toEqual([["spec-library", "review", exactId, "local"]]);
  });

  it("keeps the connected-instance shape while topology selects a remote host with a same-ID workflow", async () => {
    const local = library([{ name: "release", version: "1", step: "connected-only-step" }]);
    const remote = library([{ name: "release", version: "1", step: "remote-only-step" }]);
    serve({ local, remote, selected: "far", traces: { "wf-a": instance("wf-a", "release", "1") } });
    const { client, router } = mount("/workflow/instance/wf-a");
    await waitFor(() => expect(client.getQueryData(["hosts"])).toMatchObject({ selected: "far" }));
    const graph = await screen.findByTestId("workflow-instance-graph");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(graph.textContent).toContain("connected-only-step");
    expect(graph.textContent).not.toContain("remote-only-step");
    expect(screen.getByTestId("workflow-spec-source").getAttribute("data-source")).toBe("local");
    expect(reviewKeys(client).map((k) => k.at(-1))).toEqual(["local"]);
    expect(requests.some((r) => r.url.startsWith("/api/specs/library") && r.url.includes("host=far"))).toBe(false);

    fireEvent.click(screen.getByTestId("workflow-view-spec"));
    await waitFor(() => expect(screen.getByTestId("library-destination").textContent).toContain("connected-only-step"));
    expect(screen.getByTestId("library-destination").getAttribute("data-source")).toBe("local");
    act(() => router.history.back());
    expect((await screen.findByTestId("workflow-instance-graph")).textContent).toContain("connected-only-step");
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("states an unreadable connected library explicitly and never falls back to the selected host", async () => {
    const remote = library([{ name: "release", version: "1", step: "remote-only-step" }]);
    serve({ local: Response.json({ error: "library_unavailable" }, { status: 503 }), remote, selected: "far", traces: { "wf-a": instance("wf-a", "release", "1") } });
    const { client } = mount("/workflow/instance/wf-a");
    await waitFor(() => expect(screen.getByTestId("workflow-spec-state").getAttribute("data-state")).toBe("unavailable"));
    expect(screen.getByTestId("workflow-spec-state").textContent).toContain("No other host");
    expect(screen.queryByTestId("workflow-instance-graph")).toBeNull();
    expect((screen.getByTestId("workflow-view-spec") as HTMLButtonElement).disabled).toBe(true);
    expect(reviewKeys(client)).toEqual([]);
    expect(requests.some((r) => r.url.includes("host=far"))).toBe(false);
  });

  it("states an absent exact entry instead of drawing a different version", async () => {
    const local = library([{ name: "release", version: "2", step: "other-version-step" }]);
    serve({ local, traces: { "wf-a": instance("wf-a", "release", "1") } });
    mount("/workflow/instance/wf-a");
    await waitFor(() => expect(screen.getByTestId("workflow-spec-state").getAttribute("data-state")).toBe("absent"));
    expect(screen.queryByTestId("workflow-instance-graph")).toBeNull();
    expect((screen.getByTestId("workflow-view-spec") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("WorkflowsPage spec links", () => {
  it("opens the exact served colon-version entry from the connected library and disables unmatched tuples", async () => {
    const local = library([{ name: "release", version: "1:2", step: "correct-exact-step" }, { name: "release:1", version: "2", step: "wrong-sibling-step" }]);
    const entries = await (await local.request("/api/specs/library")).json() as SpecLibraryEntry[];
    const exactId = entries.find((e) => e.name === "release")!.id;
    serve({ local, selected: "far", traces: { "wf-a": instance("wf-a", "release", "1:2"), "wf-b": instance("wf-b", "missing", "9") } });
    const { router } = mount("/workflows");
    await waitFor(() => expect(screen.getByTestId("workflows-group-spec-release").getAttribute("data-spec")).toBe("matched"));
    expect((screen.getByTestId("workflows-group-spec-missing") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("workflows-group-spec-release"));
    expect((await screen.findByTestId("library-destination")).getAttribute("data-entry")).toBe(exactId);
    expect(new URLSearchParams(router.state.location.publicHref.split("?")[1]).get("source")).toBe("local");
  });
});

// Ported from /private/tmp/openrig-workflow-spec-warm-review.test.tsx: a warm
// catalog or review whose refresh then fails (real Hono success, then HTTP 503)
// keeps its last-good shape only as an explicitly stale observation dated by
// its original successful read. Observer updates are awaited (React Query
// delivers them on its notification tick), never inferred from cache state.
describe("library refresh failures beside a retained shape", () => {
  const keyFor = (client: QueryClient, target: "catalog" | "review") =>
    target === "catalog" ? ["spec-library", "workflow", "local"] : reviewKeys(client)[0]!;
  const readAt = (testId: string) => screen.getByTestId(testId).getAttribute("datetime");
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

  for (const target of ["catalog", "review"] as const) {
    it(`discloses a failed ${target} refresh with the original read time, keeps no other host, and recovers on retry`, async () => {
      const local = library([{ name: "release", version: "1", step: "cached-connected-step" }]);
      const remote = library([{ name: "release", version: "1", step: "remote-only-step" }]);
      const opts = { local: local as Hono | Response, remote, selected: "far" as const, traces: { "wf-a": instance("wf-a", "release", "1") } };
      serve(opts);
      const { client } = mount("/workflow/instance/wf-a");
      await waitFor(() => expect(screen.getByTestId("workflow-instance-graph").textContent).toContain("cached-connected-step"));
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect(screen.queryByTestId("workflow-spec-stale")).toBeNull();
      const query = client.getQueryCache().find({ queryKey: keyFor(client, target), exact: true })!;
      const succeededAt = new Date(query.state.dataUpdatedAt).toISOString();
      expect(readAt(`workflow-spec-${target}-read-at`)).toBe(succeededAt);

      await pause();
      opts.local = Response.json({ error: "service_unavailable" }, { status: 503 });
      await act(async () => { await client.refetchQueries({ queryKey: keyFor(client, target), exact: true }); });
      const notice = await screen.findByTestId("workflow-spec-stale");
      expect(notice.getAttribute("data-failed")).toBe(target);
      expect(screen.getByTestId(`workflow-spec-stale-${target}`).textContent).toContain("HTTP 503");
      // Retained shape stays attributable and dated by its successful read, not the failure.
      expect(query.state.errorUpdatedAt).toBeGreaterThan(query.state.dataUpdatedAt);
      expect(readAt(`workflow-spec-${target}-read-at`)).toBe(succeededAt);
      expect(screen.getByTestId("workflow-instance-graph").textContent).toContain("cached-connected-step");
      expect(screen.getByTestId("workflow-instance-graph").textContent).not.toContain("remote-only-step");
      expect(screen.getByTestId("workflow-spec-source").getAttribute("data-stale")).toBe("true");
      expect(screen.getByTestId("workflow-spec-source").textContent).toContain("last successful read, not current");
      expect(screen.getByTestId("workflow-view-spec").getAttribute("data-stale")).toBe("true");
      expect(screen.getByTestId("workflow-view-spec").getAttribute("title")).toContain("latest library refresh failed");
      expect(requests.some((r) => r.url.startsWith("/api/specs/library") && r.url.includes("host="))).toBe(false);

      await pause();
      opts.local = local;
      fireEvent.click(screen.getByTestId("workflow-spec-stale-retry"));
      await waitFor(() => expect(screen.queryByTestId("workflow-spec-stale")).toBeNull());
      expect(screen.getByTestId("workflow-spec-source").getAttribute("data-stale")).toBe("false");
      expect(Date.parse(readAt(`workflow-spec-${target}-read-at`)!)).toBeGreaterThan(Date.parse(succeededAt));
      expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    });
  }

  it("control: a successful refresh shows no stale notice and advances the read time", async () => {
    const local = library([{ name: "release", version: "1", step: "cached-connected-step" }]);
    serve({ local, traces: { "wf-a": instance("wf-a", "release", "1") } });
    const { client } = mount("/workflow/instance/wf-a");
    await screen.findByTestId("workflow-instance-graph");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const before = readAt("workflow-spec-review-read-at")!;
    await pause();
    await act(async () => { await client.refetchQueries({ queryKey: ["spec-library"] }); });
    await waitFor(() => expect(Date.parse(readAt("workflow-spec-review-read-at")!)).toBeGreaterThan(Date.parse(before)));
    expect(screen.queryByTestId("workflow-spec-stale")).toBeNull();
    expect(screen.getByTestId("workflow-spec-source").getAttribute("data-stale")).toBe("false");
    expect(screen.getByTestId("workflow-view-spec").getAttribute("data-stale")).toBe("false");
  });
});
