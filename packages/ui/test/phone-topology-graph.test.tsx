// Narrow-layout (<1024px) topology Graph tab: an interactive phone graph,
// not the old table fallback. Mounted through the production AppShell and
// scope pages with a real router, so these assert URL identity, tab
// behaviour, drill targets and rotation continuity end to end. Pixels,
// gestures and hardware limits are verified in-browser by root.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The seat terminal is the 3D workspace's guarded dock: WebSocket and xterm
// are stubbed, the node-detail read and admission machine are real.
const sockets: Array<{ url: string; sent: string[]; closeCalled: boolean }> = [];
class MockWS {
  url: string; readyState = 1; sent: string[] = []; closeCalled = false;
  onopen: (() => void) | null = null; onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(data: string) { this.sent.push(data); }
  close() { this.closeCalled = true; this.readyState = 3; }
  static OPEN = 1;
}
vi.stubGlobal("WebSocket", MockWS);
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open(el: HTMLElement) { const x = document.createElement("div"); x.className = "xterm"; x.tabIndex = 0; el.appendChild(x); }
    write() {} onData() {} focus() {} scrollToBottom() {} attachCustomWheelEventHandler() {} dispose() {}
    options = { fontSize: 13 };
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
import { render, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { AppShell } from "../src/components/AppShell.js";
import { HostScopePage, PodScopePage, RigScopePage } from "../src/components/topology/ScopePages.js";
import { parseSpatialRig } from "../src/lib/spatial-topology.js";
import { layoutPhoneGraph, phoneGraphColumns, readablePhoneViewport } from "../src/lib/phone-graph-layout.js";
import { TallyRow } from "../src/components/topology/PhoneGraphNodes.js";

const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;

type Graph = { nodes: unknown[]; edges: unknown[] };
let summary: Array<{ id: string; name: string; nodeCount: number }>;
let graphs: Record<string, Graph | number>;
/** Current node-detail payload per logical id (absent = unreadable). */
let details: Record<string, Record<string, unknown> | number>;

const seatDetail = (logicalId: string, pane: string | null = "%1") => ({
  nodeId: logicalId, rigId: "abc-rig", rigName: "acme", logicalId, canonicalSessionName: `${logicalId}@acme`,
  nodeKind: "agent", runtime: "claude-code", sessionStatus: pane ? "running" : "exited", podId: "pod", podNamespace: "core",
  startupStatus: "ready", restoreOutcome: "n-a", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
  model: null, agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: null,
  startupFiles: [], startupActions: [], recentEvents: [], infrastructureStartupCommand: null, peers: [],
  edges: { outgoing: [], incoming: [] }, transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
  binding: { attachmentType: "tmux", tmuxSession: `${logicalId}@acme`, tmuxPane: pane },
});

const seat = (id: string, pod: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  type: "rigNode",
  ...(pod ? { parentId: pod } : {}),
  data: { logicalId: id, canonicalSessionName: `${id}@acme`, status: "running", terminalActive: true, ...extra },
});

function defaultFleet() {
  summary = [{ id: "abc-rig", name: "acme", nodeCount: 3 }];
  graphs = {
    "abc-rig": {
      nodes: [
        { id: "pod-core", type: "podGroup", data: { podNamespace: "core" } },
        seat("core.lead", "pod-core"),
        seat("core.worker", "pod-core", { terminalActive: false }),
        { id: "pod-ops", type: "podGroup", data: { podNamespace: "ops" } },
        seat("ops.watch", "pod-ops"),
      ],
      edges: [
        { id: "e1", source: "core.lead", target: "core.worker", data: { kind: "delegates_to" } },
        { id: "e2", source: "core.lead", target: "ops.watch", data: { kind: "can_observe" } },
      ],
    },
  };
}

beforeEach(async () => {
  defaultFleet();
  details = {};
  sockets.length = 0;
  globalThis.fetch = mockFetch;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "/api/hosts") return new Response(JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }));
    if (url === "/api/rigs/summary") return new Response(JSON.stringify(summary));
    const nd = /^\/api\/rigs\/abc-rig\/nodes\/([^/?]+)/.exec(url);
    if (nd) {
      const d = details[decodeURIComponent(nd[1]!)];
      if (d === undefined || typeof d === "number") return new Response("unavailable", { status: typeof d === "number" ? d : 503 });
      return new Response(JSON.stringify(d));
    }
    const m = /^\/api\/rigs\/([^/]+)\/graph$/.exec(url);
    if (m) {
      const g = graphs[decodeURIComponent(m[1]!)];
      if (typeof g === "number") return new Response("boom", { status: g });
      if (g) return new Response(JSON.stringify(g));
      return new Response("not found", { status: 404 });
    }
    if (url === "/api/ps") {
      return new Response(JSON.stringify(summary.map((r) => ({
        rigId: r.id, name: r.name, status: "running", nodeCount: r.nodeCount, runningCount: r.nodeCount, uptime: null, latestSnapshot: null,
      }))));
    }
    return new Response("[]");
  });
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
  setWidth(1024);
});

/** Device of this viewport size (the screen matches it; rotation swaps
 *  both); height defaults to jsdom's 768. Phones are narrower than 600px on
 *  one side, tablets are at least 600px on both. */
function setWidth(width: number, height = 768) {
  Object.defineProperty(window.screen, "width", { configurable: true, value: width });
  Object.defineProperty(window.screen, "height", { configurable: true, value: height });
  setViewportHeight(height, width);
}

/** Viewport-only resize on the same device (a soft keyboard, a toolbar). */
function setViewportHeight(height: number, width = window.innerWidth) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width, writable: true });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height, writable: true });
  window.dispatchEvent(new Event("resize"));
}

function SeatProbe() {
  const params = useParams({ strict: false }) as Record<string, string>;
  return <div data-testid="seat-probe">{JSON.stringify(params)}</div>;
}

function renderAt(initialPath: string | string[], width: number, height?: number) {
  setWidth(width, height);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <AppShell>
          <Outlet />
        </AppShell>
      </QueryClientProvider>
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/topology", component: HostScopePage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/topology/rig/$rigId", component: RigScopePage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/topology/pod/$rigId/$podName", component: PodScopePage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/topology/seat/$rigId/$logicalId", component: SeatProbe }),
    createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: Array.isArray(initialPath) ? initialPath : [initialPath] }),
  });
  return { ...render(<RouterProvider router={router} />), router };
}

const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;
const qa = (c: HTMLElement, sel: string) => Array.from(c.querySelectorAll(sel)) as HTMLElement[];

async function seatChip(container: HTMLElement, logicalId: string) {
  return waitFor(() => {
    const el = qa(container, "[data-testid='phone-graph-seat']").find((n) => n.getAttribute("data-agent-key")?.endsWith(`/agent/${encodeURIComponent(logicalId)}`));
    expect(el).toBeTruthy();
    return el!;
  }, { timeout: 5000 });
}

/** React Flow attaches onNodeClick to the node wrapper around our chip. */
function tapNode(el: HTMLElement) {
  fireEvent.click(el.closest(".react-flow__node") ?? el);
}

describe("narrow Graph tab mounts an interactive phone graph (not the table)", () => {
  it.each([[430, 932], [932, 430], [834, 1194]])("at %ix%ipx the host Graph tab is the phone graph; Table stays its own tab", async (width, height) => {
    const { container, router } = renderAt("/topology", width, height);
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-canvas']")).toBeTruthy(), { timeout: 5000 });
    expect(q(container, "[data-testid='topology-host-tab-graph']")?.getAttribute("data-active")).toBe("true");
    // Neither the desktop canvas nor the retired fallback.
    expect(q(container, "[data-testid='host-multi-rig-graph']")).toBeNull();
    expect(q(container, "[data-testid='topology-mobile-graph-degraded']")).toBeNull();
    expect(q(container, "[data-testid='topology-table-view']")).toBeNull();
    // Real graph content: the rig frame, both pods and every seat chip.
    await seatChip(container, "ops.watch");
    expect(qa(container, "[data-testid='phone-graph-rig']").map((n) => n.getAttribute("data-rig-id"))).toEqual(["abc-rig"]);
    expect(qa(container, "[data-testid='phone-graph-pod']")).toHaveLength(2);
    expect(qa(container, "[data-testid='phone-graph-seat']")).toHaveLength(3);

    fireEvent.click(q(container, "[data-testid='topology-host-tab-table']")!);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ view: "table" }));
    await waitFor(() => expect(q(container, "[data-testid='phone-topology-graph']")).toBeNull());
    fireEvent.click(q(container, "[data-testid='topology-host-tab-graph']")!);
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-canvas']")).toBeTruthy());
  }, 20000);

  it("at desktop width the same tab still mounts the desktop canvas", async () => {
    const { container } = renderAt("/topology", 1440);
    await waitFor(() => expect(q(container, "[data-testid='host-multi-rig-graph']")).toBeTruthy(), { timeout: 5000 });
    expect(q(container, "[data-testid='phone-topology-graph']")).toBeNull();
  }, 15000);
});

/** The terminal is a portalled dialog (document.body), not inside the graph. */
async function terminalOverlay(_container?: HTMLElement) {
  return waitFor(() => {
    const el = q(document.body, "[data-testid='phone-graph-terminal']");
    expect(el).toBeTruthy();
    return el!;
  }, { timeout: 5000 });
}

describe("a seat tap opens its guarded live terminal; rig/pod taps only select", () => {
  it("canvas chip and seat row open the same exact-seat terminal over the graph, sending nothing", async () => {
    details["core.lead"] = seatDetail("core.lead");
    details["ops.watch"] = seatDetail("ops.watch");
    const { container, router } = renderAt("/topology", 430);
    tapNode(await seatChip(container, "core.lead"));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ selectedRig: "abc-rig", selectedNode: "core.lead" }));
    expect(router.state.location.pathname).toBe("/topology");
    const overlay = await terminalOverlay(container);
    expect(overlay.getAttribute("data-agent-key")).toContain("/agent/core.lead");
    await waitFor(() => expect(within(overlay).getByTestId("spatial-terminal-live").getAttribute("data-terminal-pane")).toBe("%1"));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url).toContain(encodeURIComponent("core.lead@acme"));
    // Opening attaches only: no text, keys or Enter.
    expect(sockets[0]!.sent.filter((f) => /"type":"(input|text|keys)"/.test(f))).toEqual([]);
    // The graph's duplicate Relationships list is gone (edges are unchanged
    // layout output; jsdom does not draw React Flow edges).
    expect(q(container, "[data-testid='phone-graph-relations']")).toBeNull();

    fireEvent.click(within(overlay).getByTestId("phone-graph-terminal-close"));
    await waitFor(() => expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeNull());
    expect(sockets[0]!.closeCalled).toBe(true);
    expect(router.state.location.search).toMatchObject({ selectedNode: "core.lead" });

    // A seat row (pod details) agrees with the canvas chip.
    tapNode(qa(container, "[data-testid='phone-graph-pod']").find((p) => p.textContent?.includes("ops"))!);
    const row = await waitFor(() => {
      const el = qa(container, "[data-testid='phone-graph-seat-row']").find((r) => r.textContent?.includes("watch"));
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(row);
    const second = await terminalOverlay(container);
    expect(second.getAttribute("data-agent-key")).toContain("/agent/ops.watch");
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]!.url).toContain(encodeURIComponent("ops.watch@acme"));
  }, 20000);

  it("a stopped seat or failed read shows the dock's refusal and opens no socket", async () => {
    details["core.worker"] = seatDetail("core.worker", null);
    const { container } = renderAt("/topology/rig/abc-rig", 430);
    tapNode(await seatChip(container, "core.worker"));
    const overlay = await terminalOverlay(container);
    await waitFor(() => expect(within(overlay).getByTestId("spatial-terminal-state").getAttribute("data-state")).toBe("no-pane"));
    fireEvent.click(within(overlay).getByTestId("phone-graph-terminal-close"));
    tapNode(await seatChip(container, "core.lead")); // no detail served → 503
    const failed = await terminalOverlay(container);
    await waitFor(() => expect(within(failed).getByTestId("spatial-terminal-state").getAttribute("data-state")).toBe("unreadable"));
    expect(sockets).toHaveLength(0);
  }, 20000);

  it("Back leaves with the socket closed; returning restores the selection but never reopens the terminal", async () => {
    details["core.lead"] = seatDetail("core.lead");
    const { container, router } = renderAt(["/elsewhere", "/topology/pod/abc-rig/core?sourceHost=local"], 430);
    tapNode(await seatChip(container, "core.lead"));
    await terminalOverlay(container);
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"));
    await waitFor(() => expect(sockets[0]!.closeCalled).toBe(true));
    act(() => router.history.forward());
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-seat-details']")).toBeTruthy(), { timeout: 5000 });
    expect(router.state.location.search).toMatchObject({ sourceHost: "local", selectedRig: "abc-rig", selectedNode: "core.lead" });
    expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeNull();
    expect(sockets).toHaveLength(1);
    // Explicit re-entry from the selected card.
    fireEvent.click(q(container, "[data-testid='phone-graph-open-terminal']")!);
    await terminalOverlay(container);
    await waitFor(() => expect(sockets).toHaveLength(2));
  }, 20000);

  it("is a top-level modal: page inert, Close focused (no soft keyboard), Tab trapped, Escape in the pane stays in the pane", async () => {
    details["core.lead"] = seatDetail("core.lead");
    const { container } = renderAt("/topology/rig/abc-rig", 430);
    tapNode(await seatChip(container, "core.lead"));
    const overlay = await terminalOverlay();
    // Portalled outside the routed content (whose stacking context the shell
    // bars sit above), and everything else is hidden from assistive tech.
    expect(container.contains(overlay)).toBe(false);
    // (React Flow's own aria-live region stays exposed by design of the
    // aria-hidden walk; the graph's controls and the shell are hidden.)
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-controls']")!.closest("[aria-hidden='true']")).toBeTruthy());
    expect(q(container, "[data-testid='phone-graph-details']")!.closest("[aria-hidden='true']")).toBeTruthy();
    const close = within(overlay).getByTestId("phone-graph-terminal-close");
    expect(document.activeElement).toBe(close);
    expect(overlay.getAttribute("aria-labelledby")).toBeTruthy();

    // Tab from the last control wraps inside the dialog, never to the page.
    await waitFor(() => expect(within(overlay).getByTestId("spatial-terminal-live")).toBeTruthy());
    const xterm = await waitFor(() => { const x = overlay.querySelector<HTMLElement>(".xterm"); expect(x).toBeTruthy(); return x!; });
    act(() => xterm.focus());
    fireEvent.keyDown(xterm, { key: "Tab" });
    expect(overlay.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(document.activeElement!, { key: "Tab" });
      expect(overlay.contains(document.activeElement)).toBe(true);
    }

    // Escape typed into the terminal is the pane's; Escape elsewhere closes.
    act(() => xterm.focus());
    fireEvent.keyDown(xterm, { key: "Escape" });
    expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeTruthy();
    act(() => close.focus());
    fireEvent.keyDown(close, { key: "Escape" });
    await waitFor(() => expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeNull());
    await waitFor(() => expect(sockets[0]!.closeCalled).toBe(true));
    expect(q(container, "[data-testid='phone-graph-controls']")!.closest("[aria-hidden='true']")).toBeNull();
  }, 20000);

  it("closing restores focus to the control that opened it", async () => {
    details["core.lead"] = seatDetail("core.lead");
    const { container } = renderAt("/topology/rig/abc-rig?selectedRig=abc-rig&selectedNode=core.lead", 430);
    const open = await waitFor(() => { const el = q(container, "[data-testid='phone-graph-open-terminal']"); expect(el).toBeTruthy(); return el!; }, { timeout: 5000 });
    act(() => open.focus());
    fireEvent.click(open);
    const overlay = await terminalOverlay();
    fireEvent.click(within(overlay).getByTestId("phone-graph-terminal-close"));
    await waitFor(() => expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(q(container, "[data-testid='phone-graph-open-terminal']")));
  }, 20000);

  it("Open seat still drills to the exact seat route with the source host", async () => {
    const { container, router } = renderAt("/topology", 430);
    tapNode(await seatChip(container, "core.worker"));
    fireEvent.click(within(await terminalOverlay(container)).getByTestId("phone-graph-terminal-close"));
    const open = await waitFor(() => {
      const el = q(container, "[data-testid='phone-graph-open-seat']");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(open.getAttribute("href")).toBe("/topology/seat/abc-rig/core.worker?sourceHost=local");
    fireEvent.click(open);
    await waitFor(() => expect(router.state.location.pathname).toBe("/topology/seat/abc-rig/core.worker"));
    expect(JSON.parse(q(container, "[data-testid='seat-probe']")!.textContent!)).toMatchObject({ rigId: "abc-rig", logicalId: "core.worker" });
  }, 20000);

  it("a rig tap selects the rig (Open rig is explicit); a pod tap offers the exact pod route", async () => {
    const { container, router } = renderAt("/topology", 430);
    await seatChip(container, "core.lead");
    tapNode(q(container, "[data-testid='phone-graph-rig']")!);
    const rigDetails = await waitFor(() => {
      const el = q(container, "[data-testid='phone-graph-rig-details']");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(router.state.location.pathname).toBe("/topology");
    expect(within(rigDetails).getByTestId("phone-graph-open-rig").getAttribute("href")).toBe("/topology/rig/abc-rig?sourceHost=local");

    const opsPod = qa(container, "[data-testid='phone-graph-pod']").find((p) => p.textContent?.includes("ops"))!;
    tapNode(opsPod);
    const podDetails = await waitFor(() => {
      const el = q(container, "[data-testid='phone-graph-pod-details']");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(podDetails).getByTestId("phone-graph-open-pod").getAttribute("href")).toBe("/topology/pod/abc-rig/ops?sourceHost=local");
    expect(router.state.location.pathname).toBe("/topology");
  }, 20000);
});

describe("progressive hierarchy keeps a dense fleet usable without hiding rigs", () => {
  it("dense fleets open as tiles; unreadable rigs keep a tile; expand per rig and expand all", async () => {
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => seat(`${prefix}.s${i}`, `pod-${prefix}`));
    summary = [
      { id: "r-a", name: "fleet", nodeCount: 12 },
      { id: "r-b", name: "fleet", nodeCount: 12 },
      { id: "r-bad", name: "broken", nodeCount: 2 },
    ];
    graphs = {
      "r-a": { nodes: [{ id: "pod-a", type: "podGroup", data: { podNamespace: "a" } }, ...many("a", 12)], edges: [] },
      "r-b": { nodes: [{ id: "pod-b", type: "podGroup", data: { podNamespace: "b" } }, ...many("b", 12)], edges: [] },
      "r-bad": 500,
    };
    const { container } = renderAt("/topology", 430);
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-rig']")).toHaveLength(3), { timeout: 5000 });
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-rig'][data-rig-id='r-bad']")?.getAttribute("data-state")).toBe("error"));
    const tiles = qa(container, "[data-testid='phone-graph-rig']");
    expect(tiles.map((t) => t.getAttribute("data-expanded"))).toEqual(["false", "false", "false"]);
    expect(qa(container, "[data-testid='phone-graph-seat']")).toHaveLength(0);
    // Duplicate rig names stay distinct entities, qualified by exact id.
    expect(tiles[0]!.textContent).toContain("r-a");
    expect(tiles[1]!.textContent).toContain("r-b");
    expect(q(container, "[data-testid='graph-partial-unavailable']")?.textContent).toContain("broken");

    fireEvent.click(within(tiles[0]!).getByTestId("phone-graph-rig-toggle"));
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-seat']")).toHaveLength(12));
    expect(q(container, "[data-testid='phone-graph-rig'][data-rig-id='r-a']")?.getAttribute("data-expanded")).toBe("true");

    fireEvent.click(q(container, "[data-testid='phone-graph-expand-all']")!);
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-seat']")).toHaveLength(24));
    fireEvent.click(q(container, "[data-testid='phone-graph-collapse-all']")!);
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-seat']")).toHaveLength(0));
  }, 20000);

  it("opening a seat in a collapsed pod re-expands the pod to reveal it", async () => {
    const { container, router } = renderAt("/topology/rig/abc-rig", 430);
    await seatChip(container, "ops.watch");
    const ops = qa(container, "[data-testid='phone-graph-pod']").find((p) => p.textContent?.includes("ops"))!;
    fireEvent.click(within(ops).getByTestId("phone-graph-pod-toggle"));
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-seat']")).toHaveLength(2));
    tapNode(qa(container, "[data-testid='phone-graph-pod']").find((p) => p.textContent?.includes("ops"))!);
    const row = await waitFor(() => {
      const el = q(container, "[data-testid='phone-graph-seat-row']");
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(row);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ selectedRig: "abc-rig", selectedNode: "ops.watch" }));
    await terminalOverlay(container);
    // The collapsed pod opened so the newly selected seat is drawn.
    await seatChip(container, "ops.watch");
  }, 20000);

  it("pod scope draws only that pod and reports a missing pod truthfully", async () => {
    const first = renderAt("/topology/pod/abc-rig/ops", 430);
    await seatChip(first.container, "ops.watch");
    expect(qa(first.container, "[data-testid='phone-graph-seat']")).toHaveLength(1);
    first.unmount();
    const missing = renderAt("/topology/pod/abc-rig/nope", 430);
    await waitFor(() => expect(q(missing.container, "[data-testid='phone-graph-pod-missing']")).toBeTruthy(), { timeout: 5000 });
  }, 20000);
});

describe("selection and scope survive rotation and the 1024px crossing", () => {
  it("portrait → landscape keeps the same mounted graph and selection; desktop and back keep the URL selection", async () => {
    const { container, router } = renderAt("/topology/rig/abc-rig", 430);
    tapNode(await seatChip(container, "core.worker"));
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-seat-details']")).toBeTruthy());
    const canvas = q(container, "[data-testid='phone-graph-canvas']");

    act(() => setWidth(932, 430));
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-seat-details']")).toBeTruthy());
    // Same element: rotation did not remount the graph (local state survives).
    expect(q(container, "[data-testid='phone-graph-canvas']")).toBe(canvas);
    expect(router.state.location.pathname).toBe("/topology/rig/abc-rig");

    act(() => setWidth(1440));
    await waitFor(() => expect(q(container, "[data-testid='graph-view']")).toBeTruthy(), { timeout: 5000 });
    expect(router.state.location.search).toMatchObject({ selectedRig: "abc-rig", selectedNode: "core.worker" });

    act(() => setWidth(834, 1194));
    const details = await waitFor(() => {
      const el = q(container, "[data-testid='phone-graph-seat-details']");
      expect(el).toBeTruthy();
      return el!;
    }, { timeout: 5000 });
    expect(details.getAttribute("data-agent-key")).toContain("/agent/core.worker");
    expect(q(container, "[data-testid='phone-graph-canvas']")?.getAttribute("data-columns")).toBe("2");
  }, 25000);

  it("a URL selection that is not in the served graph is disclosed, never substituted", async () => {
    const { container } = renderAt("/topology?sourceHost=local&selectedRig=abc-rig&selectedNode=gone.seat", 430);
    const issue = await waitFor(() => {
      const el = q(container, "[data-testid='phone-graph-selection-issue']");
      expect(el).toBeTruthy();
      return el!;
    }, { timeout: 5000 });
    expect(issue.textContent).toContain("not in rig acme's current graph");
    expect(q(container, "[data-testid='phone-graph-seat'][data-selected='true']")).toBeNull();
  }, 15000);
});

describe("camera controls never cover node controls (reserved space, measured surface)", () => {
  it("controls and peek live outside the drawable surface; every node control is inside it", async () => {
    const { container } = renderAt("/topology/rig/abc-rig", 430);
    tapNode(await seatChip(container, "core.lead"));
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-peek']")).toBeTruthy());
    const surface = q(container, "[data-testid='phone-graph-surface']")!;
    const flowRoot = surface.querySelector(".react-flow") as HTMLElement;
    expect(flowRoot).toBeTruthy();
    const controls = q(container, "[data-testid='phone-graph-controls']")!;
    const fit = q(container, "[data-testid='phone-graph-fit']")!;
    const peek = q(container, "[data-testid='phone-graph-peek']")!;
    // React Flow clips nodes to its root; the camera controls and peek are
    // outside that root and outside the measured surface entirely.
    for (const el of [controls, fit, q(container, "[data-testid='phone-graph-zoom-in']")!, q(container, "[data-testid='phone-graph-zoom-out']")!, peek]) {
      expect(flowRoot.contains(el)).toBe(false);
      expect(surface.contains(el)).toBe(false);
    }
    const toggles = qa(container, "[data-testid='phone-graph-pod-toggle']");
    expect(toggles.length).toBe(2);
    for (const t of toggles) expect(flowRoot.contains(t)).toBe(true);
    // Header above the surface, footer below it, all in one canvas column.
    const canvas = q(container, "[data-testid='phone-graph-canvas']")!;
    const order = Array.from(canvas.children).map((c) => c.getAttribute("data-testid"));
    expect(order).toEqual(["phone-graph-controls", "phone-graph-surface", "phone-graph-footer"]);
  }, 15000);

  it("the opening viewport is fitted to the measured surface, not the whole canvas", async () => {
    // jsdom has no layout: give the canvas a box and its drawable surface
    // that box minus the reserved 44px control header. The sizes are chosen
    // so fitting the whole canvas and fitting the surface give different
    // viewports (a canvas-sized fit would push nodes under the header).
    const CANVAS = { width: 520, height: 400 };
    const SURFACE = { width: 520, height: 400 - 44 };
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const id = this.getAttribute("data-testid");
      const box = id === "phone-graph-surface" ? SURFACE : id === "phone-graph-canvas" ? CANVAS : null;
      if (!box) return original.call(this);
      return { x: 0, y: 0, top: 0, left: 0, right: box.width, bottom: box.height, ...box, toJSON: () => box } as DOMRect;
    };
    try {
      const { container } = renderAt("/topology/rig/abc-rig", 932, 430);
      await seatChip(container, "ops.watch");
      const g = graphs["abc-rig"] as Graph;
      const rigModel = parseSpatialRig("local", { rigId: "abc-rig", rigName: "acme", graph: g });
      const layout = layoutPhoneGraph({
        entries: [{ kind: "ready", rig: rigModel }],
        truncatedRigCount: 0,
        statusByKey: new Map(),
        expandedRigIds: new Set(),
        collapsedPodKeys: new Set(),
        columns: phoneGraphColumns(SURFACE.width),
        scopeKind: "rig",
      });
      const onSurface = readablePhoneViewport(layout.bounds, SURFACE)!;
      const onCanvas = readablePhoneViewport(layout.bounds, CANVAS)!;
      expect(onSurface.y).not.toBeCloseTo(onCanvas.y, 1);
      expect(onSurface.zoom).not.toBeCloseTo(onCanvas.zoom, 3);
      const viewport = await waitFor(() => {
        const el = container.querySelector(".react-flow__viewport") as HTMLElement | null;
        const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(el?.style.transform ?? "");
        expect(m && Number(m[3]) !== 1 ? m : null).toBeTruthy();
        return { x: Number(m![1]), y: Number(m![2]), zoom: Number(m![3]) };
      });
      expect(viewport.zoom).toBeCloseTo(onSurface.zoom, 3);
      expect(viewport.x).toBeCloseTo(onSurface.x, 1);
      expect(viewport.y).toBeCloseTo(onSurface.y, 1);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  }, 15000);
});

/** Input capabilities as the browser reports them through media queries and
 *  navigator.maxTouchPoints. Hardware values are not observed here; these
 *  are the combinations the graph must handle. */
type Inputs = { pointer: "coarse" | "fine"; hover: boolean; anyCoarse: boolean; anyFine: boolean; maxTouchPoints: number };
const TOUCH_ONLY: Inputs = { pointer: "coarse", hover: false, anyCoarse: true, anyFine: false, maxTouchPoints: 5 };
/** A touchscreen with an attached trackpad/mouse that became the primary pointer. */
const TOUCH_WITH_POINTER: Inputs = { pointer: "fine", hover: true, anyCoarse: true, anyFine: true, maxTouchPoints: 5 };
/** Media queries report only the fine pointer; touch points remain. */
const TOUCH_POINTS_ONLY: Inputs = { pointer: "fine", hover: true, anyCoarse: false, anyFine: true, maxTouchPoints: 5 };
const MOUSE_ONLY: Inputs = { pointer: "fine", hover: true, anyCoarse: false, anyFine: true, maxTouchPoints: 0 };

function stubInputs(initial: Inputs) {
  let inputs = initial;
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const feature = (f: string, v: string) =>
    f === "pointer" ? inputs.pointer === v
      : f === "hover" ? (v === "hover") === inputs.hover
        : f === "any-pointer" ? (v === "coarse" ? inputs.anyCoarse : v === "fine" ? inputs.anyFine : false)
          : false;
  const evaluate = (query: string) => query.split(",").some((alt) => alt.split(/\s+and\s+/).every((part) => {
    const m = /\(\s*([a-z-]+)\s*:\s*([a-z]+)\s*\)/.exec(part);
    return m ? feature(m[1]!, m[2]!) : false;
  }));
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      const set = listeners.get(query) ?? new Set();
      listeners.set(query, set);
      return {
        get matches() { return evaluate(query); },
        media: query, onchange: null,
        addEventListener: (_t: string, fn: (e: Event) => void) => set.add(fn),
        removeEventListener: (_t: string, fn: (e: Event) => void) => set.delete(fn),
        addListener: (fn: (e: Event) => void) => set.add(fn),
        removeListener: (fn: (e: Event) => void) => set.delete(fn),
        dispatchEvent: () => false,
      };
    },
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", { configurable: true, get: () => inputs.maxTouchPoints });
  return {
    /** Devices connect/disconnect: no resize, only media-query change events. */
    set(next: Inputs) {
      inputs = next;
      act(() => { for (const fns of [...listeners.values()]) for (const fn of [...fns]) fn(new Event("change")); });
    },
    listeners: (pattern: RegExp) => [...listeners].filter(([q]) => pattern.test(q)).reduce((n, [, fns]) => n + fns.size, 0),
    restore() {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
      delete (window.navigator as { maxTouchPoints?: number }).maxTouchPoints;
    },
  };
}

/** jsdom has no layout: give the drawable surface a width (its height is
 *  whatever the graph sets on it). */
function stubSurfaceWidth(width: number) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.getAttribute("data-testid") !== "phone-graph-surface") return original.call(this);
    const box = { width, height: parseFloat(this.style.height) || 0 };
    return { x: 0, y: 0, top: 0, left: 0, right: box.width, bottom: box.height, ...box, toJSON: () => box } as DOMRect;
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

/** Every node's drawn box in surface pixels, from the rendered camera. */
function drawnBoxes(container: HTMLElement) {
  const vpEl = container.querySelector(".react-flow__viewport") as HTMLElement;
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(vpEl.style.transform)!;
  const vp = { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
  const boxes = qa(container, ".react-flow__node").map((el) => {
    const t = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform)!;
    const left = vp.x + Number(t[1]) * vp.zoom;
    const top = vp.y + Number(t[2]) * vp.zoom;
    return { left, top, right: left + parseFloat(el.style.width) * vp.zoom, bottom: top + parseFloat(el.style.height) * vp.zoom };
  });
  return { vp, boxes };
}

function denseFleet(rigs: number, seatsPerRig: number) {
  summary = Array.from({ length: rigs }, (_, r) => ({ id: `r${r}`, name: `fleet-${r}`, nodeCount: seatsPerRig }));
  graphs = Object.fromEntries(summary.map((r) => [r.id, {
    nodes: [
      { id: `pod-${r.id}`, type: "podGroup", data: { podNamespace: "core" } },
      ...Array.from({ length: seatsPerRig }, (_, i) => seat(`${r.id}.s${i}`, `pod-${r.id}`)),
    ],
    edges: [],
  }]));
}

describe("tablet page flow: a readable full-width graph the page scrolls through", () => {
  const restores: Array<() => void> = [];
  afterEach(() => { while (restores.length) restores.pop()!(); });

  it.each([[1180, 820], [1194, 834]])("iPad landscape %ix%ipx (touch) keeps the touch graph at host, rig and pod scope", async (width, height) => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    for (const path of ["/topology", "/topology/rig/abc-rig", "/topology/pod/abc-rig/core"]) {
      const { container, unmount } = renderAt(path, width, height);
      const canvas = await waitFor(() => { const el = q(container, "[data-testid='phone-graph-canvas']"); expect(el).toBeTruthy(); return el!; }, { timeout: 5000 });
      expect(canvas.getAttribute("data-flow")).toBe("page");
      await seatChip(container, "core.lead");
      expect(q(container, "[data-testid='host-multi-rig-graph']")).toBeNull();
      expect(q(container, "[data-testid='graph-view']")).toBeNull();
      // The shell itself is still the wide layout (breakpoint unchanged).
      expect(q(container, "[data-testid='mobile-rail-tray']")).toBeNull();
      unmount();
    }
  }, 30000);

  it("a mouse-only desktop at iPad-landscape width keeps the desktop canvas; a touch phone keeps its bounded canvas", async () => {
    restores.push(stubInputs(MOUSE_ONLY).restore);
    const desktop = renderAt("/topology", 1180, 820);
    await waitFor(() => expect(q(desktop.container, "[data-testid='host-multi-rig-graph']")).toBeTruthy(), { timeout: 5000 });
    expect(q(desktop.container, "[data-testid='phone-topology-graph']")).toBeNull();
    desktop.unmount();

    restores.push(stubInputs(TOUCH_ONLY).restore);
    for (const [w, h] of [[430, 932], [932, 430]] as const) {
      const phone = renderAt("/topology/rig/abc-rig", w, h);
      const canvas = await waitFor(() => { const el = q(phone.container, "[data-testid='phone-graph-canvas']"); expect(el).toBeTruthy(); return el!; }, { timeout: 5000 });
      expect(canvas.getAttribute("data-flow")).toBe("bounded");
      expect(canvas.className).toContain("58svh");
      await seatChip(phone.container, "core.lead");
      expect((phone.container.querySelector(".react-flow") as HTMLElement).className).toContain("touch-none");
      phone.unmount();
    }
  }, 20000);

  it.each([
    ["touch only", TOUCH_ONLY],
    ["touch with an attached trackpad/mouse as primary pointer", TOUCH_WITH_POINTER],
    ["touch points reported, fine pointer media only", TOUCH_POINTS_ONLY],
  ] as const)("1180x820 %s: a touch-capable tablet keeps the tablet graph", async (_label, inputs) => {
    restores.push(stubInputs(inputs).restore);
    const { container } = renderAt("/topology", 1180, 820);
    const canvas = await waitFor(() => { const el = q(container, "[data-testid='phone-graph-canvas']"); expect(el).toBeTruthy(); return el!; }, { timeout: 5000 });
    expect(canvas.getAttribute("data-flow")).toBe("page");
    expect(q(container, "[data-testid='host-multi-rig-graph']")).toBeNull();
  }, 15000);

  it("connecting and disconnecting a pointer keeps the open tablet graph and terminal; a mouse-only desktop follows a touch capability change", async () => {
    details["core.lead"] = seatDetail("core.lead");
    const inputs = stubInputs(TOUCH_ONLY);
    restores.push(inputs.restore);
    const tablet = renderAt("/topology/rig/abc-rig", 1180, 820);
    tapNode(await seatChip(tablet.container, "core.lead"));
    const overlay = await terminalOverlay();
    await waitFor(() => expect(sockets).toHaveLength(1));
    const canvas = q(tablet.container, "[data-testid='phone-graph-canvas']");
    for (const next of [TOUCH_WITH_POINTER, TOUCH_ONLY, TOUCH_POINTS_ONLY]) {
      inputs.set(next);
      expect(q(tablet.container, "[data-testid='phone-graph-canvas']")).toBe(canvas);
      expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBe(overlay);
      expect(sockets[0]!.closeCalled).toBe(false);
    }
    expect(sockets).toHaveLength(1);
    tablet.unmount();
    // The capability subscription is released with the page.
    expect(inputs.listeners(/any-pointer/)).toBe(0);

    inputs.set(MOUSE_ONLY);
    const desktop = renderAt("/topology", 1180, 820);
    await waitFor(() => expect(q(desktop.container, "[data-testid='host-multi-rig-graph']")).toBeTruthy(), { timeout: 5000 });
    expect(inputs.listeners(/any-pointer/)).toBeGreaterThan(0);
    // A touchscreen reported without any resize switches the graph...
    inputs.set({ ...MOUSE_ONLY, anyCoarse: true });
    await waitFor(() => expect(q(desktop.container, "[data-testid='phone-graph-canvas']")?.getAttribute("data-flow")).toBe("page"), { timeout: 5000 });
    // ...and losing it returns the desktop canvas.
    inputs.set(MOUSE_ONLY);
    await waitFor(() => expect(q(desktop.container, "[data-testid='host-multi-rig-graph']")).toBeTruthy(), { timeout: 5000 });
    desktop.unmount();
    expect(inputs.listeners(/any-pointer/)).toBe(0);
  }, 25000);

  it.each([[1180, 820, 400], [834, 1194, 560]])("%ix%i: a keyboard-height viewport (%ipx) keeps the open tablet graph and terminal", async (width, height, keyboardHeight) => {
    restores.push(stubInputs(TOUCH_WITH_POINTER).restore);
    details["core.lead"] = seatDetail("core.lead");
    const { container } = renderAt("/topology/rig/abc-rig", width, height);
    tapNode(await seatChip(container, "core.lead"));
    const overlay = await terminalOverlay();
    await waitFor(() => expect(sockets).toHaveLength(1));
    const canvas = q(container, "[data-testid='phone-graph-canvas']");
    act(() => setViewportHeight(keyboardHeight));
    expect(q(container, "[data-testid='phone-graph-canvas']")).toBe(canvas);
    expect(canvas!.getAttribute("data-flow")).toBe("page");
    expect(q(container, "[data-testid='graph-view']")).toBeNull();
    expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBe(overlay);
    expect(sockets[0]!.closeCalled).toBe(false);
    act(() => setViewportHeight(height));
    expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBe(overlay);
    expect(sockets).toHaveLength(1);
  }, 20000);

  it("a short tablet viewport keeps page flow with details below; phone landscape keeps details beside the canvas", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    details["core.lead"] = seatDetail("core.lead");
    // jsdom does not evaluate media queries: assert which containers carry the
    // short-landscape (max-height 540px) rules that put details beside the canvas.
    const SHORT = "max-height:540px";
    const parts = (c: HTMLElement) => {
      const canvas = q(c, "[data-testid='phone-graph-canvas']")!;
      return {
        flow: canvas.getAttribute("data-flow"),
        row: canvas.parentElement!.className.includes(SHORT),
        canvas: canvas.className.includes(SHORT),
        footer: q(c, "[data-testid='phone-graph-footer']")!.className.includes(SHORT),
        details: q(c, "[data-testid='phone-graph-details']")!.className.includes(SHORT),
      };
    };
    // Tablet: an 1180x820 screen whose viewport is 400px tall (keyboard open).
    const tablet = renderAt("/topology/rig/abc-rig", 1180, 820);
    act(() => setViewportHeight(400));
    tapNode(await seatChip(tablet.container, "core.lead"));
    expect((await terminalOverlay()).getAttribute("data-agent-key")).toContain("/agent/core.lead");
    expect(parts(tablet.container)).toEqual({ flow: "page", row: false, canvas: false, footer: false, details: false });
    expect(q(tablet.container, "[data-testid='graph-view']")).toBeNull();
    tablet.unmount();
    // Phone landscape keeps every short-landscape rule, and its terminal path.
    const phone = renderAt("/topology/rig/abc-rig", 932, 430);
    tapNode(await seatChip(phone.container, "core.lead"));
    expect((await terminalOverlay()).getAttribute("data-agent-key")).toContain("/agent/core.lead");
    expect(parts(phone.container)).toEqual({ flow: "bounded", row: true, canvas: true, footer: true, details: true });
  }, 20000);

  it.each([[820, 1180], [834, 1194]])("iPad portrait %ix%ipx: a dense fleet is drawn full width, readable, and as tall as the graph", async (width, height) => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    const SURFACE = width - 26;
    restores.push(stubSurfaceWidth(SURFACE));
    denseFleet(6, 12);
    const { container } = renderAt("/topology", width, height);
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-rig']")).toHaveLength(6), { timeout: 5000 });
    fireEvent.click(q(container, "[data-testid='phone-graph-expand-all']")!);
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-seat']")).toHaveLength(72));
    const surface = q(container, "[data-testid='phone-graph-surface']")!;
    const { vp, boxes } = await waitFor(() => {
      const d = drawnBoxes(container);
      expect(d.vp.zoom).not.toBe(1);
      expect(Math.max(...d.boxes.map((b) => b.bottom))).toBeLessThanOrEqual(parseFloat(surface.style.height));
      return d;
    });
    const surfaceHeight = parseFloat(surface.style.height);
    // Readable: seats at (near) full size, not a fleet shrunk into a short canvas.
    expect(vp.zoom).toBeGreaterThan(0.95);
    // Every node — the first and the last rig — lies inside the surface:
    // no clipping at either side, and the surface ends where the graph ends,
    // so the page (not a nested canvas) scrolls to it.
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(SURFACE);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.bottom).toBeLessThanOrEqual(surfaceHeight);
    }
    expect(Math.min(...boxes.map((b) => b.top))).toBeLessThan(24);
    expect(surfaceHeight - Math.max(...boxes.map((b) => b.bottom))).toBeLessThan(24);
    expect(surfaceHeight).toBeGreaterThan(height);
    // No nested pan area: the canvas takes no drag, so touches scroll the page.
    expect((container.querySelector(".react-flow") as HTMLElement).className).not.toContain("touch-none");
    // The panels below the graph follow it in the page.
    const canvas = q(container, "[data-testid='phone-graph-canvas']")!;
    expect(canvas.compareDocumentPosition(q(container, "[data-testid='phone-graph-details']")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // First and last seats each open their own exact terminal.
    const chips = qa(container, "[data-testid='phone-graph-seat']");
    for (const chip of [chips[0]!, chips[chips.length - 1]!]) {
      const key = chip.getAttribute("data-agent-key")!;
      tapNode(chip);
      const overlay = await terminalOverlay();
      expect(overlay.getAttribute("data-agent-key")).toBe(key);
      fireEvent.click(within(overlay).getByTestId("phone-graph-terminal-close"));
      await waitFor(() => expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeNull());
    }
  }, 30000);

  it("− / + step a page zoom between a legible floor and full width; Reset returns the readable view", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    restores.push(stubSurfaceWidth(808));
    denseFleet(4, 12);
    const { container } = renderAt("/topology", 834, 1194);
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-rig']")).toHaveLength(4), { timeout: 5000 });
    fireEvent.click(q(container, "[data-testid='phone-graph-expand-all']")!);
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-seat']")).toHaveLength(48));
    const surface = q(container, "[data-testid='phone-graph-surface']")!;
    const zoomOut = q(container, "[data-testid='phone-graph-zoom-out']") as HTMLButtonElement;
    const zoomIn = q(container, "[data-testid='phone-graph-zoom-in']") as HTMLButtonElement;
    const readable = await waitFor(() => { const z = drawnBoxes(container).vp.zoom; expect(z).toBeGreaterThan(0.95); return z; });
    const tall = parseFloat(surface.style.height);
    expect(zoomIn.disabled).toBe(true);
    expect(q(container, "[data-testid='phone-graph-fit']")!.getAttribute("aria-label")).toBe("Reset to readable width");

    for (let i = 0; i < 12; i++) if (!zoomOut.disabled) fireEvent.click(zoomOut);
    await waitFor(() => expect(zoomOut.disabled).toBe(true));
    const { vp, boxes } = drawnBoxes(container);
    // The floor is legible, never the old whole-graph 0.15.
    expect(vp.zoom).toBeCloseTo(0.5, 3);
    // Zooming out shortens the graph (more fits on screen) and keeps it inside its surface.
    const short = parseFloat(surface.style.height);
    expect(short).toBeLessThan(tall * 0.6);
    for (const b of boxes) expect(b.bottom).toBeLessThanOrEqual(short);

    fireEvent.click(zoomIn);
    await waitFor(() => expect(drawnBoxes(container).vp.zoom).toBeCloseTo(0.6, 3));
    fireEvent.click(q(container, "[data-testid='phone-graph-fit']")!);
    await waitFor(() => expect(drawnBoxes(container).vp.zoom).toBeCloseTo(readable, 3));
    expect(parseFloat(surface.style.height)).toBe(tall);
    expect(zoomIn.disabled).toBe(true);
  }, 20000);

  it("seat taps open the exact guarded terminal; a stopped seat is refused; rotation keeps the graph and selection", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    details["core.lead"] = seatDetail("core.lead");
    details["core.worker"] = seatDetail("core.worker", null);
    const { container, router } = renderAt("/topology/rig/abc-rig", 834, 1194);
    tapNode(await seatChip(container, "core.lead"));
    const overlay = await terminalOverlay();
    expect(overlay.getAttribute("data-agent-key")).toContain("/agent/core.lead");
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url).toContain(encodeURIComponent("core.lead@acme"));
    fireEvent.click(within(overlay).getByTestId("phone-graph-terminal-close"));
    await waitFor(() => expect(sockets[0]!.closeCalled).toBe(true));

    tapNode(await seatChip(container, "core.worker"));
    const refused = await terminalOverlay();
    await waitFor(() => expect(within(refused).getByTestId("spatial-terminal-state").getAttribute("data-state")).toBe("no-pane"));
    expect(sockets).toHaveLength(1);
    fireEvent.click(within(refused).getByTestId("phone-graph-terminal-close"));
    await waitFor(() => expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeNull());

    const canvas = q(container, "[data-testid='phone-graph-canvas']");
    act(() => setWidth(1194, 834));
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-seat-details']")).toBeTruthy());
    expect(q(container, "[data-testid='phone-graph-canvas']")).toBe(canvas);
    expect(canvas!.getAttribute("data-flow")).toBe("page");
    expect(router.state.location.search).toMatchObject({ selectedRig: "abc-rig", selectedNode: "core.worker" });
    expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeNull();
  }, 20000);

  it("a rig row scrolls the page to that rig's drawn tile", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    restores.push(stubSurfaceWidth(808));
    denseFleet(6, 12);
    const scrolled: HTMLElement[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this); };
    restores.push(() => { HTMLElement.prototype.scrollIntoView = original; });
    const { container } = renderAt("/topology", 834, 1194);
    await waitFor(() => expect(qa(container, "[data-testid='phone-graph-rig']")).toHaveLength(6), { timeout: 5000 });
    await waitFor(() => expect(drawnBoxes(container).vp.zoom).not.toBe(1));
    const rows = qa(container, "[data-testid='phone-graph-rig-row']");
    fireEvent.click(rows[rows.length - 1]!);
    await waitFor(() => expect(scrolled).toHaveLength(1));
    const mark = scrolled[0]!;
    const surface = q(container, "[data-testid='phone-graph-surface']")!;
    expect(surface.contains(mark)).toBe(true);
    expect(container.querySelector(".react-flow")!.contains(mark)).toBe(false);
    const tile = q(container, "[data-testid='phone-graph-rig'][data-rig-id='r5']")!.closest(".react-flow__node") as HTMLElement;
    const { vp } = drawnBoxes(container);
    const tileTop = vp.y + Number(/translate\([-\d.]+px,\s*([-\d.]+)px\)/.exec(tile.style.transform)![1]) * vp.zoom;
    expect(parseFloat(mark.style.top)).toBeCloseTo(tileTop, 1);
  }, 20000);
});

describe("node status tallies fit their fixed-height row", () => {
  it("five tones stay on one line as dot + count, with full labels for title and screen readers", () => {
    const tally = { active: 3, needs_input: 1, blocked: 1, idle: 2, unknown: 0, offline: 1 };
    const { container } = render(<TallyRow tally={tally} fit />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("flex-nowrap");
    expect(row.className).not.toContain("flex-wrap ");
    expect(row.getAttribute("title")).toBe("3 active · 1 needs input · 1 blocked · 2 idle · 1 offline");
    expect(row.querySelectorAll(".sr-only")).toHaveLength(5);
    // Three or fewer tones keep their visible labels.
    const few = render(<TallyRow tally={{ ...tally, blocked: 0, idle: 0, offline: 0 }} fit />).container.firstElementChild as HTMLElement;
    expect(few.querySelectorAll(".sr-only")).toHaveLength(0);
    expect(few.textContent).toContain("3 active");
  });
});
