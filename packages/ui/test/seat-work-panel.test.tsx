// Exact-seat work panel (docs/plans/gui-seat-work-contract.md) mounted through
// the actual topology seat route: SeatScopePage → LiveNodeDetails Overview →
// SeatWorkPanel, with the real inventory reader, useSeatWork windows,
// useRigAgents review read and production topology search adapters over
// served-contract fixtures. Covers multiple current/blocked/pending/finished
// rows, served totals vs bounded exact-session windows, per-window failure with
// dated retained rows and Retry, exact /pulse qitem push + Back, unknown counts
// and session, raw adopted address, same logical id on another rig/host,
// failed current identity with cached data, remote/unknown zero local reads,
// exact NeedsYou (agent + right-parsed derived) vs generic blocked, and runtime
// input need without a qitem.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useRouterState } from "@tanstack/react-router";
import { parseTopologySearch, stringifyTopologySearch } from "../src/lib/topology-search.js";
import { SeatScopePage } from "../src/components/topology/ScopePages.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

const SESSION = "desk-editor@bravo";
const T = (m: number) => `2026-10-05T0${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:00.000Z`;

function inventoryRow(over: Record<string, unknown> = {}) {
  return {
    rigId: "rig_bravo", rigName: "bravo", logicalId: "desk.editor", podId: "desk", podNamespace: "desk",
    canonicalSessionName: SESSION, nodeKind: "agent", runtime: "claude-code", sessionStatus: "running",
    startupStatus: "ready", restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
    agentActivity: { state: "running", reason: "tool_use", evidenceSource: "runtime_hook", sampledAt: T(30), eventAt: T(29) },
    assignedWorkCount: 9, pendingWorkCount: 4, inProgressWorkCount: 2, blockedWorkCount: 1,
    activityState: { activity: "working", display: "Working", needsInput: { count: 0, reason: null }, decidedBy: "runtime_hook", seq: 12, lastSwap: { generation: "g-3", at: T(20) } },
    ...over,
  };
}
const sibling = inventoryRow({ logicalId: "desk.writer", canonicalSessionName: "desk-writer@bravo" });

function q(id: string, state: string, minute: number, over: Record<string, unknown> = {}) {
  return {
    qitemId: id, sourceSession: "lead@bravo", destinationSession: SESSION, state, priority: "routine",
    tsCreated: T(minute), tsUpdated: T(minute + 1), body: `Body of ${id}\nsecond line`, summary: `Summary ${id}`,
    blockedOn: state === "blocked" ? "waiting-on-api" : null, handedOffTo: null, claimedAt: null, ...over,
  };
}
const CURRENT = [q("q-cur-1", "in-progress", 10), q("q-cur-2", "in-progress", 9), q("q-blocked", "blocked", 8)];
const PENDING = [q("q-pend-1", "pending", 7), q("q-pend-claimed", "pending", 6, { claimedAt: T(6) })];
const FINISHED = [q("q-done-old", "done", 1, { tsUpdated: T(2) }), q("q-done-new", "handed-off", 3, { tsUpdated: T(40) })];

function needsYou(items: unknown[]) {
  return { scope: "rig", needsYou: { items, provenance: "fixture" }, agents: { rows: [] }, settled: [], settledProvenance: "f", composedAt: T(31) };
}
function nyItem(over: Record<string, unknown>) {
  return { source: "agent", identity: "id", summary: "s", leg: "approve", where: "rig bravo", ageIso: null, priority: null, tier: null,
    evidenceRef: null, unblocks: null, qitemId: null, destinationSession: null, derived: null, ...over };
}
const NEEDS = [
  nyItem({ identity: "agent-exact", summary: "Approve the deploy plan", qitemId: "q-human-1", destinationSession: SESSION, unblocks: "deploy" }),
  nyItem({ identity: "agent-other", summary: "Other seat", destinationSession: `${SESSION}-2` }),
  nyItem({ identity: "agent-prose", summary: `Mentions ${SESSION} in prose`, where: SESSION, destinationSession: null }),
  nyItem({ source: "derived", identity: `${SESSION}|stuck|${T(5)}`, summary: "editor looks stuck", leg: "stuck", derived: { kind: "stuck", evidence: "idle 40m", threshold: "30m" } }),
  nyItem({ source: "derived", identity: `${SESSION}|too-long-in-state|${T(4)}`, summary: "no transition in 50m", leg: "stuck", derived: { kind: "stuck", evidence: "50m", threshold: "45m" } }),
  nyItem({ source: "derived", identity: `prefix|${SESSION}|stuck|${T(5)}`, summary: "prefixed session" }),
  nyItem({ source: "derived", identity: `${SESSION}|overdue|${T(5)}`, summary: "unrecognized suffix" }),
  { source: "agent", summary: "malformed row without identity" },
];

interface Fx {
  hosts: Record<string, unknown>;
  hostsStatus: number;
  inventory: () => Response;
  windows: Record<string, () => Response>;
  review: () => Response;
}
let fx: Fx;
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function nodeDetail(rigId: string, logicalId: string) {
  return {
    rigId, logicalId, rigName: "bravo", podId: "desk", canonicalSessionName: `${logicalId}@detail`, nodeKind: "agent", runtime: null,
    sessionStatus: null, startupStatus: null, restoreOutcome: "unknown", tmuxAttachCommand: null, resumeCommand: null, recoveryGuidance: null,
    latestError: null, model: null, agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: "/work/desk",
    startupFiles: [], startupActions: [], recentEvents: [], infrastructureStartupCommand: null, peers: [], edges: { outgoing: [], incoming: [] },
    transcript: { enabled: false, path: null, tailCommand: null }, compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
    currentQitems: [{ qitemId: "q-detail-snippet", bodyExcerpt: "detail snippet", tier: null }], nodeId: "node-1",
  };
}
function serve(input: RequestInfo | URL, init?: RequestInit): Response {
  if (init?.method && init.method !== "GET") throw new Error("fixture refuses mutations");
  const url = new URL(String(input), "http://fixture.invalid");
  if (url.pathname === "/api/hosts") return fx.hostsStatus === 200 ? json(fx.hosts) : json({ error: "down" }, fx.hostsStatus);
  if (/^\/api\/rigs\/[^/]+\/nodes$/.test(url.pathname)) return fx.inventory();
  const detail = url.pathname.match(/^\/api\/rigs\/([^/]+)\/nodes\/([^/]+)$/);
  if (detail) return json(nodeDetail(decodeURIComponent(detail[1]!), decodeURIComponent(detail[2]!)));
  if (url.pathname === "/api/queue/list") {
    const state = url.searchParams.get("state")!;
    const name = state === "pending" ? "pending" : state.includes("done") ? "finished" : "current";
    if (url.searchParams.get("destinationSession") !== SESSION) return json([]);
    return fx.windows[name]!();
  }
  if (url.pathname === "/api/review/rig") return fx.review();
  return json({ error: "not in fixture" }, 404);
}
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
const queueReads = () => urls().filter((u) => u.startsWith("/api/queue"));
const reviewReads = () => urls().filter((u) => u.startsWith("/api/review"));
const inventoryReads = () => urls().filter((u) => /^\/api\/rigs\/[^/]+\/nodes(\?|$)/.test(u));

let OriginalEventSource: typeof EventSource | undefined;
beforeEach(() => {
  fx = {
    hosts: { ownName: "fixture", selected: "local", hosts: [] }, hostsStatus: 200,
    inventory: () => json([inventoryRow(), sibling]),
    windows: { current: () => json(CURRENT), pending: () => json(PENDING), finished: () => json(FINISHED) },
    review: () => json(needsYou(NEEDS)),
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(serve);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});
afterEach(() => { cleanup(); if (OriginalEventSource) globalThis.EventSource = OriginalEventSource; });

function PulseDestination() {
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  return <div data-testid="pulse-destination" data-qitem={String(search.qitem)} />;
}
function renderSeat(path = `/topology/seat/rig_bravo/desk.editor?sourceHost=local`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/topology/seat/$rigId/$logicalId", component: SeatScopePage }),
      createRoute({ getParentRoute: () => root, path: "/pulse", component: PulseDestination }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    parseSearch: parseTopologySearch,
    stringifySearch: stringifyTopologySearch,
  });
  render(<RouterProvider router={router} />);
  return { router, client };
}
const section = (name: string) => screen.getByTestId(`seat-work-${name}`);
const rowIds = (name: string) => within(section(name)).queryAllByTestId("seat-work-row").map((r) => r.getAttribute("data-qitem-id"));
const ready = () => waitFor(() => expect(rowIds("current")).toHaveLength(3));

describe("seat work panel: windows and totals", () => {
  it("shows multiple current (incl. blocked), all pending incl. claimed, finished by update time, and served totals apart from windows", async () => {
    renderSeat();
    await ready();
    expect(rowIds("current")).toEqual(["q-cur-1", "q-cur-2", "q-blocked"]);
    expect(within(section("current")).getByText("Blocked")).toBeTruthy();
    expect(rowIds("pending")).toEqual(["q-pend-1", "q-pend-claimed"]);
    expect(within(section("pending")).getByText("Claimed")).toBeTruthy();
    expect(rowIds("finished")).toEqual(["q-done-new", "q-done-old"]);
    expect(section("finished").textContent).toContain("latest 20 created");
    const totals = section("totals");
    expect(within(totals).getByTestId("seat-work-total-assigned").textContent).toContain("9");
    expect(within(totals).getByTestId("seat-work-total-pending").textContent).toContain("4");
    expect(within(totals).getByTestId("seat-work-total-in-progress").textContent).toContain("2");
    expect(within(totals).getByTestId("seat-work-total-blocked").textContent).toContain("1");
    expect(totals.textContent).toContain(SESSION);
    // The old single current-work snippet no longer competes with the panel.
    expect(screen.queryByTestId("seat-overview-secondary-row-current-work")).toBeNull();
    expect(screen.getByTestId("seat-overview-secondary-cell-cwd").textContent).toBe("/work/desk");
    // Blocked work is current work, not a human request.
    expect(within(section("needs-you")).queryByText(/waiting-on-api/)).toBeNull();
  });

  it("canonical activity shows served display/decidedBy/sample/event/read facts", async () => {
    renderSeat();
    await ready();
    const activity = section("activity");
    expect(within(activity).getByTestId("seat-work-activity-display").textContent).toBe("Working");
    expect(activity.textContent).toContain("runtime_hook");
    expect(activity.textContent).toContain("tool_use");
    expect(within(activity).getByTestId("seat-work-activity-input").textContent).toContain("none reported");
  });

  it("unknown counts and missing activity stay 'not served'; no served session means no window reads", async () => {
    const bare = inventoryRow({ canonicalSessionName: null, activityState: null, agentActivity: null });
    for (const key of ["assignedWorkCount", "pendingWorkCount", "inProgressWorkCount", "blockedWorkCount"]) delete (bare as Record<string, unknown>)[key];
    fx.inventory = () => json([bare]);
    renderSeat();
    await waitFor(() => expect(section("current").textContent).toContain("no served session"));
    expect(within(section("totals")).getByTestId("seat-work-total-assigned").textContent).toContain("not served");
    expect(within(section("activity")).getByTestId("seat-work-activity-display").textContent).toContain("not served");
    expect(section("current").textContent).toContain("no served session");
    await new Promise((r) => setTimeout(r, 30));
    expect(queueReads()).toEqual([]);
  });

  it("a raw adopted address is used exactly as served; no alias is guessed", async () => {
    const RAW = "tmux:%7 adopted/pane";
    fx.inventory = () => json([inventoryRow({ canonicalSessionName: RAW })]);
    renderSeat();
    await waitFor(() => expect(queueReads().length).toBe(3));
    const sessions = queueReads().map((u) => new URL(u, "http://x").searchParams.get("destinationSession"));
    expect(new Set(sessions)).toEqual(new Set([RAW]));
    expect(section("totals").textContent).toContain(RAW);
  });

  it("a full window says more may exist", async () => {
    fx.windows.pending = () => json(Array.from({ length: 50 }, (_, i) => q(`q-p-${i}`, "pending", 7)));
    renderSeat();
    await waitFor(() => expect(rowIds("pending")).toHaveLength(50));
    expect(section("pending").textContent).toContain("more may exist");
  });
});

describe("seat work panel: failures, identity and source", () => {
  it("one failed window keeps dated retained rows with Retry while siblings stay current", async () => {
    const { client } = renderSeat();
    await ready();
    fx.windows.pending = () => json({ error: "down" }, 503);
    await act(async () => { await client.refetchQueries({ queryKey: ["recent-pulse"], type: "active" }); });
    const pending = section("pending");
    await waitFor(() => expect(within(pending).getByTestId("seat-work-window-stale")).toBeTruthy());
    expect(rowIds("pending")).toEqual(["q-pend-1", "q-pend-claimed"]);
    expect(within(pending).getByTestId("seat-work-window-stale").textContent).toContain("last read");
    expect(within(section("current")).queryByTestId("seat-work-window-stale")).toBeNull();
    fx.windows.pending = () => json([q("q-pend-new", "pending", 8)]);
    fireEvent.click(within(pending).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(rowIds("pending")).toEqual(["q-pend-new"]));
    expect(within(section("pending")).queryByTestId("seat-work-window-stale")).toBeNull();
  });

  it("a cold window failure is unavailable with Retry, not empty", async () => {
    fx.windows.finished = () => json({ error: "down" }, 503);
    renderSeat();
    await ready();
    const finished = section("finished");
    await waitFor(() => expect(within(finished).getByTestId("seat-work-window-error")).toBeTruthy());
    expect(within(finished).queryByTestId("seat-work-window-empty")).toBeNull();
    expect(within(finished).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a failed current inventory read keeps dated identity but authorizes no new work or review read", async () => {
    const { client } = renderSeat();
    await ready();
    await waitFor(() => expect(reviewReads().length).toBe(1));
    const before = { queue: queueReads().length, review: reviewReads().length };
    fx.inventory = () => json({ error: "down" }, 503);
    await act(async () => { await client.refetchQueries({ queryKey: ["rig", "rig_bravo", "nodes", "local"] }); });
    expect(await screen.findByTestId("seat-work-identity-stale")).toBeTruthy();
    expect(screen.getByTestId("seat-work-identity-stale").textContent).toContain("last read");
    // The shared scheduler refreshes ACTIVE queries only (sse-query-refresh).
    await act(async () => {
      await client.refetchQueries({ queryKey: ["recent-pulse"], type: "active" });
      await client.refetchQueries({ queryKey: ["review"], type: "active" });
    });
    expect(queueReads().length).toBe(before.queue);
    expect(reviewReads().length).toBe(before.review);
    expect(rowIds("current")).toEqual([]);
  });

  it("the same logical id on another rig reads only that rig's served session", async () => {
    fx.inventory = () => json([inventoryRow({ rigId: "rig_alpha", rigName: "alpha", canonicalSessionName: "desk-editor@alpha" })]);
    renderSeat("/topology/seat/rig_alpha/desk.editor?sourceHost=local");
    await waitFor(() => expect(queueReads().length).toBe(3));
    expect(new Set(queueReads().map((u) => new URL(u, "http://x").searchParams.get("destinationSession")))).toEqual(new Set(["desk-editor@alpha"]));
  });

  it("a remote source shows its served activity but reads no local queue or review", async () => {
    fx.hosts = { ownName: "fixture", selected: "vps-a", hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a.invalid", selected: true, status: "reachable" }] };
    renderSeat("/topology/seat/rig_bravo/desk.editor?sourceHost=vps-a");
    await waitFor(() => expect(within(section("activity")).getByTestId("seat-work-activity-display").textContent).toBe("Working"));
    expect(inventoryReads()).toContain("/api/rigs/rig_bravo/nodes?host=vps-a");
    expect(section("current").textContent).toContain("remote host vps-a");
    await new Promise((r) => setTimeout(r, 30));
    expect(queueReads()).toEqual([]);
    expect(reviewReads()).toEqual([]);
  });

  it("an unasserted source (legacy route) reads no inventory, queue or review for the panel", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> });
    const router = createRouter({
      routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/", component: () => <LiveNodeDetails rigId="rig_bravo" logicalId="desk.editor" /> })]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("seat-work-source-unknown")).toBeTruthy();
    // The legacy route keeps its detail-served current-work snippet.
    expect(screen.getByTestId("seat-overview-secondary-row-current-work")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(queueReads()).toEqual([]);
    expect(reviewReads()).toEqual([]);
    expect(inventoryReads()).toEqual([]);
  });
});

describe("seat work panel: Needs you and qitem navigation", () => {
  it("lists exact agent and right-parsed derived requests only; prose, prefixed, unrecognized and malformed rows are not attributed", async () => {
    renderSeat();
    await ready();
    const needs = section("needs-you");
    await waitFor(() => expect(within(needs).queryAllByTestId("seat-work-need").length).toBe(3));
    expect(within(needs).getAllByTestId("seat-work-need").map((n) => n.getAttribute("data-identity"))).toEqual([
      "agent-exact", `${SESSION}|stuck|${T(5)}`, `${SESSION}|too-long-in-state|${T(4)}`,
    ]);
    expect(needs.textContent).toContain("Approve the deploy plan");
    expect(needs.textContent).not.toContain("Mentions");
    expect(needs.textContent).not.toContain("prefixed session");
    expect(needs.textContent).toContain("1 review row could not be read");
  });

  it("a runtime input need without a qitem is shown, and review failure is unavailable rather than none", async () => {
    fx.inventory = () => json([inventoryRow({ activityState: { activity: "waiting", display: "Needs input", needsInput: { count: 1, reason: "permission prompt" }, decidedBy: "runtime_hook", seq: 13, lastSwap: null } })]);
    fx.review = () => json({ error: "down" }, 503);
    renderSeat();
    await ready();
    const needs = section("needs-you");
    await waitFor(() => expect(within(needs).getByTestId("seat-work-runtime-need").textContent).toContain("permission prompt"));
    await waitFor(() => expect(within(needs).getByTestId("seat-work-review-error")).toBeTruthy());
    expect(needs.textContent).not.toMatch(/nothing needs you/i);
  });

  it("a current qitem opens its exact /pulse evidence by push, and Back returns to the seat", async () => {
    const { router } = renderSeat();
    await ready();
    const index = router.history.location.state.__TSR_index;
    const link = within(section("current")).getAllByTestId("seat-work-qitem-link")[0]!;
    expect(link.getAttribute("href")).toBe("/pulse?qitem=q-cur-1");
    fireEvent.click(link);
    expect((await screen.findByTestId("pulse-destination")).getAttribute("data-qitem")).toBe("q-cur-1");
    expect(router.history.location.state.__TSR_index).toBe(index + 1);
    act(() => router.history.back());
    await ready();
    expect(router.state.location.pathname).toBe("/topology/seat/rig_bravo/desk.editor");
    expect(screen.getByTestId("live-tab-overview").getAttribute("aria-selected")).toBe("true");
  });
});

// A partial inventory read (a valid exact-seat record beside a malformed
// sibling) is a FAILED read: the seat's verified facts are shown with that
// read's own receipt, separately from older successful facts, and never
// authorize queue/review reads (the partial session differs on purpose).
describe("seat work panel: typed partial inventory evidence", () => {
  const malformedSibling = { rigId: "rig_bravo", logicalId: "desk.broken", runtime: 55 };
  const partialRow = inventoryRow({
    canonicalSessionName: "fresh-session@bravo", assignedWorkCount: 77,
    activityState: { activity: "waiting", display: "Partial read activity", needsInput: { count: 1, reason: "approval" }, decidedBy: "runtime_hook", seq: 20, lastSwap: null },
  });

  it("cold partial: exact verified facts are disclosed as partial and no queue or review is read", async () => {
    fx.inventory = () => json([partialRow, malformedSibling]);
    renderSeat();
    const partial = await screen.findByTestId("seat-work-partial");
    expect(within(partial).getByTestId("seat-work-partial-display").textContent).toBe("Partial read activity");
    expect(partial.textContent).toContain("assigned 77");
    expect(partial.textContent).toContain("1 other record was rejected");
    expect(partial.querySelector("time")).not.toBeNull();
    expect(within(section("activity")).getByTestId("seat-work-activity-display").textContent).toBe("not served");
    await new Promise((r) => setTimeout(r, 30));
    expect(queueReads()).toEqual([]);
    expect(reviewReads()).toEqual([]);
  });

  it("warm partial: newer partial facts sit beside dated older success; no new reads from either identity", async () => {
    const { client } = renderSeat();
    await ready();
    await waitFor(() => expect(reviewReads().length).toBe(1));
    const before = { queue: queueReads().length, review: reviewReads().length };
    const oldData = client.getQueryData(["rig", "rig_bravo", "nodes", "local"]);
    fx.inventory = () => json([partialRow, malformedSibling]);
    await act(async () => { await client.refetchQueries({ queryKey: ["rig", "rig_bravo", "nodes", "local"], exact: true }); });
    const partial = await screen.findByTestId("seat-work-partial");
    expect(within(partial).getByTestId("seat-work-partial-display").textContent).toBe("Partial read activity");
    expect(within(section("activity")).getByTestId("seat-work-activity-display").textContent).toBe("Working");
    expect(screen.getByTestId("seat-work-identity-stale")).toBeTruthy();
    expect(client.getQueryData(["rig", "rig_bravo", "nodes", "local"])).toBe(oldData);
    await act(async () => {
      await client.refetchQueries({ queryKey: ["recent-pulse"], type: "active" });
      await client.refetchQueries({ queryKey: ["review"], type: "active" });
    });
    expect(queueReads().length).toBe(before.queue);
    expect(reviewReads().length).toBe(before.review);
    expect(queueReads().some((u) => u.includes("fresh-session"))).toBe(false);
  });

  it("a partial read whose exact seat record was rejected discloses no seat facts (no sibling substitution)", async () => {
    fx.inventory = () => json([sibling, { rigId: "rig_bravo", logicalId: "desk.editor", runtime: 55 }]);
    renderSeat();
    expect(await screen.findByTestId("seat-work-identity-error")).toBeTruthy();
    expect(screen.queryByTestId("seat-work-partial")).toBeNull();
    expect(screen.getByTestId("seat-work-panel").textContent).not.toContain("desk-writer@bravo");
  });
});
