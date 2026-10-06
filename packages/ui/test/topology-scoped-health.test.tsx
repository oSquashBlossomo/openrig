// Scoped canonical Health in topology (gui-scoped-health-integration.md):
// actual scope pages, actual seat detail, the real canonical Health hook and
// transport over a served-contract fixture, and the production topology
// search adapters. Covers display-scope projection (host all / rig + seat
// descendants / pod = enclosing rig / exact seat by stable nodeId bytes),
// missing identity, freshness/partial/empty-not-healthy, warm and cold
// failures with Retry, remote/unknown/failed-cache admission with zero reads,
// and exact finding drill + Back to the same source-qualified entry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useRouterState } from "@tanstack/react-router";
import { parseTopologySearch, stringifyTopologySearch } from "../src/lib/topology-search.js";
import { HostScopePage, PodScopePage, RigScopePage, SeatScopePage } from "../src/components/topology/ScopePages.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import { healthRecordsForScope, usableSeatHealthId } from "../src/components/topology/ScopedHealth.js";
import type { HealthRecord } from "../src/hooks/useCanonicalHealth.js";
import { buildTopologyLink, parseTopologyLocation } from "../src/lib/topology-location.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { readHosts } from "../src/lib/hosts-read.js";

type Scope = HealthRecord["scope"];
const NODE_ID = "node/42?x#&";

function record(id: string, scope: Scope, over: Partial<HealthRecord> = {}): HealthRecord {
  return {
    schema: "openrig.health/v0alpha1", id, detector: "context-pressure", category: "context", scope,
    severity: "warning", confidence: "high", status: "active", startedAt: "2026-10-04T10:00:00Z", lastObservedAt: "2026-10-04T10:05:00Z",
    window: { source: "context-usage", startedAt: "2026-10-04T09:00:00Z", endedAt: "2026-10-04T10:05:00Z", limit: 100, retentionSeconds: 3600 },
    freshness: { state: "fresh", evaluatedAt: "2026-10-04T10:06:00Z", newestSourceAt: "2026-10-04T10:05:00Z", maxAgeSeconds: 600, ageSeconds: 60 },
    summary: `summary ${id}`, evidence: [], threshold: "t", explanation: "e", suggestedInspection: "s", indeterminateReason: null,
    ...over,
  } as HealthRecord;
}

const RECORDS: HealthRecord[] = [
  record("h-rig", { type: "rig", rigId: "rig_bravo" }, { severity: "critical" }),
  record("h-seat-exact", { type: "seat", rigId: "rig_bravo", seatId: NODE_ID }),
  record("h-seat-sibling", { type: "seat", rigId: "rig_bravo", seatId: "node_writer" }, { severity: "info" }),
  record("h-seat-logical", { type: "seat", rigId: "rig_bravo", seatId: "desk.editor" }),
  record("h-seat-spaced", { type: "seat", rigId: "rig_bravo", seatId: ` ${NODE_ID}` }),
  record("h-other-rig", { type: "rig", rigId: "rig_alpha" }),
  record("h-other-seat", { type: "seat", rigId: "rig_alpha", seatId: NODE_ID }),
  record("h-instance", { type: "instance", instanceId: "/home/openrig" }, { status: "indeterminate", indeterminateReason: "no samples" }),
];

describe("healthRecordsForScope (display predicates)", () => {
  const ids = (rows: HealthRecord[] | null) => rows?.map((r) => r.id) ?? null;

  it("host = every served record, ordered status → severity → newest → id", () => {
    expect(ids(healthRecordsForScope(RECORDS, { kind: "host" }))).toEqual([
      "h-rig", "h-other-rig", "h-other-seat", "h-seat-exact", "h-seat-logical", "h-seat-spaced", "h-seat-sibling", "h-instance",
    ]);
  });

  it("rig and pod (enclosing rig) = exact rig records plus its seats; never other rigs or the instance", () => {
    const expected = ["h-rig", "h-seat-exact", "h-seat-logical", "h-seat-spaced", "h-seat-sibling"];
    expect(ids(healthRecordsForScope(RECORDS, { kind: "rig", rigId: "rig_bravo" }))).toEqual(expected);
    expect(ids(healthRecordsForScope(RECORDS, { kind: "pod", rigId: "rig_bravo", podName: "desk" }))).toEqual(expected);
    expect(ids(healthRecordsForScope(RECORDS, { kind: "rig", rigId: "rig_brav" }))).toEqual([]);
  });

  it("seat = exact (rigId, stable nodeId) bytes; logical id, other rig and padded ids never match", () => {
    expect(ids(healthRecordsForScope(RECORDS, { kind: "seat", rigId: "rig_bravo", nodeId: NODE_ID }))).toEqual(["h-seat-exact"]);
    expect(ids(healthRecordsForScope(RECORDS, { kind: "seat", rigId: "rig_bravo", nodeId: ` ${NODE_ID}` }))).toEqual(["h-seat-spaced"]);
  });

  it.each([null, "", "   ", "\t"])("seat nodeId %j is unavailable identity, not zero findings", (nodeId) => {
    expect(healthRecordsForScope(RECORDS, { kind: "seat", rigId: "rig_bravo", nodeId })).toBeNull();
    expect(usableSeatHealthId(nodeId)).toBeNull();
  });

  it("a usable id is returned with its original bytes", () => {
    expect(usableSeatHealthId(" a ")).toBe(" a ");
  });
});

// ---------------------------------------------------------------------------
// Routed journeys

interface Fixture {
  hosts: Record<string, unknown> | null;
  hostsStatus: number;
  health: () => Response | Promise<Response>;
  nodeId: unknown;
}
let fx: Fixture;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const healthList = (records: HealthRecord[], over: Record<string, unknown> = {}) => ({
  schema: "openrig.health-list/v0alpha1", evaluatedAt: "2026-10-04T10:06:00Z", total: records.length, limit: 200, truncated: false, records, coverage: [], ...over,
});
function nodeDetail(rigId: string, logicalId: string) {
  return {
    rigId, logicalId, rigName: "bravo", podId: null, canonicalSessionName: `${logicalId}@${rigId}`, nodeKind: "agent", runtime: null,
    sessionStatus: null, startupStatus: null, restoreOutcome: "unknown", tmuxAttachCommand: null, resumeCommand: null, recoveryGuidance: null,
    latestError: null, model: null, agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: null,
    startupFiles: [], startupActions: [], recentEvents: [], infrastructureStartupCommand: null, peers: [], edges: { outgoing: [], incoming: [] },
    transcript: { enabled: false, path: null, tailCommand: null }, compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
    ...(fx.nodeId === undefined ? {} : { nodeId: fx.nodeId }),
  };
}
function serve(input: RequestInfo | URL, init?: RequestInit): Response | Promise<Response> {
  if (init?.method && init.method !== "GET") return json({ ok: true });
  const url = new URL(String(input), "http://fixture.invalid");
  if (url.pathname === "/api/hosts") return fx.hosts && fx.hostsStatus === 200 ? json(fx.hosts) : json({ error: "down" }, fx.hostsStatus);
  if (url.pathname === "/api/health") return fx.health();
  if (url.pathname === "/api/rigs/summary") return json([{ id: "rig_bravo", name: "bravo", nodeCount: 2 }]);
  const detail = url.pathname.match(/^\/api\/rigs\/([^/]+)\/nodes\/([^/]+)$/);
  if (detail) return json(nodeDetail(decodeURIComponent(detail[1]!), decodeURIComponent(detail[2]!)));
  if (url.pathname === "/api/queue/recent-transitions") return json([]);
  return json({ error: "not in fixture" }, 404);
}
const healthReads = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/health"));

let OriginalEventSource: typeof EventSource | undefined;
beforeEach(() => {
  fx = { hosts: { ownName: "fixture", selected: "local", hosts: [] }, hostsStatus: 200, health: () => json(healthList(RECORDS)), nodeId: NODE_ID };
  fetchMock.mockReset();
  fetchMock.mockImplementation(serve);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
});
afterEach(() => { cleanup(); if (OriginalEventSource) globalThis.EventSource = OriginalEventSource; });

function HealthDestination() {
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  return <div data-testid="health-destination" data-finding={String(search.finding)} />;
}

function renderApp(initial: string, client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/topology", component: HostScopePage }),
      createRoute({ getParentRoute: () => root, path: "/topology/rig/$rigId", component: RigScopePage }),
      createRoute({ getParentRoute: () => root, path: "/topology/pod/$rigId/$podName", component: PodScopePage }),
      createRoute({ getParentRoute: () => root, path: "/topology/seat/$rigId/$logicalId", component: SeatScopePage }),
      createRoute({ getParentRoute: () => root, path: "/settings/health", component: HealthDestination }),
    ]),
    history: createMemoryHistory({ initialEntries: [initial] }),
    parseSearch: parseTopologySearch,
    stringifySearch: stringifyTopologySearch,
  });
  render(<RouterProvider router={router} />);
  return { router, client };
}
const rowIds = (testId = "scoped-health") => within(screen.getByTestId(`${testId}-list`)).getAllByTestId(`${testId}-row`).map((r) => r.getAttribute("data-finding-id"));

describe("topology Health view", () => {
  it("host lists every served finding; rig lists its own and its seats'; the summary counts served matches", async () => {
    renderApp("/topology?sourceHost=local&view=health");
    await waitFor(() => expect(rowIds()).toHaveLength(8));
    expect(screen.getByTestId("scoped-health-matches").textContent).toBe("8 matching of 8 served");
    expect(screen.getByTestId("topology-host-tab-health").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("scoped-health-strip")).toBeNull();
    cleanup();
    fetchMock.mockClear();
    renderApp("/topology/rig/rig_bravo?sourceHost=local&view=health");
    await waitFor(() => expect(rowIds()).toEqual(["h-rig", "h-seat-exact", "h-seat-logical", "h-seat-spaced", "h-seat-sibling"]));
    expect(screen.getByTestId("scoped-health-count-critical").textContent).toBe("critical 1");
    expect(screen.getByTestId("scoped-health-count-cleared").textContent).toBe("Cleared · not in this read");
    expect(healthReads()).toEqual(["/api/health?limit=200"]);
  });

  it("pod shows its enclosing rig's findings, visibly labelled as such", async () => {
    renderApp("/topology/pod/rig_bravo/desk?sourceHost=local&view=health");
    await waitFor(() => expect(rowIds()).toEqual(["h-rig", "h-seat-exact", "h-seat-logical", "h-seat-spaced", "h-seat-sibling"]));
    expect(screen.getByTestId("scoped-health").textContent).toContain("Health for the enclosing rig rig_bravo");
    expect(screen.getByTestId("scoped-health-explanation").textContent).toContain("Pods have no Health scope");
  });

  it("the strip summarizes on other views and opens Health in place (replace)", async () => {
    const { router } = renderApp("/topology/rig/rig_bravo?sourceHost=local&view=table");
    const strip = await screen.findByTestId("scoped-health-strip");
    await waitFor(() => expect(within(strip).getByTestId("scoped-health-strip-matches").textContent).toBe("5 matching served"));
    const index = router.history.location.state.__TSR_index;
    fireEvent.click(within(strip).getByTestId("scoped-health-strip-open"));
    await waitFor(() => expect((router.state.location.search as Record<string, unknown>).view).toBe("health"));
    expect(router.history.location.state.__TSR_index).toBe(index);
    await screen.findByTestId("scoped-health-list");
  });

  it("an exact finding drill pushes the canonical detail and Back returns to the same source-qualified Health view", async () => {
    const { router } = renderApp("/topology/rig/rig_bravo?sourceHost=local&view=health");
    await waitFor(() => expect(rowIds()).toContain("h-seat-exact"));
    const row = screen.getAllByTestId("scoped-health-row").find((r) => r.getAttribute("data-finding-id") === "h-seat-exact")!;
    const index = router.history.location.state.__TSR_index;
    fireEvent.click(row);
    expect((await screen.findByTestId("health-destination")).getAttribute("data-finding")).toBe("h-seat-exact");
    expect(router.history.location.state.__TSR_index).toBe(index + 1);
    act(() => router.history.back());
    await screen.findByTestId("scoped-health-list");
    expect(router.state.location.pathname).toBe("/topology/rig/rig_bravo");
    expect(router.state.location.search).toEqual({ sourceHost: "local", view: "health" });
    expect(screen.getByTestId("topology-rig-tab-health").getAttribute("aria-selected")).toBe("true");
  });

  it("partial (truncated/coverage) and empty matches never read as healthy", async () => {
    fx.health = () => json(healthList([RECORDS[5]!], { total: 900, truncated: true, coverage: [{ source: "context-usage", status: "unavailable", partial: true, reason: "sampler offline", evaluatedAt: "2026-10-04T10:06:00Z" }] }));
    renderApp("/topology/rig/rig_bravo?sourceHost=local&view=health");
    expect((await screen.findByTestId("scoped-health-empty")).textContent).toContain("not a healthy verdict");
    const notes = screen.getByTestId("scoped-health-notes").textContent!;
    expect(notes).toContain("served 1 of 900 findings");
    expect(notes).toContain("context-usage unavailable — sampler offline");
    expect(screen.getByTestId("scoped-health-partial")).toBeTruthy();
  });

  it("cold failure shows an error with a real Retry; a warm refresh failure keeps dated retained rows with the failure visible", async () => {
    fx.health = () => json({ error: "down" }, 503);
    renderApp("/topology/rig/rig_bravo?sourceHost=local&view=health");
    const error = await screen.findByTestId("scoped-health-error");
    expect(screen.queryByTestId("scoped-health-list")).toBeNull();
    fx.health = () => json(healthList(RECORDS));
    fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(rowIds()).toHaveLength(5));
    cleanup();

    fx.health = () => json(healthList(RECORDS));
    const { client } = renderApp("/topology/rig/rig_bravo?sourceHost=local&view=health");
    await waitFor(() => expect(rowIds()).toHaveLength(5));
    fx.health = () => json({ error: "down" }, 503);
    await act(async () => { await client.refetchQueries({ queryKey: ["operator", "local-instance", "health", "list"] }); });
    const stale = await screen.findByTestId("scoped-health-read-stale");
    expect(stale.textContent).toContain("Health refresh failed");
    expect(stale.textContent).toContain("may no longer be current");
    expect(rowIds()).toHaveLength(5);
  });
});

describe("seat inline Health (Overview)", () => {
  it("shows only the exact (rigId, nodeId) seat finding, and keeps the two seat tabs", async () => {
    renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local");
    await waitFor(() => expect(rowIds("seat-health")).toEqual(["h-seat-exact"]));
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("data-testid"))).toEqual(["live-tab-overview", "live-tab-details"]);
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("%s stable id → identity unavailable, not zero findings", async (_label, nodeId) => {
    fx.nodeId = nodeId;
    renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local");
    expect(await screen.findByTestId("seat-health-identity-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("seat-health-empty")).toBeNull();
    expect(screen.queryByTestId("seat-health-list")).toBeNull();
  });

  it("a seat finding drill and Back keep the seat's Overview/Details state", async () => {
    const { router } = renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local");
    await waitFor(() => expect(rowIds("seat-health")).toEqual(["h-seat-exact"]));
    fireEvent.click(screen.getByTestId("seat-health-row"));
    expect((await screen.findByTestId("health-destination")).getAttribute("data-finding")).toBe("h-seat-exact");
    act(() => router.history.back());
    await waitFor(() => expect(rowIds("seat-health")).toEqual(["h-seat-exact"]));
    expect(router.state.location.search).toEqual({ sourceHost: "local" });
    expect(screen.getByTestId("live-tab-overview").getAttribute("aria-selected")).toBe("true");
  });
});

describe("Health source admission", () => {
  const seedLocalHealth = (client: QueryClient) => client.setQueryData(["operator", "local-instance", "health", "list", 200, null, null, null, null], healthList(RECORDS));

  it("remote source: named unavailable state, zero Health reads, and no cached local findings", async () => {
    fx.hosts = { ownName: "fixture", selected: "vps-a", hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a.invalid", selected: true, status: "reachable" }] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    seedLocalHealth(client);
    renderApp("/topology/rig/rig_bravo?sourceHost=vps-a&view=health", client);
    const remote = await screen.findByTestId("scoped-health-remote");
    expect(remote.textContent).toContain("remote host vps-a is unavailable");
    expect(screen.getByTestId("scoped-health-connected-link").textContent).toContain("this daemon, not vps-a");
    expect(screen.queryByTestId("scoped-health-list")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(healthReads()).toEqual([]);
  });

  it("unknown (cold hosts failure) and a failed refresh with cached local hosts read no Health", async () => {
    fx.hostsStatus = 503;
    renderApp("/topology?sourceHost=local&view=health");
    await waitFor(() => expect(screen.getByTestId("topology-source-gate").getAttribute("data-state")).toBe("unavailable"));
    await new Promise((r) => setTimeout(r, 30));
    expect(healthReads()).toEqual([]);
    cleanup();
    fetchMock.mockClear();

    // Standalone seat consumer with an asserted source but a failed current hosts read.
    fx.hostsStatus = 200;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    seedLocalHealth(client);
    const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> });
    const router = createRouter({
      routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/", component: () => <LiveNodeDetails rigId="rig_bravo" logicalId="desk.editor" sourceHost="local" /> })]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    client.setQueryData(["hosts"], fx.hosts);
    render(<RouterProvider router={router} />);
    await screen.findByTestId("seat-health-list");
    fx.hostsStatus = 503;
    // The hosts entry here has only cache observers, so fetch it directly.
    await act(async () => { await client.fetchQuery({ queryKey: ["hosts"], queryFn: ({ signal }) => readHosts({ signal }), staleTime: 0 }).catch(() => undefined); });
    expect(client.getQueryState(["hosts"])!.status).toBe("error");
    expect(client.getQueryData(["hosts"])).toEqual(fx.hosts);
    expect(await screen.findByTestId("seat-health-source-unknown")).toBeTruthy();
    expect(screen.queryByTestId("seat-health-list")).toBeNull();
    expect(healthReads().filter((u) => u.startsWith("/api/health"))).toEqual([]);
  });

  it("a legacy seat route without a source assertion reads no Health", async () => {
    const root = createRootRoute({ component: () => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Outlet /></QueryClientProvider> });
    const router = createRouter({
      routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/", component: () => <LiveNodeDetails rigId="rig_bravo" logicalId="desk.editor" /> })]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("seat-health-source-unknown")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(healthReads()).toEqual([]);
  });
});

describe("topology view token: health", () => {
  it("is a valid in-place view for host, rig and pod; seats keep Overview/Details only", () => {
    for (const scope of [{ kind: "host" }, { kind: "rig", rigId: "r" }, { kind: "pod", rigId: "r", podName: "p" }] as const) {
      expect(parseTopologyLocation(scope, { sourceHost: "local", view: "health" }).location.view).toBe("health");
    }
    const seat = parseTopologyLocation({ kind: "seat", rigId: "r", logicalId: "l" }, { sourceHost: "local", view: "health" });
    expect(seat.location.view).toBe("overview");
    expect(seat.issues.map((i) => i.field)).toEqual(["view"]);
    const link = buildTopologyLink({ scope: { kind: "rig", rigId: "r" }, sourceHost: "local", view: "health" });
    expect(link.ok && link.target.href).toBe("/topology/rig/r?sourceHost=local&view=health");
  });
});

// A failed CURRENT seat-detail read cannot certify the seat's identity: the
// retained detail's stable nodeId may belong to a seat since recreated, so
// scoped Health correlation is withheld (with the reason) until a read succeeds.
describe("seat Health requires a current detail read", () => {
  const detailKey = ["rig", "rig_bravo", "nodes", "desk.editor", "local"];
  const failDetail = () => fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
    /^\/api\/rigs\/[^/]+\/nodes\/[^/]+$/.test(new URL(String(input), "http://f.invalid").pathname) ? json({ error: "down" }, 503) : serve(input, init));

  it("success → detail 503 withholds correlation (detail evidence and Health cache kept) → recovery restores it", async () => {
    const { client } = renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local");
    await waitFor(() => expect(rowIds("seat-health")).toEqual(["h-seat-exact"]));
    const priorDetail = client.getQueryData(detailKey);
    const healthCache = client.getQueryData(["operator", "local-instance", "health", "list", 200, null, null, null, null]);
    failDetail();
    await act(async () => { await client.refetchQueries({ queryKey: detailKey, exact: true }); });
    expect(client.getQueryState(detailKey)!.status).toBe("error");
    expect(client.getQueryData(detailKey)).toBe(priorDetail);
    expect(await screen.findByTestId("seat-health-detail-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("seat-health-list")).toBeNull();
    // Ordinary detail evidence and the shared canonical cache are untouched.
    expect(screen.getByText("desk.editor@rig_bravo")).toBeTruthy();
    expect(client.getQueryData(["operator", "local-instance", "health", "list", 200, null, null, null, null])).toBe(healthCache);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("data-testid"))).toEqual(["live-tab-overview", "live-tab-details"]);

    fetchMock.mockImplementation(serve);
    await act(async () => { await client.refetchQueries({ queryKey: detailKey, exact: true }); });
    await waitFor(() => expect(rowIds("seat-health")).toEqual(["h-seat-exact"]));
    expect(screen.queryByTestId("seat-health-detail-unavailable")).toBeNull();
  });

  it("controls: a current local detail correlates; a remote source stays named-unavailable; an unknown source reads nothing", async () => {
    renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local");
    await waitFor(() => expect(rowIds("seat-health")).toEqual(["h-seat-exact"]));
    expect(screen.queryByTestId("seat-health-detail-unavailable")).toBeNull();
    cleanup();
    fetchMock.mockClear();

    fx.hosts = { ownName: "fixture", selected: "vps-a", hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a.invalid", selected: true, status: "reachable" }] };
    renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=vps-a");
    expect(await screen.findByTestId("seat-health-remote")).toBeTruthy();
    expect(screen.queryByTestId("seat-health-detail-unavailable")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(healthReads()).toEqual([]);
    cleanup();
    fetchMock.mockClear();

    const root = createRootRoute({ component: () => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Outlet /></QueryClientProvider> });
    const router = createRouter({
      routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/", component: () => <LiveNodeDetails rigId="rig_bravo" logicalId="desk.editor" /> })]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("seat-health-source-unknown")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(healthReads()).toEqual([]);
  });
});
