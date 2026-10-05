// Library navigation, source inspection and observed seat provenance
// (gui-library-provenance-ui.md). Mounted catalog → filter → exact review →
// declared/observed consumers → exact seat → Back, the kind/name resolver,
// typed review failures, seat provenance, and the active-lens callers bound
// to their review's origin. Fictional fixtures only (twin/library-fixtures.ts
// and private in-memory daemon routes); no disk outside a temp dir, no fleet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, useParams, useRouterState,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { coreSchema } from "../../daemon/src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../../daemon/src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache } from "../../daemon/src/domain/workflow-spec-cache.js";
import { SpecLibraryService } from "../../daemon/src/domain/spec-library-service.js";
import { SpecReviewService } from "../../daemon/src/domain/spec-review-service.js";
import { ActiveLensStore } from "../../daemon/src/domain/active-lens-store.js";
import { specLibraryRoutes } from "../../daemon/src/routes/spec-library.js";
import { SpecsLibraryPage } from "../src/components/specs/SpecsLibraryPage.js";
import { SpecsTreeView } from "../src/components/specs/SpecsTreeView.js";
import { NodeInventoryPartialReadError } from "../src/lib/fleet-inventory-reads.js";
import { SpecLookupPage } from "../src/components/specs/SpecLookupPage.js";
import { SeatSpecProvenance, type SeatSpecFacts } from "../src/components/specs/SeatSpecProvenance.js";
import { LibraryReview } from "../src/components/LibraryReview.js";
import { shellRouterOptions } from "../src/components/shell/history-scroll.js";
import type { HostsResponse } from "../src/hooks/useHosts.js";
import { useActiveLensActions, useLibraryReview } from "../src/hooks/useSpecLibrary.js";
import { LIBRARY_TWIN_HASH, LIBRARY_TWIN_IDS as IDS, libraryTwinBody, libraryTwinInventory, resetLibraryTwin } from "../twin/library-fixtures.js";

const hostsFor = (selected: string): HostsResponse => ({ ownName: "Fictional", selected, hosts: [] });
const requests: Array<{ method: string; url: string }> = [];
/** What GET /api/hosts serves (null → unavailable). Set by mount(). */
let servedHosts: HostsResponse | null = null;
const clients: QueryClient[] = [];
const disposers: Array<() => void> = [];

beforeEach(() => {
  resetLibraryTwin();
  window.sessionStorage.clear();
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((qc) => qc.clear());
  disposers.splice(0).reverse().forEach((dispose) => dispose());
  requests.length = 0;
  vi.unstubAllGlobals();
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Records every request; library fixture first, then overrides, then empty lists. */
function stubFetch(override: Handler = () => undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://fixture.invalid");
    requests.push({ method: init?.method ?? "GET", url: url.pathname + url.search });
    const custom = await override(url, init);
    if (custom) return custom;
    const fixture = libraryTwinBody(url.pathname, url.searchParams, init?.method ?? "GET", init?.body);
    if (fixture) return json(fixture.body, fixture.status);
    if (url.pathname === "/api/hosts") return servedHosts ? json(servedHosts) : json({ error: "hosts_unavailable" }, 503);
    if (url.pathname === "/api/rigs/summary") {
      return json([
        { id: "rig-observer", name: "observer-rig", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null },
        { id: "rig-unreadable", name: "unreadable-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
      ]);
    }
    if (["/api/agent-images/library", "/api/plugins", "/api/skills/library", "/api/workflow/list"].includes(url.pathname)) return json([]);
    return json({ error: "not_in_fixture" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const rawSearch = (href: string) => new URLSearchParams(href.split("#")[0]!.split("?")[1] ?? "");
function useRawSearch() {
  const href = useRouterState({ select: (state) => (state.location as { publicHref?: string }).publicHref ?? state.location.href });
  return rawSearch(href);
}

/** Same route shapes as routes.tsx (library review + proposed kind/name mount). */
function mount(initialPath: string, hosts: HostsResponse | null = hostsFor("local")) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(qc);
  if (hosts) qc.setQueryData(["hosts"], hosts);
  servedHosts = hosts;
  const root = createRootRoute({ component: () => <QueryClientProvider client={qc}><Outlet /></QueryClientProvider> });
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/specs", component: SpecsLibraryPage }),
    createRoute({ getParentRoute: () => root, path: "/tree-fixture", component: SpecsTreeView }),
    createRoute({ getParentRoute: () => root, path: "/specs/library/$entryId", component: () => {
      const { entryId } = useParams({ strict: false }) as { entryId: string };
      const search = useRawSearch();
      return <LibraryReview entryId={entryId} sourceHostId={search.has("source") ? search.get("source")! : undefined} />;
    } }),
    createRoute({ getParentRoute: () => root, path: "/specs/$specKind/$specName", component: () => {
      const { specKind, specName } = useParams({ strict: false }) as { specKind: string; specName: string };
      const search = useRawSearch();
      return <SpecLookupPage kind={specKind} name={specName} version={search.get("version") ?? undefined} source={search.get("source") ?? undefined} />;
    } }),
    createRoute({ getParentRoute: () => root, path: "/topology/seat/$rigId/$logicalId", component: () => {
      const { rigId, logicalId } = useParams({ strict: false }) as { rigId: string; logicalId: string };
      return <div data-testid="seat-route" data-rig={rigId} data-logical={logicalId} data-source={useRawSearch().get("sourceHost") ?? ""}>seat</div>;
    } }),
    ...["/discovery/inventory", "/import", "/agents/validate", "/search"].map((path) =>
      createRoute({ getParentRoute: () => root, path, component: () => <div data-testid="stub-route">{path}</div> })),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [initialPath] }), ...shellRouterOptions() });
  render(<RouterProvider router={router} />);
  return { qc, router };
}

const libPath = (id: string, source?: string) => `/specs/library/${encodeURIComponent(id)}${source ? `?source=${source}` : ""}`;
const writes = () => requests.filter((r) => r.method !== "GET");

describe("catalog: filter, toolbar and read states", () => {
  it("filters by text, kind and source; keeps the filter and last-opened row across Back; no-match is not empty", async () => {
    stubFetch();
    const { router } = mount("/specs");
    const agents = await screen.findByTestId("library-section-agent-specs");
    await waitFor(() => expect(within(agents).getAllByRole("link")).toHaveLength(5));

    fireEvent.change(screen.getByTestId("library-filter-text"), { target: { value: "reviewer" } });
    fireEvent.change(screen.getByTestId("library-filter-kind"), { target: { value: "agent" } });
    await waitFor(() => expect(rawSearch(router.state.location.href).get("kind")).toBe("agent"));
    expect(screen.queryByTestId("library-section-rig-specs")).toBeNull();
    const rows = within(screen.getByTestId("library-section-agent-specs")).getAllByRole("link");
    expect(rows).toHaveLength(3);
    // Same-named rows reveal version/source/path; never ID fragments.
    const facts = rows.map((row) => within(row).getByTestId("library-row-facts").textContent);
    expect(facts).toEqual(expect.arrayContaining([expect.stringContaining("v1 · built-in"), expect.stringContaining("v1 · user file"), expect.stringContaining("v2 · user file")]));
    expect(facts.join(" ")).not.toContain("specfile:");

    fireEvent.change(screen.getByTestId("library-filter-origin"), { target: { value: "builtin" } });
    await waitFor(() => expect(within(screen.getByTestId("library-section-agent-specs")).getAllByRole("link")).toHaveLength(1));

    fireEvent.click(within(screen.getByTestId("library-section-agent-specs")).getByRole("link"));
    await screen.findByTestId("library-review-agent");
    act(() => router.history.back());
    await screen.findByTestId("specs-library-page");
    expect((screen.getByTestId("library-filter-text") as HTMLInputElement).value).toBe("reviewer");
    expect((screen.getByTestId("library-filter-kind") as HTMLSelectElement).value).toBe("agent");
    expect((screen.getByTestId("library-filter-origin") as HTMLSelectElement).value).toBe("builtin");
    expect(screen.getByTestId(`library-row-agent-specs-${IDS.reviewerBuiltin}`).getAttribute("aria-current")).toBe("true");

    fireEvent.change(screen.getByTestId("library-filter-text"), { target: { value: "no-such-spec" } });
    await waitFor(() => expect(screen.getByTestId("library-section-agent-specs-empty").textContent).toMatch(/No matches for the current filter \(5 hidden\)/));
    expect(writes()).toEqual([]);
  });

  it("every toolbar label reaches its operation; generation is explicit unavailable guidance", async () => {
    stubFetch();
    mount("/specs");
    await screen.findByTestId("specs-library-page");
    expect(screen.getByTestId("specs-toolbar-discover").getAttribute("href")).toBe("/discovery/inventory");
    expect(screen.getByTestId("specs-toolbar-import").getAttribute("href")).toBe("/import");
    expect(screen.getByTestId("specs-toolbar-validate-agent").getAttribute("href")).toBe("/agents/validate");
    expect(screen.queryByText(/Generate workflow/i)).toBeNull();
    expect(document.querySelector('a[href="/search"], a[href="/specs/agent"], a[href="/specs/rig"]')).toBeNull();
    fireEvent.click(screen.getByTestId("specs-toolbar-authoring"));
    expect(screen.getByTestId("specs-workflow-generation-unavailable").textContent).toMatch(/not available in the GUI.*rig workflow validate/s);
    expect(screen.getByTestId("specs-authoring-guidance").textContent).toContain("rig specs add <path>");
    fireEvent.click(screen.getByTestId("specs-toolbar-discover"));
    await waitFor(() => expect(screen.getByTestId("stub-route").textContent).toBe("/discovery/inventory"));
  });

  it("a failed refresh keeps the dated list as stale; a failed first read is unavailable, not empty", async () => {
    let failSpecs = false;
    stubFetch((url) => (failSpecs && url.pathname === "/api/specs/library" ? json({ error: "library_down" }, 503) : undefined));
    const { qc } = mount("/specs");
    await waitFor(() => expect(screen.getByTestId("library-section-rig-specs-read").getAttribute("data-state")).toBe("ok"));
    failSpecs = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["spec-library"] }); });
    const read = screen.getByTestId("library-section-rig-specs-read");
    await waitFor(() => expect(read.getAttribute("data-state")).toBe("stale"));
    expect(read.textContent).toMatch(/latest refresh failed.*503/);
    expect(within(screen.getByTestId("library-section-rig-specs")).getAllByRole("link")).toHaveLength(2);
    // Libraries are independent: context packs are still current.
    expect(screen.getByTestId("library-section-context-packs-read").getAttribute("data-state")).toBe("ok");

    cleanup();
    mount("/specs");
    await waitFor(() => expect(screen.getByTestId("library-section-rig-specs-read").getAttribute("data-state")).toBe("failed"));
    expect(screen.getByTestId("library-section-rig-specs-read").textContent).toMatch(/unavailable/);
    expect(screen.getByTestId("library-section-rig-specs-empty").textContent).not.toMatch(/No rig specs found/);
  });
});

describe("kind/name resolver: exact served candidates, never name-as-ID or first match", () => {
  it("same name in two roots and two versions requires a choice; links carry the exact ID and origin", async () => {
    stubFetch();
    const { router } = mount("/specs/agent/reviewer");
    const list = await screen.findByTestId("spec-lookup-ambiguous");
    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(3);
    for (const id of [IDS.reviewerBuiltin, IDS.reviewerUser, IDS.reviewerV2]) {
      expect(links.some((link) => link.getAttribute("href") === libPath(id, "local"))).toBe(true);
    }
    expect(router.state.location.pathname).toBe("/specs/agent/reviewer");
    expect(requests.some((r) => r.url.includes("/review"))).toBe(false);
    // `running <spec>`: observed seats for the name are shown with the choice.
    expect(screen.getByTestId("observed-seats")).toBeTruthy();
  });

  it("an exact version forwards with replace; Back skips the lookup", async () => {
    stubFetch();
    const { router } = mount("/specs");
    await screen.findByTestId("specs-library-page");
    act(() => router.history.push("/specs/agent/reviewer?version=2"));
    await screen.findByTestId("library-review-agent");
    expect(router.state.location.pathname).toBe(`/specs/library/${encodeURIComponent(IDS.reviewerV2)}`);
    expect(screen.getByTestId("library-review-origin").textContent).toBe("From the connected instance");
    act(() => router.history.back());
    await screen.findByTestId("specs-library-page");
  });

  it("reserved characters resolve exactly; a name of another kind is unavailable; a bad kind reads nothing", async () => {
    stubFetch();
    const { router } = mount(`/specs/agent/${encodeURIComponent("planner: alpha/beta 1.0")}`);
    await screen.findByTestId("library-review-agent");
    expect(router.state.location.pathname).toBe(`/specs/library/${encodeURIComponent(IDS.plannerReserved)}`);
    cleanup();

    mount("/specs/workflow/reviewer");
    expect((await screen.findByTestId("spec-lookup-unavailable")).textContent).toMatch(/No workflow spec named “reviewer”/);
    cleanup();

    requests.length = 0;
    mount("/specs/bogus/reviewer");
    await screen.findByTestId("spec-lookup-bad-kind");
    expect(requests.filter((r) => r.url.startsWith("/api/specs"))).toEqual([]);
  });

  it("an unreadable host selection chooses no library and never presumes local", async () => {
    stubFetch((url) => (url.pathname === "/api/hosts" ? json({ error: "hosts_down" }, 503) : undefined));
    mount("/specs/agent/reviewer", null);
    await screen.findByTestId("spec-lookup-hosts-failed");
    expect(requests.filter((r) => r.url.startsWith("/api/specs"))).toEqual([]);
  });
});

describe("review read failures are typed", () => {
  it.each([
    [IDS.legacy, "reselect", /Reselect This Spec/],
    [IDS.moved, "reselect", /Reselect This Spec/],
    ["specfile:v2:" + "f".repeat(64), "absent", /Spec Not Found/],
  ])("%s → %s", async (id, kind, title) => {
    stubFetch();
    mount(libPath(id, "local"));
    const failure = await screen.findByTestId("library-review-error");
    expect(failure.getAttribute("data-failure")).toBe(kind);
    expect(failure.textContent).toMatch(title);
  });

  it("an unavailable library is not 'not found' and Retry reads again", async () => {
    let down = true;
    stubFetch((url) => (down && url.pathname.endsWith("/review") ? json({ error: "library_down" }, 503) : undefined));
    mount(libPath(IDS.reviewerUser, "local"));
    const failure = await screen.findByTestId("library-review-error");
    expect(failure.getAttribute("data-failure")).toBe("unavailable");
    expect(failure.textContent).not.toMatch(/Not Found/);
    down = false;
    fireEvent.click(screen.getByTestId("library-review-retry"));
    await screen.findByTestId("library-review-agent");
  });

  it("context-pack list row stays current when only its preview fails", async () => {
    stubFetch();
    mount(libPath("context-pack:fixture-brief"));
    await screen.findByTestId("library-review-context-pack");
    expect((await screen.findByTestId("lib-pack-preview-error")).textContent).toMatch(/bundle preview unavailable/);
    expect(screen.queryByTestId("library-review-error")).toBeNull();
  });

  it("a failed context-pack list is unavailable, not 'not found'", async () => {
    stubFetch((url) => (url.pathname === "/api/context-packs/library" ? json({ error: "boom" }, 500) : undefined));
    mount(libPath("context-pack:fixture-brief"));
    const failure = await screen.findByTestId("library-review-error");
    expect(failure.getAttribute("data-failure")).toBe("unavailable");
    expect(failure.textContent).not.toMatch(/Not Found/);
  });
});

describe("declared versus observed consumers → exact seat → Back", () => {
  it("separates a declared-only rig from another rig's observed seat and drills to the exact seat", async () => {
    stubFetch();
    const { router } = mount("/specs");
    await screen.findByTestId("specs-library-page");
    act(() => router.history.push(libPath(IDS.reviewerUser, "local")));
    await screen.findByTestId("library-review-agent");
    expect(screen.getByTestId("library-authored-source").textContent).toContain("/fixture/user/agents/reviewer/agent.yaml");

    const observed = screen.getByTestId("observed-seats");
    const seat = await within(observed).findByTestId("observed-seat");
    expect(seat.getAttribute("data-rig")).toBe("rig-observer");
    expect(seat.getAttribute("data-logical")).toBe("dev.rev/1%");
    expect(within(seat).getByTestId("observed-seat-lifecycle").textContent).toBe("running");
    expect(within(seat).getByTestId("observed-seat-hash").getAttribute("title")).toBe(LIBRARY_TWIN_HASH);
    // Two catalog entries share reviewer v1: the binding is not attributed.
    expect(within(observed).getByTestId("observed-seats-ambiguous").textContent).toMatch(/2 library entries/);
    // A failed rig is unknown coverage, never zero.
    await waitFor(() => expect(within(observed).getByTestId("observed-seats-coverage").textContent).toMatch(/unreadable-rig: inventory unavailable/));
    expect(within(observed).getByTestId("observed-seats-count").textContent).toMatch(/coverage incomplete/);
    expect(within(observed).queryByTestId("observed-seats-none")).toBeNull();

    const declared = screen.getByTestId("declared-by");
    fireEvent.click(within(declared).getByTestId("declared-by-check"));
    const rows = await within(declared).findAllByTestId("declared-by-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/pair · dev\.rev · local:agents\/reviewer/);
    expect(within(declared).queryByText(/observer-rig/)).toBeNull();

    fireEvent.click(within(seat).getByTestId("observed-seat-link"));
    const seatRoute = await screen.findByTestId("seat-route");
    expect(seatRoute.getAttribute("data-rig")).toBe("rig-observer");
    expect(seatRoute.getAttribute("data-logical")).toBe("dev.rev/1%");
    expect(seatRoute.getAttribute("data-source")).toBe("local");
    act(() => router.history.back());
    await screen.findByTestId("library-review-agent");
    expect(router.state.location.pathname).toBe(`/specs/library/${encodeURIComponent(IDS.reviewerUser)}`);
    expect(writes()).toEqual([]);
  });

  it("rig members resolve only exact authored paths; other refs are retained as written", async () => {
    stubFetch();
    mount(libPath(IDS.pairRig, "local"));
    const refs = await screen.findByTestId("lib-member-refs");
    await waitFor(() => expect(within(refs).getByTestId("lib-member-ref-dev-rev").getAttribute("data-state")).toBe("catalog"));
    expect(within(refs).getByTestId("lib-member-ref-dev-rev").querySelector("a")!.getAttribute("href")).toBe(libPath(IDS.reviewerUser, "local"));
    expect(within(refs).getByTestId("lib-member-ref-dev-ext").getAttribute("data-state")).toBe("nonstandard");
    expect(within(refs).getByTestId("lib-member-ref-dev-ext").textContent).toContain("registry:acme/reviewer@3");
  });
});

describe("seat spec provenance (spec-of)", () => {
  const seat = (over: Partial<SeatSpecFacts>): SeatSpecFacts => ({
    rigId: "rig-observer", rigName: "observer-rig", logicalId: "dev.rev/1%", runtime: "claude-code", model: null,
    agentRef: "local:agents/reviewer", profile: "default", resolvedSpecName: "reviewer", resolvedSpecVersion: "1",
    resolvedSpecHash: LIBRARY_TWIN_HASH, ...over,
  });
  function renderProvenance(props: { hostId: string | null; seat: SeatSpecFacts }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(qc);
    const root = createRootRoute({ component: () => <QueryClientProvider client={qc}><SeatSpecProvenance {...props} /></QueryClientProvider> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) })} />);
  }

  it("source deleted after launch keeps the launched binding and says no current entry exists", async () => {
    stubFetch();
    renderProvenance({ hostId: "local", seat: seat({ resolvedSpecName: "ghost-spec", resolvedSpecHash: "sha256:dead" }) });
    expect((await screen.findByTestId("seat-spec-library-missing")).textContent).toMatch(/No current library entry is named ghost-spec v1/);
    expect(screen.getByTestId("seat-spec-hash").textContent).toBe("sha256:dead");
  });

  it("an ambiguous binding lists every candidate and chooses none; other versions are disclosed", async () => {
    stubFetch();
    renderProvenance({ hostId: "local", seat: seat({}) });
    const ambiguous = await screen.findByTestId("seat-spec-library-ambiguous");
    expect(within(ambiguous).getAllByRole("link")).toHaveLength(2);
    expect(screen.getByTestId("seat-spec-other-versions").textContent).toMatch(/v2 of reviewer/);
  });

  it("an unknown origin reads no library; a failed library is unknown, not missing", async () => {
    stubFetch();
    renderProvenance({ hostId: null, seat: seat({}) });
    await screen.findByTestId("seat-spec-origin-unknown");
    expect(requests.filter((r) => r.url.startsWith("/api/specs"))).toEqual([]);
    cleanup();

    stubFetch((url) => (url.pathname === "/api/specs/library" ? json({ error: "down" }, 503) : undefined));
    renderProvenance({ hostId: "local", seat: seat({ resolvedSpecName: "ghost-spec" }) });
    await screen.findByTestId("seat-spec-library-failed");
    expect(screen.queryByTestId("seat-spec-library-missing")).toBeNull();
  });
});

// --- Active lens: both callers bind their review's origin (ported from the
// private 3 RED / 1 control repro against actual daemon routes + store).

function lensDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "openrig-library-lens-"));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = createDb();
  disposers.push(() => db.close());
  migrate(db, [coreSchema, workflowSpecsSchema]);
  const file = join(dir, "fixture-workflow.yaml");
  writeFileSync(file, "workflow:\n  id: fixture-lens\n  version: \"1\"\n  objective: Fictional lens spec\n  entry:\n    role: worker\n  roles:\n    worker: {}\n  steps:\n    - id: one\n      actor_role: worker\n      allowed_exits: [done]\n  invariants:\n    allowed_exits: [done]\n");
  new WorkflowSpecCache(db).readThrough(file);
  const review = new SpecReviewService();
  const library = new SpecLibraryService({ roots: [], specReviewService: review });
  const store = new ActiveLensStore({ filePath: join(dir, "fixture-lens.json") });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("specLibraryService" as never, library as never); c.set("specReviewService" as never, review as never);
    c.set("activeLensStore" as never, store as never); c.set("rigRepo" as never, { db } as never); c.set("rigRepoDb" as never, db as never);
    await next();
  });
  app.route("/api/specs/library", specLibraryRoutes());
  stubFetch(async (url, init) => {
    if (url.pathname.startsWith("/api/specs/library")) return app.request(url.pathname + url.search, { method: init?.method, headers: init?.headers, body: init?.body });
    return undefined;
  });
  return { store };
}
const LENS_ID = "workflow:fixture-lens:1";
const lensWrites = () => requests.filter((r) => r.url === "/api/specs/library/active-lens" && r.method !== "GET");
/** The click handler as rendered NOW, invoked later: a retained callback. */
function retainHandler(element: HTMLElement): () => Promise<void> {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps"))!;
  const onClick = (element as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
  return async () => { await act(async () => { onClick(); }); };
}
function setHostsError(qc: QueryClient) {
  const query = qc.getQueryCache().find({ queryKey: ["hosts"] })!;
  act(() => query.setState({ ...query.state, status: "error", error: new Error("hosts read failed"), fetchStatus: "idle" }));
}

describe("active lens callers (connected-instance preference)", () => {
  it("known-local exact POST then DELETE remain usable (control)", async () => {
    const { store } = lensDaemon();
    mount(libPath(LENS_ID));
    fireEvent.click(await screen.findByTestId("workflow-activate-lens"));
    await waitFor(() => expect(store.get()).toMatchObject({ specName: "fixture-lens", specVersion: "1" }));
    fireEvent.click(await screen.findByTestId("workflow-deactivate-lens"));
    await waitFor(() => expect(store.get()).toBeNull());
    expect(lensWrites().map((r) => r.method)).toEqual(["POST", "DELETE"]);
  });

  it.each([["remote", hostsFor("remote")], ["unknown", null]] as const)("a review under a %s selection cannot write the local lens", async (_label, hosts) => {
    const { store } = lensDaemon();
    store.set("existing-local-spec", "old");
    mount(libPath(LENS_ID), hosts);
    const button = await screen.findByTestId("workflow-activate-lens");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("workflow-lens-blocked").textContent).toBeTruthy();
    fireEvent.click(button);
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toMatchObject({ specName: "existing-local-spec" });
  });

  it("a retained activate callback after local→remote rejects before POST and shows the reason on that review", async () => {
    const { store } = lensDaemon();
    const { qc } = mount(libPath(LENS_ID));
    const retained = retainHandler(await screen.findByTestId("workflow-activate-lens"));
    act(() => { qc.setQueryData(["hosts"], hostsFor("remote")); });
    await retained();
    expect((await screen.findByTestId("workflow-lens-error")).textContent).toMatch(/select the local host/i);
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toBeNull();
  });

  it("a retained deactivate callback after local→remote rejects before DELETE", async () => {
    const { store } = lensDaemon();
    store.set("fixture-lens", "1");
    const { qc } = mount(libPath(LENS_ID));
    const retained = retainHandler(await screen.findByTestId("workflow-deactivate-lens"));
    act(() => { qc.setQueryData(["hosts"], hostsFor("remote")); });
    await retained();
    await screen.findByTestId("workflow-lens-error");
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toMatchObject({ specName: "fixture-lens" });
  });

  it("a remote-origin review stays unable to write after switching remote→local, including a retained callback", async () => {
    const { store } = lensDaemon();
    const { qc } = mount(libPath(LENS_ID, "remote"), hostsFor("remote"));
    expect((await screen.findByTestId("library-review-origin")).textContent).toBe("From host remote");
    const retained = retainHandler(await screen.findByTestId("workflow-activate-lens"));
    act(() => { qc.setQueryData(["hosts"], hostsFor("local")); });
    await waitFor(() => expect(screen.getByTestId("workflow-lens-blocked").textContent).toMatch(/read from host remote/));
    await retained();
    expect((await screen.findByTestId("workflow-lens-error")).textContent).toMatch(/remote or unknown/);
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toBeNull();
  });

  it("a failed hosts read with cached local data is not authority", async () => {
    const { store } = lensDaemon();
    const { qc } = mount(libPath(LENS_ID));
    const button = await screen.findByTestId("workflow-activate-lens");
    const retained = retainHandler(button);
    setHostsError(qc);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    await retained();
    expect((await screen.findByTestId("workflow-lens-error")).textContent).toMatch(/successful known host selection/);
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toBeNull();
  });
});

// Direct port of /private/tmp/openrig-active-lens-scope-review.test.tsx onto
// the new API: the review query's own origin plus the owning QueryClient's
// current hosts state at invocation.
describe("active lens actions bound to the exact review query (hook port)", () => {
  function renderLens(selection: "local" | "remote" | null, options: { sourceHostId?: string } = {}) {
    const { store } = lensDaemon();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    clients.push(qc);
    if (selection) qc.setQueryData(["hosts"], hostsFor(selection));
    const hook = renderHook(() => ({ review: useLibraryReview(LENS_ID, options), actions: useActiveLensActions() }), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    return { ...hook, qc, store };
  }
  const input = (current: { review: ReturnType<typeof useLibraryReview> }, origin = current.review.sourceHostId) =>
    ({ originHostId: origin, specName: current.review.data!.name, specVersion: current.review.data!.version });

  it.each(["remote", null] as const)("an exact review under %s context cannot POST/DELETE the local lens", async (selection) => {
    const { result, store } = renderLens(selection);
    await waitFor(() => expect(result.current.review.data?.name).toBe("fixture-lens"));
    if (selection === "remote") expect(requests.some((r) => r.url.includes("host=remote"))).toBe(true);
    store.set("existing-local-spec", "old-version");
    await expect(result.current.actions.setActiveLens(input(result.current))).rejects.toThrow();
    await expect(result.current.actions.clearActiveLens({ originHostId: result.current.review.sourceHostId })).rejects.toThrow();
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toMatchObject({ specName: "existing-local-spec", specVersion: "old-version" });
  });

  it("known local exact name/version POST and DELETE remain supported (control)", async () => {
    const { result, store } = renderLens("local");
    await waitFor(() => expect(result.current.review.data?.name).toBe("fixture-lens"));
    await result.current.actions.setActiveLens(input(result.current));
    expect(store.get()).toMatchObject({ specName: "fixture-lens", specVersion: "1" });
    await result.current.actions.clearActiveLens({ originHostId: result.current.review.sourceHostId });
    expect(store.get()).toBeNull();
  });

  it("a retained clear after local→remote does not DELETE", async () => {
    const { result, qc, store } = renderLens("local");
    await waitFor(() => expect(result.current.review.data?.name).toBe("fixture-lens"));
    store.set("existing-local-spec", "1");
    const retained = { clear: result.current.actions.clearActiveLens, origin: result.current.review.sourceHostId };
    act(() => { qc.setQueryData(["hosts"], hostsFor("remote")); });
    await expect(retained.clear({ originHostId: retained.origin })).rejects.toThrow();
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toMatchObject({ specName: "existing-local-spec" });
  });

  it("a retained set from a remote-origin review after remote→local does not POST", async () => {
    const { result, qc, store } = renderLens("remote");
    await waitFor(() => expect(result.current.review.data?.name).toBe("fixture-lens"));
    const retained = { set: result.current.actions.setActiveLens, args: input(result.current) };
    expect(retained.args.originHostId).toBe("remote");
    act(() => { qc.setQueryData(["hosts"], hostsFor("local")); });
    await expect(retained.set(retained.args)).rejects.toThrow(/remote or unknown/);
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toBeNull();
  });

  it("a failed hosts read with cached local data rejects both actions", async () => {
    const { result, qc, store } = renderLens("local");
    await waitFor(() => expect(result.current.review.data?.name).toBe("fixture-lens"));
    store.set("existing-local-spec", "1");
    setHostsError(qc);
    await expect(result.current.actions.setActiveLens(input(result.current))).rejects.toThrow(/successful known host selection/);
    await expect(result.current.actions.clearActiveLens({ originHostId: "local" })).rejects.toThrow(/successful known host selection/);
    expect(lensWrites()).toEqual([]);
    expect(store.get()).toMatchObject({ specName: "existing-local-spec" });
  });
});

// --- Repairs from gui-library-independent-review.md (four groups) plus the
// active-lens read state and review-origin file attribution.

const onlyObserverRig = [{ id: "rig-observer", name: "observer-rig", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }];
const hrefSource = (element: Element) => new URL(element.getAttribute("href")!, "http://fixture.invalid").searchParams.get("source");

describe("repair 1: catalog links keep the origin that served their IDs", () => {
  it("spec rows carry the selected-host origin; connected libraries are explicitly local", async () => {
    stubFetch();
    mount("/specs", hostsFor("remote:1.0"));
    const row = await screen.findByTestId(`library-row-agent-specs-${IDS.reviewerUser}`);
    expect(hrefSource(row)).toBe("remote:1.0");
    expect(hrefSource(await screen.findByTestId("library-row-context-packs-context-pack:fixture-brief"))).toBe("local");
  });

  it("a saved remote catalog link still reads the remote review after the selection becomes local", async () => {
    stubFetch();
    const { qc, router } = mount("/specs", hostsFor("remote"));
    const href = (await screen.findByTestId(`library-row-agent-specs-${IDS.reviewerUser}`)).getAttribute("href")!;
    act(() => { qc.setQueryData(["hosts"], hostsFor("local")); router.history.push(href); });
    await screen.findByTestId("library-review-agent");
    expect(screen.getByTestId("library-review-origin").textContent).toBe("From host remote");
    const read = requests.findLast((r) => r.url.includes(encodeURIComponent(IDS.reviewerUser)) && r.url.includes("/review"));
    expect(new URL(read!.url, "http://fixture.invalid").searchParams.get("host")).toBe("remote");
  });

  it("explorer tree leaves carry the same origin", async () => {
    stubFetch();
    mount("/tree-fixture", hostsFor("remote"));
    fireEvent.click(await screen.findByTestId("specs-section-toggle-agent-specs"));
    expect(hrefSource(await screen.findByTestId(`specs-leaf-${IDS.reviewerUser}`))).toBe("remote");
    fireEvent.click(screen.getByTestId("specs-section-toggle-context-packs"));
    expect(hrefSource(await screen.findByTestId("specs-leaf-context-pack:fixture-brief"))).toBe("local");
  });
});

describe("repair 2: an unversioned lookup covers every served version of the exact name", () => {
  it("absent version shows the v1 seat without attributing it to one entry", async () => {
    stubFetch((url) => (url.pathname === "/api/rigs/summary" ? json(onlyObserverRig) : undefined));
    mount("/specs/agent/reviewer?source=local");
    await screen.findByTestId("spec-lookup-ambiguous");
    const seat = await screen.findByTestId("observed-seat");
    expect(seat.getAttribute("data-logical")).toBe("dev.rev/1%");
    expect(seat.textContent).toContain("launched reviewer v1");
    expect(screen.getByTestId("observed-seats-ambiguous").textContent).toMatch(/3 library entries share this name/);
    expect(screen.queryByTestId("observed-seats-none")).toBeNull();
  });

  it("explicit version bytes stay exact: v1 keeps the seat (control), an empty version does not match v1", async () => {
    stubFetch((url) => (url.pathname === "/api/rigs/summary" ? json(onlyObserverRig) : undefined));
    mount("/specs/agent/reviewer?source=local&version=1");
    expect((await screen.findByTestId("observed-seat")).getAttribute("data-logical")).toBe("dev.rev/1%");
    cleanup();
    mount("/specs/agent/reviewer?source=local&version=");
    await screen.findByTestId("spec-lookup-unavailable");
    await screen.findByTestId("observed-seats-none");
    expect(screen.queryByTestId("observed-seat")).toBeNull();
  });
});

describe("repair 3: observed coverage keeps partial and retained evidence separate", () => {
  it("a first partial inventory shows its verified sibling with its own receipt; coverage stays incomplete", async () => {
    stubFetch((url) => (url.pathname === "/api/rigs/summary" ? json(onlyObserverRig)
      : url.pathname === "/api/rigs/rig-observer/nodes" ? json([libraryTwinInventory[0], { bad: true }]) : undefined));
    const { qc } = mount(libPath(IDS.reviewerUser, "local"));
    await waitFor(() => expect(qc.getQueryState(["rig", "rig-observer", "nodes", "local"])?.error).toBeInstanceOf(NodeInventoryPartialReadError));
    const seat = await screen.findByTestId("observed-seat");
    expect(seat.getAttribute("data-observation")).toBe("partial");
    expect(within(seat).getByTestId("observed-seat-observation").textContent).toMatch(/partial inventory received .* \(1 record rejected\)/);
    expect(screen.getByTestId("observed-seats-count").getAttribute("data-complete")).toBe("false");
    expect(screen.getByTestId("observed-seats-coverage").textContent).toMatch(/rejected 1 record/);
  });

  it("a newer partial response and the older complete read stay two observations", async () => {
    let partial = false;
    stubFetch((url) => (url.pathname === "/api/rigs/summary" ? json(onlyObserverRig)
      : url.pathname === "/api/rigs/rig-observer/nodes" ? json(partial ? [libraryTwinInventory[0], { bad: true }] : libraryTwinInventory) : undefined));
    const { qc } = mount(libPath(IDS.reviewerUser, "local"));
    await waitFor(() => expect(screen.getByTestId("observed-seats-count").getAttribute("data-complete")).toBe("true"));
    partial = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["rig", "rig-observer", "nodes", "local"], exact: true }); });
    await waitFor(() => expect(screen.getAllByTestId("observed-seat").map((e) => e.getAttribute("data-observation")).sort()).toEqual(["partial", "retained"]));
    expect(screen.getByTestId("observed-seats-count").textContent).toMatch(/coverage incomplete/);
  });

  it("a failed rig-list refresh cannot claim complete zero consumers", async () => {
    let down = false;
    stubFetch((url) => (url.pathname === "/api/rigs/summary" ? (down ? json({ error: "summary unavailable" }, 503) : json([])) : undefined));
    const { qc } = mount(libPath(IDS.reviewerUser, "local"));
    await screen.findByTestId("observed-seats-none");
    down = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["rigs", "summary", "local"], exact: true }); });
    await waitFor(() => expect(screen.queryByTestId("observed-seats-none")).toBeNull());
    expect(screen.getByTestId("observed-seats-coverage").textContent).toMatch(/Rig list refresh failed/);
    expect(screen.getByTestId("observed-seats-count").textContent).toMatch(/coverage incomplete/);
  });

  it("a failed inventory refresh keeps dated seats as retained, not current, and claims no total", async () => {
    let down = false;
    stubFetch((url) => (url.pathname === "/api/rigs/summary" ? json(onlyObserverRig)
      : url.pathname === "/api/rigs/rig-observer/nodes" ? (down ? json({ error: "nodes unavailable" }, 503) : json(libraryTwinInventory)) : undefined));
    const { qc } = mount(libPath(IDS.reviewerUser, "local"));
    await waitFor(() => expect(screen.getByTestId("observed-seat").getAttribute("data-observation")).toBe("current"));
    down = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["rig", "rig-observer", "nodes", "local"], exact: true }); });
    await waitFor(() => expect(screen.getByTestId("observed-seat").getAttribute("data-observation")).toBe("retained"));
    expect(screen.getByTestId("observed-seats-count").textContent).toMatch(/coverage incomplete/);
  });
});

describe("repair 4: declared-by and member lookups need a successful catalog to claim absence", () => {
  it("a failed rig catalog is unavailable, not 'no declared-by rigs'", async () => {
    stubFetch((url) => (url.pathname === "/api/specs/library" && url.searchParams.get("kind") === "rig" ? json({ error: "rig catalog unavailable" }, 503) : undefined));
    mount(libPath(IDS.reviewerUser, "local"));
    expect((await screen.findByTestId("declared-by-catalog-failed")).textContent).toMatch(/unknown, not absent/);
    const check = screen.getByTestId("declared-by-check");
    expect(check.hasAttribute("disabled")).toBe(true);
    fireEvent.click(check);
    expect(screen.queryByTestId("declared-by-none")).toBeNull();
  });

  it("a successful empty rig catalog may say no rig declares it (control)", async () => {
    stubFetch((url) => (url.pathname === "/api/specs/library" && url.searchParams.get("kind") === "rig" ? json([]) : undefined));
    mount(libPath(IDS.reviewerUser, "local"));
    await waitFor(() => expect(screen.getByTestId("declared-by-check").hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByTestId("declared-by-check"));
    await screen.findByTestId("declared-by-none");
  });

  it("an unavailable agent catalog leaves member refs unresolved rather than 'no library entry'", async () => {
    stubFetch((url) => (url.pathname === "/api/specs/library" && url.searchParams.get("kind") === "agent" ? json({ error: "agent catalog unavailable" }, 503) : undefined));
    mount(libPath(IDS.pairRig, "local"));
    const ref = await screen.findByTestId("lib-member-ref-dev-rev");
    await waitFor(() => expect(ref.getAttribute("data-state")).toBe("unavailable"));
    expect(ref.textContent).not.toMatch(/no library entry/);
    expect(screen.getByTestId("lib-member-ref-dev-ext").getAttribute("data-state")).toBe("nonstandard");
    expect(screen.getByTestId("lib-member-ref-dev-ext").textContent).toContain("registry:acme/reviewer@3");
  });
});

describe("active lens read state on the workflow review", () => {
  const WF = libPath(IDS.releaseV1, "local");
  const lensGet = (respond: () => Response | Promise<Response>) => stubFetch((url, init) =>
    (url.pathname === "/api/specs/library/active-lens" && (init?.method ?? "GET") === "GET" ? respond() : undefined));

  it("pending without data is unknown, not 'no active lens'", async () => {
    lensGet(() => new Promise<Response>(() => {}));
    mount(WF);
    const read = await screen.findByTestId("workflow-lens-read");
    expect(read.getAttribute("data-state")).toBe("pending");
    expect(read.textContent).not.toMatch(/no active lens/);
  });

  it("a failed read without data is unavailable", async () => {
    lensGet(() => json({ error: "lens down" }, 503));
    mount(WF);
    await waitFor(() => expect(screen.getByTestId("workflow-lens-read").getAttribute("data-state")).toBe("unavailable"));
  });

  it("a served null is known absence; a failed refresh keeps it as dated, not current", async () => {
    let down = false;
    lensGet(() => (down ? json({ error: "lens down" }, 503) : json({ activeLens: null })));
    const { qc } = mount(WF);
    await waitFor(() => expect(screen.getByTestId("workflow-lens-read").getAttribute("data-state")).toBe("current"));
    expect(screen.getByTestId("workflow-lens-read").textContent).toBe("The connected instance has no active lens.");
    down = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["spec-library", "active-lens"] }); });
    await waitFor(() => expect(screen.getByTestId("workflow-lens-read").getAttribute("data-state")).toBe("stale"));
    expect(screen.getByTestId("workflow-lens-read").textContent).toMatch(/Read .* ago: no active lens\. The latest refresh failed/);
    expect(writes()).toEqual([]);
  });
});
