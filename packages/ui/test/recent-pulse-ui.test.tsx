// Recent / Pulse / maintained-stream journeys through the ACTUAL `/pulse`
// route component (lazy export contract) in a memory router, with the
// reviewed hooks and canonical transport against served-contract fixtures
// (twin/recent-pulse-fixtures.ts). No daemon, fleet or browser is used.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory, createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, RouterProvider, useParams, type AnyRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { parseTopologySearch, stringifyTopologySearch } from "../src/lib/topology-search.js";
import { useGlobalEvents } from "../src/hooks/useGlobalEvents.js";
import type { MaintainedStreamItem, PulseQueueItem, RecentTransition } from "../src/lib/recent-pulse-contracts.js";
import { RecentPulsePage, RecentPulseRoute } from "../src/components/recent-pulse/RecentPulsePage.js";
import { RecentScopePanel, useTopologyRecentInstance } from "../src/components/recent-pulse/RecentView.js";
import { FLASH_MS } from "../src/components/recent-pulse/RecentPulseParts.js";
import {
  forgetRetainedRecentSelections, parseRecentPulseLocation, rawQueryOf, recentPulseHref,
} from "../src/components/recent-pulse/recent-pulse-location.js";
import {
  recentPulseQueueListFor, recentPulseQueueRows, recentPulseStreamItems, recentPulseTransitions, recentPulseTwinBody,
  recentTransitionsFor, streamListFor,
} from "../twin/recent-pulse-fixtures.js";

// ------------------------------------------------------------------ server

const node = (logicalId: string, canonicalSessionName: string, terminalActive: boolean | null, lastActivityAt: string | null = "2025-09-01T01:40:00.000Z") =>
  ({ logicalId, canonicalSessionName, podNamespace: logicalId.split(".")[0], nodeKind: "agent", terminalActive, lastActivityAt });

interface Server {
  transitions: RecentTransition[];
  queue: PulseQueueItem[];
  stream: MaintainedStreamItem[];
  rigs: Array<{ id: string; name: string }>;
  nodes: Record<string, unknown[]>;
  fail: Set<string>;
  calls: string[];
}

let server: Server;
let emit: ((name: string, data?: string) => void) | null = null;

function freshServer(): Server {
  return {
    transitions: [...recentPulseTransitions],
    queue: [
      ...recentPulseQueueRows,
      // Unknown (null) pane activity: neither NOW nor PARKED, never idle.
      { ...recentPulseQueueRows[3]!, qitemId: "qitem-rp-unknown-1", destinationSession: "auditor@acme-build", summary: "Audit the release manifest" },
    ],
    stream: [...recentPulseStreamItems],
    rigs: [{ id: "rig_alpha", name: "acme-build" }, { id: "rig_bravo", name: "acme-comms" }],
    nodes: {
      rig_alpha: [
        node("lead.coordinator", "coordinator@acme-build", true),
        node("builders.builder2", "builder2@acme-build", true),
        node("builders.reviewer1", "reviewer1@acme-build", false, "2025-09-01T01:12:00.000Z"),
        node("ops.auditor", "auditor@acme-build", null, null),
      ],
      // Same logical ID in another rig: a duplicate display name, distinct seat.
      rig_bravo: [node("lead.coordinator", "coordinator@acme-comms", true)],
    },
    fail: new Set(),
    calls: [],
  };
}

function sourceOf(url: URL): string {
  if (url.pathname === "/api/queue/list") {
    if (url.searchParams.get("attention") === "1") return "attention";
    const state = url.searchParams.get("state");
    return state === "in-progress" ? "inProgress" : state === "done,handed-off" ? "finished" : state ?? "list";
  }
  if (url.pathname === "/api/rigs/summary") return "summary";
  const nodes = /^\/api\/rigs\/([^/]+)\/nodes$/.exec(url.pathname);
  if (nodes) return `nodes:${decodeURIComponent(nodes[1]!)}`;
  if (url.pathname === "/api/queue/recent-transitions") return "recent";
  if (url.pathname === "/api/stream/list") return "stream";
  const item = /^\/api\/queue\/([^/]+)$/.exec(url.pathname);
  return item ? `qitem:${decodeURIComponent(item[1]!)}` : url.pathname;
}

function stubNetwork() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://private");
    server.calls.push(`${url.pathname}${url.search}`);
    const source = sourceOf(url);
    if (server.fail.has(source)) return Response.json({ error: "unavailable", message: `${source} failed (fixture)` }, { status: 503 });
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "demo-studio", selected: "local", hosts: [] });
    if (url.pathname === "/api/rigs/summary") return Response.json(server.rigs);
    if (source.startsWith("nodes:")) return Response.json(server.nodes[source.slice(6)] ?? []);
    if (url.pathname === "/api/queue/list") { const r = recentPulseQueueListFor(url.searchParams, server.queue); return Response.json(r.body, { status: r.status }); }
    if (url.pathname === "/api/queue/recent-transitions" || url.pathname === "/api/stream/list" || source.startsWith("qitem:")) {
      const twin = url.pathname === "/api/queue/recent-transitions"
        ? recentTransitionsFor(url.searchParams, server.transitions)
        : url.pathname === "/api/stream/list"
          ? streamListFor(url.searchParams, server.stream)
          : recentPulseTwinBody(url.pathname, url.searchParams, server.queue)!;
      return Response.json(twin.body, { status: twin.status });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
  vi.stubGlobal("EventSource", class {
    listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    constructor() { emit = (name, data) => { for (const l of this.listeners.get(name) ?? []) l({ data }); }; }
    addEventListener(name: string, l: (event: { data?: string }) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], l]); }
    close() {}
  });
}

// ----------------------------------------------------------------- harness

let client: QueryClient;

function GlobalEvents() { useGlobalEvents(); return null; }

/** The `/pulse` component exactly as the published route snippet loads it. */
const lazyPulse = lazyRouteComponent(() => import("../src/components/recent-pulse/RecentPulsePage.js"), "RecentPulseRoute");

function mount(path: string, { events = false }: { events?: boolean } = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}>{events ? <GlobalEvents /> : null}<Outlet /></QueryClientProvider> });
  const pulse = createRoute({ getParentRoute: () => root, path: "/pulse", component: lazyPulse });
  const seat = createRoute({ getParentRoute: () => root, path: "/topology/seat/$rigId/$logicalId", component: function Seat() {
    const p = useParams({ strict: false }) as { rigId: string; logicalId: string };
    return <div data-testid="stub-seat">{p.rigId}|{p.logicalId}</div>;
  } });
  const rig = createRoute({ getParentRoute: () => root, path: "/topology/rig/$rigId", component: function Rig() {
    const p = useParams({ strict: false }) as { rigId: string };
    return <div data-testid="stub-rig">{p.rigId}</div>;
  } });
  const router = createRouter({
    routeTree: root.addChildren([pulse, seat, rig]),
    history: createMemoryHistory({ initialEntries: [path] }),
    parseSearch: parseTopologySearch, stringifySearch: stringifyTopologySearch,
  });
  render(<RouterProvider router={router} />);
  return router as AnyRouter;
}

const href = (router: AnyRouter) => (router.state.location as { publicHref?: string }).publicHref ?? router.state.location.href;
const rowIds = (testId = "recent-list-row") => screen.queryAllByTestId(testId).map((r) => r.getAttribute("data-transition-id"));
const refresh = () => act(async () => { await client.invalidateQueries({ queryKey: ["recent-pulse"] }); });

afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); forgetRetainedRecentSelections(); emit = null; });

// ------------------------------------------------------------------ Recent

describe("Recent", () => {
  it("shows the full served window, the collapsed last five and an exact-rig window with truthful bounds", async () => {
    server = freshServer(); stubNetwork();
    const router = mount("/pulse?view=recent");
    await waitFor(() => expect(rowIds()).toHaveLength(8));
    expect(rowIds()).toEqual(["3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(screen.getByTestId("recent-window").textContent).toMatch(/All 8 served · latest window, limit 20 · fewer than the limit served · no total/);
    expect(screen.getByTestId("recent-scope-label").textContent).toBe("Instance · connected local instance");
    expect(server.calls).toContain("/api/queue/recent-transitions?scope=instance&limit=20");

    fireEvent.click(screen.getByTestId("recent-window-mode-collapsed"));
    await waitFor(() => expect(rowIds()).toEqual(["6", "7", "8", "9", "10"]));
    expect(screen.getByTestId("recent-window").textContent).toMatch(/Last 5 of 8 served/);
    expect(href(router)).toBe("/pulse?view=recent&window=collapsed");

    fireEvent.change(screen.getByTestId("recent-rig-input"), { target: { value: "acme-comms" } });
    fireEvent.click(screen.getByTestId("recent-rig-apply"));
    await waitFor(() => expect(rowIds()).toEqual(["7", "8"]));
    expect(server.calls).toContain("/api/queue/recent-transitions?scope=rig&rig=acme-comms&limit=20");
    expect(screen.getByTestId("recent-scope-label").textContent).toBe("Rig acme-comms · exact name");
    // Rig scope does not repeat the rig column.
    expect(screen.getAllByTestId("recent-list-row")[0]!.textContent).not.toMatch(/rig acme-comms/);
  });

  it("keeps the frozen original after eviction, separates current queue evidence, and survives seat drill + Back", async () => {
    server = freshServer(); stubNetwork();
    const router = mount("/pulse?view=recent");
    await waitFor(() => expect(rowIds()).toHaveLength(8));
    fireEvent.click(screen.getAllByTestId("recent-list-row")[0]!.querySelector("button")!);
    await screen.findByTestId("recent-detail");
    expect(href(router)).toBe("/pulse?view=recent&transition=3");
    expect(screen.getByTestId("recent-detail-change").textContent).toBe("claimed");

    // Twenty newer transitions evict #3; the same qitem now has a later "completed" row.
    server.transitions = Array.from({ length: 20 }, (_, i): RecentTransition => ({
      transitionId: 11 + i, qitemId: "qitem-rp-done-1", ts: `2025-09-01T02:${String(i).padStart(2, "0")}:00.000Z`, actorSession: "coordinator@acme-build",
      change: "completed", summary: `later ${i}`, rig: "acme-build", targetKind: "qitem", target: "qitem-rp-done-1",
    }));
    await refresh();
    await waitFor(() => expect(rowIds()).toContain("30"));
    expect(rowIds()).not.toContain("3");
    const detail = screen.getByTestId("recent-detail");
    expect(within(detail).getByText("Recent event #3")).toBeTruthy();
    expect(screen.getByTestId("recent-detail-change").textContent).toBe("claimed");
    expect(screen.getByTestId("recent-detail-when").getAttribute("dateTime")).toBe("2025-09-01T01:14:00.000Z");
    expect(screen.getByTestId("recent-detail-outside-window")).toBeTruthy();

    // Current queue item is separate evidence and never rewrites the record.
    fireEvent.click(screen.getByTestId("recent-detail-open-qitem"));
    await screen.findByTestId("recent-qitem-subject");
    expect(href(router)).toBe("/pulse?view=recent&transition=3&qitem=qitem-rp-done-1");
    expect(screen.getByTestId("recent-qitem-state").textContent).toBe("done");
    expect(screen.queryByTestId("recent-detail")).toBeNull();
    act(() => router.history.back());
    await screen.findByTestId("recent-detail");
    expect(screen.getByTestId("recent-detail-change").textContent).toBe("claimed");

    // Exact actor seat drill (served logical ID), then Back remounts the page.
    const actor = await waitFor(() => { const a = screen.getByTestId("recent-detail-actor"); expect(a.getAttribute("data-seat-link")).toBe("true"); return a; });
    expect(actor.getAttribute("href")).toBe("/topology/seat/rig_alpha/builders.builder2?sourceHost=local");
    fireEvent.click(actor);
    expect((await screen.findByTestId("stub-seat")).textContent).toBe("rig_alpha|builders.builder2");
    act(() => router.history.back());
    await screen.findByTestId("recent-detail");
    expect(screen.getByTestId("recent-detail-change").textContent).toBe("claimed");
    expect(screen.getByTestId("recent-detail-outside-window")).toBeTruthy();
    // Rig drill resolves the Recent rig NAME to its served topology ID.
    await waitFor(() => expect(screen.getByTestId("recent-detail-rig").getAttribute("href")).toBe("/topology/rig/rig_alpha?sourceHost=local"));
  });

  it("after a reload an evicted transition is honestly unavailable, never replaced by another row", async () => {
    server = freshServer(); stubNetwork();
    server.transitions = server.transitions.filter((t) => t.transitionId !== 3);
    mount("/pulse?view=recent&transition=3");
    expect((await screen.findByTestId("recent-detail-unavailable")).textContent).toMatch(/Waiting for the served window/);
    await waitFor(() => expect(screen.getByTestId("recent-detail-unavailable").textContent).toMatch(/not retained in this browser session.*not replaced by another row/s));
    expect(rowIds()).not.toContain("3");
    expect(screen.queryByTestId("recent-detail")).toBeNull();
  });

  it("unknown actor and missing queue item stay visible pointers; non-qitem targets are not inferred", async () => {
    server = freshServer(); stubNetwork();
    mount("/pulse?view=recent&transition=7");
    await screen.findByTestId("recent-detail");
    await waitFor(() => expect(screen.getByTestId("recent-detail-actor").textContent).toMatch(/writer@acme-comms.*not a seat in the served inventory/));
    expect(screen.getByTestId("recent-detail-actor").getAttribute("data-seat-link")).toBe("false");
    fireEvent.click(screen.getByTestId("recent-detail-open-qitem"));
    expect((await screen.findByTestId("recent-qitem-error")).textContent).toMatch(/Queue item no longer served unavailable.*qitem_not_found/s);
    cleanup(); forgetRetainedRecentSelections();
    mount("/pulse?view=recent&transition=6");
    expect((await screen.findByTestId("recent-detail-target")).textContent).toBe("mission: release-train");
    expect(screen.getByTestId("recent-detail-target-pointer").textContent).toMatch(/not inferred/);
  });

  it("discloses duplicate served identities and selects the first exactly", async () => {
    server = freshServer(); stubNetwork();
    server.transitions = [...server.transitions, { ...server.transitions[0]!, ts: "2025-09-01T01:50:00.000Z", summary: "duplicate id" }];
    mount("/pulse?view=recent");
    await screen.findByTestId("recent-list-duplicates");
    expect(screen.getByTestId("recent-list-duplicates").textContent).toMatch(/#3 served more than once/);
    expect(rowIds().filter((id) => id === "3")).toHaveLength(2);
  });

  it("flashes a newly served row once and the flash ends", async () => {
    server = freshServer(); stubNetwork();
    mount("/pulse?view=recent");
    await waitFor(() => expect(rowIds()).toHaveLength(8));
    expect(screen.queryByTestId("arrival-flash")).toBeNull();
    server.transitions = [...server.transitions, { ...server.transitions[7]!, transitionId: 11, ts: "2025-09-01T01:50:00.000Z" }];
    await refresh();
    const flash = await screen.findByTestId("arrival-flash");
    expect(flash.closest("[data-transition-id]")!.getAttribute("data-transition-id")).toBe("11");
    await waitFor(() => expect(screen.queryByTestId("arrival-flash")).toBeNull(), { timeout: FLASH_MS + 1500 });
  });
});

// ------------------------------------------------------------------- Pulse

const laneCount = (id: string) => screen.getByTestId(`pulse-lane-${id}-count`).textContent;

describe("Pulse", () => {
  it("builds six lanes and footer counts from the same referent sets", async () => {
    server = freshServer(); stubNetwork();
    mount("/pulse");
    await screen.findByTestId("pulse-view");
    await waitFor(() => expect(screen.getByTestId("pulse-view").getAttribute("data-status")).toBe("ready"));
    expect(laneCount("waitingYou")).toBe("2");
    // Known human blocker excluded; qitem pointer resolved by exact lookup; gate pointer not guessed.
    expect(laneCount("blocked")).toBe("2");
    const blocked = screen.getAllByTestId("pulse-blocked-row").map((r) => r.getAttribute("data-qitem-id"));
    expect(blocked).toEqual(["qitem-rp-blocked-1", "qitem-rp-blocked-2"]);
    const owners = screen.getAllByTestId("pulse-blocked-owner").map((o) => o.textContent);
    expect(owners).toEqual(["owner coordinator@acme-build", "not a queue item; no owner inferred"]);
    // false parks, true is NOW, null is neither (and keeps both totals unknown).
    expect(screen.getAllByTestId("pulse-parked-row").map((r) => r.getAttribute("data-qitem-id"))).toEqual(["qitem-rp-parked-1"]);
    expect(laneCount("parked")).toBe("1 served · total unknown");
    const now = screen.getAllByTestId("pulse-now-row").map((r) => `${r.getAttribute("data-rig-id")}/${r.getAttribute("data-session")}`);
    expect(now).toEqual(["rig_alpha/coordinator@acme-build", "rig_alpha/builder2@acme-build", "rig_bravo/coordinator@acme-comms"]);
    expect(screen.queryByText(/auditor@acme-build/)).toBeNull();
    expect(laneCount("now")).toBe("3 served · total unknown");
    expect(screen.getAllByTestId("pulse-now-work").map((w) => w.textContent)).toEqual([expect.stringContaining("qitem-rp-active-1")]);
    // Claimed pending is not UP NEXT; finished is newest-updated first and has no total.
    expect(screen.getAllByTestId("pulse-upNext-row").map((r) => r.getAttribute("data-qitem-id"))).not.toContain("qitem-rp-claimed-pending");
    expect(screen.getAllByTestId("pulse-finished-row").map((r) => r.getAttribute("data-qitem-id"))).toEqual(["qitem-rp-handoff-1", "qitem-rp-done-1"]);
    expect(laneCount("finished")).toBe("2 served · total unknown");
    expect(screen.getByTestId("pulse-footer-now").textContent).toBe(`Active ${laneCount("now")}`);
    expect(screen.getByTestId("pulse-footer-parked").textContent).toBe(`Parked ${laneCount("parked")}`);
    expect(screen.getByTestId("pulse-footer-waiting").textContent).toBe(`Needs you ${laneCount("waitingYou")}`);
    // Duplicate logical IDs link to their exact seats.
    const seats = screen.getAllByTestId("pulse-now-seat").map((s) => s.getAttribute("href"));
    expect(seats).toContain("/topology/seat/rig_alpha/lead.coordinator?sourceHost=local");
    expect(seats).toContain("/topology/seat/rig_bravo/lead.coordinator?sourceHost=local");
  });

  it("opens current queue evidence from a lane row and Back returns to Pulse", async () => {
    server = freshServer(); stubNetwork();
    const router = mount("/pulse");
    const row = await screen.findAllByTestId("pulse-parked-row");
    fireEvent.click(row[0]!.querySelector("button")!);
    await screen.findByTestId("recent-qitem-subject");
    expect(href(router)).toBe("/pulse?qitem=qitem-rp-parked-1");
    await waitFor(() => expect(screen.getByTestId("recent-qitem-owner").getAttribute("href")).toBe("/topology/seat/rig_alpha/builders.reviewer1?sourceHost=local"));
    act(() => router.history.back());
    await waitFor(() => expect(screen.queryByTestId("recent-qitem-evidence")).toBeNull());
    expect(href(router)).toBe("/pulse");
  });

  it("an independently failed source is unavailable, never zero, and siblings stay", async () => {
    server = freshServer(); server.fail.add("attention"); stubNetwork();
    mount("/pulse");
    await screen.findByTestId("pulse-lane-waitingYou-unavailable");
    expect(screen.getByTestId("pulse-view").getAttribute("data-status")).toBe("partial");
    expect(laneCount("waitingYou")).toBe("unavailable");
    expect(screen.getByTestId("pulse-lane-waitingYou-unavailable").textContent).toMatch(/Unavailable — not zero.*attention window: .*503/s);
    expect(screen.getByTestId("pulse-footer-waiting").textContent).toBe("Needs you unavailable");
    expect(laneCount("upNext")).toBe("3");
    expect(screen.getByTestId("pulse-source-attention").getAttribute("data-state")).toBe("unavailable");
  });

  it("independent NOW evidence survives every queue source failing", async () => {
    server = freshServer(); for (const s of ["attention", "blocked", "inProgress", "pending", "finished"]) server.fail.add(s); stubNetwork();
    mount("/pulse");
    await screen.findAllByTestId("pulse-now-row");
    expect(screen.getAllByTestId("pulse-now-row")).toHaveLength(3);
    expect(screen.getAllByTestId("pulse-now-no-work").map((n) => n.textContent)).toEqual(Array(3).fill("Work unknown: the in-progress source is unavailable."));
    for (const lane of ["waitingYou", "blocked", "parked", "finished", "upNext"]) expect(laneCount(lane)).toBe("unavailable");
  });

  it("inventory and node failures are disclosed; queue lanes remain", async () => {
    server = freshServer(); server.fail.add("summary"); stubNetwork();
    mount("/pulse");
    await screen.findByTestId("pulse-lane-now-unavailable");
    expect(laneCount("now")).toBe("unavailable");
    expect(laneCount("parked")).toBe("unavailable");
    expect(laneCount("waitingYou")).toBe("2");
    cleanup();
    server = freshServer(); server.fail.add("nodes:rig_bravo"); stubNetwork();
    mount("/pulse");
    await screen.findByTestId("pulse-source-node-failure");
    expect(screen.getAllByTestId("pulse-now-row")).toHaveLength(2);
    expect(screen.getByTestId("pulse-inventory-incomplete")).toBeTruthy();
    expect(screen.getByTestId("pulse-lane-now-window").textContent).toMatch(/Seat inventory is incomplete/);
  });

  it("a failed blocker lookup keeps the raw pointer and an unknown total", async () => {
    server = freshServer(); server.fail.add("qitem:qitem-rp-active-1"); stubNetwork();
    mount("/pulse");
    await screen.findAllByTestId("pulse-blocked-owner");
    expect(screen.getAllByTestId("pulse-blocked-pointer")[0]!.textContent).toBe("qitem-rp-active-1");
    expect(screen.getAllByTestId("pulse-blocked-owner")[0]!.textContent).toMatch(/owner lookup failed/);
    expect(laneCount("blocked")).toBe("2 served · total unknown");
    expect(screen.getByTestId("pulse-source-blocker-failure")).toBeTruthy();
  });

  it("a null claim time stays unknown (update age labelled as such) while a known claim keeps its claim age", async () => {
    server = freshServer();
    server.queue = [
      { ...recentPulseQueueRows[3]! },
      { ...recentPulseQueueRows[3]!, qitemId: "qitem-rp-parked-unclaimed", claimedAt: null },
    ];
    stubNetwork();
    mount("/pulse");
    await screen.findAllByTestId("pulse-parked-row");
    const row = (id: string) => screen.getAllByTestId("pulse-parked-row").find((r) => r.getAttribute("data-qitem-id") === id)!.textContent!;
    expect(row("qitem-rp-parked-1")).toMatch(/claimed \d+[smhd] ago/);
    const unclaimed = row("qitem-rp-parked-unclaimed");
    expect(unclaimed).not.toMatch(/claimed \d+[smhd] ago/);
    expect(unclaimed).toMatch(/claim time not recorded · updated \d+[smhd] ago/);
    // Seat idle duration remains its own fact.
    expect(unclaimed).toMatch(/idle \d+[smhd]/);
  });

  it("a full in-progress window explains the queue bound; Now keeps its own seat reason", async () => {
    server = freshServer();
    server.rigs = [{ id: "rig_alpha", name: "acme-build" }];
    server.nodes = { rig_alpha: [node("builders.reviewer1", "reviewer1@acme-build", false), node("ops.auditor", "auditor@acme-build", null, null)] };
    server.queue = Array.from({ length: 100 }, (_, i) => ({ ...recentPulseQueueRows[3]!, qitemId: `qitem-rp-bounded-${i}` }));
    stubNetwork();
    mount("/pulse");
    await screen.findAllByTestId("pulse-parked-row");
    expect(laneCount("parked")).toBe("100 served · total unknown");
    const parked = screen.getByTestId("pulse-lane-parked-window").textContent!;
    expect(parked).toMatch(/In-progress source window is full \(100 of limit 100 served\)/);
    expect(parked).not.toMatch(/unknown activity/);
    // Now's total is unknown because of the seat's null activity, not the queue cap.
    const now = screen.getByTestId("pulse-lane-now-window").textContent!;
    expect(now).toMatch(/1 served seat reports unknown activity/);
    expect(now).not.toMatch(/In-progress source window/);
  });

  it("Parked reasons name unknown activity and missing owners only where true", async () => {
    server = freshServer();
    server.queue.push({ ...recentPulseQueueRows[3]!, qitemId: "qitem-rp-orphan", destinationSession: "ghost@acme-build" });
    stubNetwork();
    mount("/pulse");
    await screen.findAllByTestId("pulse-parked-row");
    const parked = screen.getByTestId("pulse-lane-parked-window").textContent!;
    expect(parked).toMatch(/1 in-progress owner reports unknown activity/);
    expect(parked).toMatch(/1 in-progress owner is not in the served seat inventory/);
    expect(parked).not.toMatch(/source window is full/);
    cleanup();
    server = freshServer(); server.fail.add("nodes:rig_bravo"); stubNetwork();
    mount("/pulse");
    await screen.findByTestId("pulse-source-node-failure");
    expect(screen.getByTestId("pulse-lane-parked-window").textContent).toMatch(/Seat inventory is incomplete/);
  });

  it("more than five served rows show the visible cap and hidden known rows", async () => {
    server = freshServer();
    server.queue.push(...Array.from({ length: 7 }, (_, i) => ({ ...recentPulseQueueRows[6]!, qitemId: `qitem-rp-extra-${i}` })));
    stubNetwork();
    mount("/pulse");
    await screen.findAllByTestId("pulse-upNext-row");
    expect(screen.getAllByTestId("pulse-upNext-row")).toHaveLength(5);
    expect(laneCount("upNext")).toBe("10");
    expect(screen.getByTestId("pulse-lane-upNext-window").textContent).toMatch(/Showing 5 of 10 served · 5 more served, not shown/);
  });
});

// ------------------------------------------------------------------ Stream

const streamIds = () => screen.queryAllByTestId("stream-row").map((r) => r.getAttribute("data-stream-item-id"));

describe("Maintained stream", () => {
  it("latest window, chronological sort-key paging with Back, exact filters and archive", async () => {
    server = freshServer(); stubNetwork();
    const router = mount("/pulse?view=stream");
    await waitFor(() => expect(streamIds()).toEqual(["stream-rp-04", "stream-rp-05", "stream-rp-07", "stream-rp-08", "stream-rp-09"]));
    expect(server.calls).toContain("/api/stream/list?direction=latest&limit=5");
    expect(screen.getByTestId("stream-window").textContent).toMatch(/older pages are not available for the newest window/);
    expect(screen.queryByTestId("stream-next")).toBeNull();

    fireEvent.click(screen.getByTestId("stream-direction-chronological"));
    await waitFor(() => expect(streamIds()).toEqual(["stream-rp-01", "stream-rp-02", "stream-rp-03", "stream-rp-04", "stream-rp-05"]));
    fireEvent.click(screen.getByTestId("stream-next"));
    await waitFor(() => expect(streamIds()).toEqual(["stream-rp-07", "stream-rp-08", "stream-rp-09"]));
    const cursor = recentPulseStreamItems[4]!.streamSortKey;
    expect(server.calls).toContain(`/api/stream/list?${new URLSearchParams({ direction: "chronological", limit: "5", afterSortKey: cursor })}`);
    expect(parseRecentPulseLocation(rawQueryOf(href(router))).stream.after).toBe(cursor);
    expect((screen.getByTestId("stream-next") as HTMLButtonElement).disabled).toBe(true);
    act(() => router.history.back());
    await waitFor(() => expect(streamIds()).toEqual(["stream-rp-01", "stream-rp-02", "stream-rp-03", "stream-rp-04", "stream-rp-05"]));

    fireEvent.change(screen.getByTestId("stream-filter-source"), { target: { value: "builder2@acme-build" } });
    fireEvent.click(screen.getByTestId("stream-filter-apply"));
    await waitFor(() => expect(streamIds()).toEqual(["stream-rp-02", "stream-rp-04", "stream-rp-08"]));
    fireEvent.change(screen.getByTestId("stream-filter-source"), { target: { value: "writer@acme-comms" } });
    fireEvent.click(screen.getByTestId("stream-filter-archived"));
    fireEvent.click(screen.getByTestId("stream-filter-apply"));
    await waitFor(() => expect(streamIds()).toEqual(["stream-rp-06", "stream-rp-07"]));
    fireEvent.click(screen.getAllByTestId("stream-row")[0]!.querySelector("button")!);
    expect((await screen.findByTestId("stream-item-detail")).textContent).toMatch(/stream-rp-06.*Old draft superseded/s);
  });

  it("a hand-edited latest+cursor link is refused before transport, not reinterpreted", async () => {
    server = freshServer(); stubNetwork();
    mount("/pulse?view=stream&after=sk-1");
    expect((await screen.findByTestId("stream-error")).textContent).toMatch(/cannot use a chronological cursor/);
    expect(server.calls.filter((c) => c.startsWith("/api/stream"))).toEqual([]);
  });
});

// --------------------------------------------------------- scope & panels

describe("Scope", () => {
  it("a remote instance is unsupported with no queue/stream read and no local fallback", async () => {
    server = freshServer(); stubNetwork();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const remote = { kind: "remote-instance", hostId: "studio-b" } as const;
    const Wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const root = createRootRoute({ component: () => <Wrap><RecentScopePanel instance={remote} filter={{ kind: "instance" }} /><RecentPulsePage location={parseRecentPulseLocation("view=recent")} go={() => {}} scope={remote} /></Wrap> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) })} />);
    expect((await screen.findByTestId("recent-scope-panel-list-unsupported")).textContent).toMatch(/remote host studio-b/);
    expect(screen.getByTestId("recent-list-unsupported")).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(server.calls.filter((c) => c.startsWith("/api/queue") || c.startsWith("/api/stream") || c.startsWith("/api/rigs"))).toEqual([]);
  });

  it("the ScopePages panel shows collapsed five, expands, links exact rows, and waits for unresolved scope", async () => {
    server = freshServer(); stubNetwork();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> });
    const host = createRoute({ getParentRoute: () => root, path: "/topology", component: () => <RecentScopePanel instance={{ kind: "local-instance" }} filter={{ kind: "instance" }} /> });
    const rig = createRoute({ getParentRoute: () => root, path: "/topology/rig/$rigId", component: () => <RecentScopePanel instance={{ kind: "local-instance" }} filter="pending" testId="rig-panel" /> });
    const pulse = createRoute({ getParentRoute: () => root, path: "/pulse", component: RecentPulseRoute });
    const router = createRouter({ routeTree: root.addChildren([host, rig, pulse]), history: createMemoryHistory({ initialEntries: ["/topology"] }) });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(rowIds("recent-scope-panel-list-row")).toEqual(["6", "7", "8", "9", "10"]));
    expect(screen.getByTestId("recent-scope-panel-window").textContent).toMatch(/Last 5 of 8 served/);
    fireEvent.click(screen.getByTestId("recent-scope-panel-expand"));
    await waitFor(() => expect(rowIds("recent-scope-panel-list-row")).toHaveLength(8));
    const link = screen.getAllByTestId("recent-scope-panel-list-row")[7]!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/pulse?view=recent&transition=10");
    fireEvent.click(link);
    await screen.findByTestId("recent-detail");
    act(() => router.history.back());
    await screen.findByTestId("recent-scope-panel");
    cleanup();
    server.calls = [];
    render(<RouterProvider router={createRouter({ routeTree: root.addChildren([host, rig, pulse]), history: createMemoryHistory({ initialEntries: ["/topology/rig/rig_alpha"] }) })} />);
    expect(await screen.findByTestId("rig-panel-rig-pending")).toBeTruthy();
    expect(server.calls.filter((c) => c.startsWith("/api/queue"))).toEqual([]);
  });

  it("topology-hosted panels take explicit authority from the read host selection", async () => {
    server = freshServer(); stubNetwork();
    let selected = "studio-b";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), "http://private");
      server.calls.push(url.pathname);
      if (url.pathname === "/api/hosts") { await gate; return Response.json({ ownName: "demo-studio", selected, hosts: [] }); }
      return Response.json([]);
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Host() {
      const instance = useTopologyRecentInstance();
      return <><span data-testid="authority">{instance === null ? "unknown" : instance.kind === "local-instance" ? "local" : instance.hostId}</span><RecentScopePanel instance={instance} filter="unavailable" /></>;
    }
    const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Host /></QueryClientProvider> });
    render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) })} />);
    expect((await screen.findByTestId("authority")).textContent).toBe("unknown");
    expect(screen.getByTestId("recent-scope-panel-resolving")).toBeTruthy();
    release();
    await waitFor(() => expect(screen.getByTestId("authority").textContent).toBe("studio-b"));
    expect(screen.getByTestId("recent-scope-panel-rig-unavailable")).toBeTruthy();
    selected = "local";
    await act(async () => { await client.invalidateQueries({ queryKey: ["hosts"] }); });
    await waitFor(() => expect(screen.getByTestId("authority").textContent).toBe("local"));
    expect(server.calls.filter((c) => c.startsWith("/api/queue"))).toEqual([]);
  });

  it("location contract keeps exact raw identities and reports malformed values", () => {
    const loc = parseRecentPulseLocation("view=recent&rig=2024&transition=0x3&limit=500&dir=sideways");
    expect(loc.rig).toBe("2024");
    expect(loc.transition).toBeNull();
    expect(loc.stream.limit).toBe(5);
    expect(loc.issues).toEqual(['transition "0x3" is not a transition ID', 'unknown stream direction "sideways"', 'stream limit "500" must be 1–100']);
    expect(recentPulseHref({ view: "recent", rig: "1.0", transition: 7 })).toBe("/pulse?view=recent&rig=1.0&transition=7");
    const href = recentPulseHref({ view: "stream", stream: { direction: "chronological", after: "a&b=c", limit: 20 } });
    expect(parseRecentPulseLocation(rawQueryOf(href)).stream).toMatchObject({ direction: "chronological", after: "a&b=c", limit: 20 });
  });
});

// -------------------------------------------------- shared SSE scheduling

describe("Shared live refresh", () => {
  it("a queue event burst and a reconnect refresh the mounted views through the existing scheduler", async () => {
    server = freshServer(); stubNetwork();
    const router = mount("/pulse?view=recent", { events: true });
    await waitFor(() => expect(rowIds()).toHaveLength(8));
    act(() => emit?.("open"));
    const before = server.calls.filter((c) => c.startsWith("/api/queue/recent-transitions")).length;
    server.transitions = [...server.transitions, { ...server.transitions[7]!, transitionId: 11, ts: "2025-09-01T01:50:00.000Z" }];
    act(() => { for (let i = 0; i < 20; i++) emit?.("message", JSON.stringify({ type: "queue.updated", qitemId: "qitem-rp-done-1" })); });
    await waitFor(() => expect(rowIds()).toContain("11"), { timeout: 4000 });
    expect(server.calls.filter((c) => c.startsWith("/api/queue/recent-transitions")).length - before).toBe(1);

    act(() => router.history.replace("/pulse?view=stream"));
    await waitFor(() => expect(streamIds()).toHaveLength(5));
    server.stream = [...server.stream, { ...server.stream[8]!, streamItemId: "stream-rp-10", tsEmitted: "2025-09-01T01:59:00.000Z", streamSortKey: "2025-09-01T01:59:00.000Z#000010", body: "After reconnect" }];
    act(() => { emit?.("error"); emit?.("open"); });
    await waitFor(() => expect(streamIds()).toContain("stream-rp-10"), { timeout: 4000 });
  }, 12_000);
});
