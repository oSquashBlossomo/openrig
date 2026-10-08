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
 *  both); height defaults to jsdom's 768. */
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
  return { ...render(<RouterProvider router={router} />), router, queryClient };
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
  it.each([[430], [932], [834]])("at %ipx the host Graph tab is the phone graph; Table stays its own tab", async (width) => {
    const { container, router } = renderAt("/topology", width);
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

    act(() => setWidth(932));
    await waitFor(() => expect(q(container, "[data-testid='phone-graph-seat-details']")).toBeTruthy());
    // Same element: rotation did not remount the graph (local state survives).
    expect(q(container, "[data-testid='phone-graph-canvas']")).toBe(canvas);
    expect(router.state.location.pathname).toBe("/topology/rig/abc-rig");

    act(() => setWidth(1440));
    await waitFor(() => expect(q(container, "[data-testid='graph-view']")).toBeTruthy(), { timeout: 5000 });
    expect(router.state.location.search).toMatchObject({ selectedRig: "abc-rig", selectedNode: "core.worker" });

    act(() => setWidth(834));
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
      const { container } = renderAt("/topology/rig/abc-rig", 932);
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

const SCOPES = [
  ["host", "/topology", "host-multi-rig-graph"],
  ["rig", "/topology/rig/abc-rig", "graph-view"],
  ["pod", "/topology/pod/abc-rig/core", "graph-view"],
] as const;

async function graphFrame(container: HTMLElement, renderer: string) {
  await waitFor(() => expect(q(container, `[data-testid='${renderer}']`)).toBeTruthy(), { timeout: 5000 });
  return q(container, "[data-testid='topology-graph-frame']")!;
}

/** jsdom has no layout: the frame's sizing rule is what decides whether it
 *  keeps a tall allocation (shrink-0 + min height) or shares what is left. */
function expectTallFrame(container: HTMLElement, frame: HTMLElement) {
  expect(frame.getAttribute("data-tall")).toBe("true");
  expect(frame.className).toContain("shrink-0");
  expect(frame.className).toMatch(/min-h-\[max\(24rem,calc\(100svh-/);
  expect(frame.className).not.toContain("min-h-0");
  // The sections below the graph (Recent at host and rig scope; pod scope's
  // Graph tab has none) follow it in the page, so they are pushed down and
  // scrolled to rather than squeezing it.
  const recent = q(container, "[data-testid='topology-recent-frame']");
  if (recent) expect(frame.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  return recent;
}

describe("touch tablets keep the desktop graph in a tall frame", () => {
  const restores: Array<() => void> = [];
  afterEach(() => { while (restores.length) restores.pop()!(); });

  for (const [w, h] of [[820, 1180], [834, 1194], [1180, 820], [1194, 834]] as const) {
    it.each(SCOPES)(`${w}x${h} %s scope: the desktop renderer in a tall, non-shrinking frame`, async (scope, path, renderer) => {
      restores.push(stubInputs(TOUCH_ONLY).restore);
      const { container } = renderAt(path, w, h);
      const frame = await graphFrame(container, renderer);
      expect(q(container, "[data-testid='phone-topology-graph']")).toBeNull();
      expect(frame.contains(q(container, `[data-testid='${renderer}']`))).toBe(true);
      expect(expectTallFrame(container, frame) !== null).toBe(scope !== "pod");
      // The shell breakpoint is unchanged: portrait keeps the narrow shell.
      expect(q(container, "[data-testid='mobile-rail-tray']") === null).toBe(w >= 1024);
    }, 15000);
  }

  it.each([
    ["an attached trackpad/mouse as primary pointer", TOUCH_WITH_POINTER],
    ["touch points with fine-pointer media only", TOUCH_POINTS_ONLY],
  ] as const)("834x1194 with %s still gets the tall desktop graph", async (_label, inputs) => {
    restores.push(stubInputs(inputs).restore);
    const { container } = renderAt("/topology", 834, 1194);
    expectTallFrame(container, await graphFrame(container, "host-multi-rig-graph"));
  }, 15000);

  it("a mouse-only desktop keeps the shared frame; a narrow mouse-only window and touch phones keep the phone graph", async () => {
    restores.push(stubInputs(MOUSE_ONLY).restore);
    for (const [w, h] of [[1440, 900], [1180, 820]] as const) {
      const desktop = renderAt("/topology", w, h);
      const frame = await graphFrame(desktop.container, "host-multi-rig-graph");
      expect(frame.getAttribute("data-tall")).toBeNull();
      expect(frame.className).toContain("min-h-0");
      expect(frame.className).not.toContain("shrink-0");
      desktop.unmount();
    }
    const narrow = renderAt("/topology", 834, 1194);
    await waitFor(() => expect(q(narrow.container, "[data-testid='phone-graph-canvas']")).toBeTruthy(), { timeout: 5000 });
    narrow.unmount();

    restores.push(stubInputs(TOUCH_ONLY).restore);
    for (const [w, h] of [[430, 932], [932, 430]] as const) {
      const phone = renderAt("/topology/rig/abc-rig", w, h);
      await seatChip(phone.container, "core.lead");
      expect(q(phone.container, "[data-testid='topology-graph-frame']")).toBeNull();
      expect(q(phone.container, "[data-testid='graph-view']")).toBeNull();
      phone.unmount();
    }
  }, 25000);

  it("pointer connect/disconnect, a keyboard-height viewport and rotation keep the same mounted desktop graph", async () => {
    const inputs = stubInputs(TOUCH_ONLY);
    restores.push(inputs.restore);
    const { container, unmount } = renderAt("/topology", 834, 1194);
    await graphFrame(container, "host-multi-rig-graph");
    const graph = q(container, "[data-testid='host-multi-rig-graph']");
    const same = () => {
      expect(q(container, "[data-testid='host-multi-rig-graph']")).toBe(graph);
      expectTallFrame(container, q(container, "[data-testid='topology-graph-frame']")!);
    };
    for (const next of [TOUCH_WITH_POINTER, TOUCH_POINTS_ONLY, TOUCH_ONLY]) { inputs.set(next); same(); }
    act(() => setViewportHeight(560));
    same();
    act(() => setViewportHeight(1194));
    act(() => setWidth(1194, 834));
    same();
    act(() => setViewportHeight(400));
    same();
    unmount();
    expect(inputs.listeners(/any-pointer/)).toBe(0);
  }, 20000);
});

/** A desktop-graph agent node by its served node id (host canvas ids are
 *  rig-prefixed, so match the end of the React Flow wrapper's data-id). */
async function desktopAgent(container: HTMLElement, nodeId: string) {
  return waitFor(() => {
    const el = qa(container, ".react-flow__node").find((n) => {
      const id = n.getAttribute("data-id") ?? "";
      return id === nodeId || id.endsWith(nodeId);
    });
    expect(el).toBeTruthy();
    return el!;
  }, { timeout: 5000 });
}

async function seatDock(container: HTMLElement, seatKey?: string) {
  return waitFor(() => {
    const el = q(container, "[data-testid='graph-seat-dock']");
    expect(el).toBeTruthy();
    if (seatKey) expect(el!.getAttribute("data-seat-key")).toBe(seatKey);
    return el!;
  }, { timeout: 5000 });
}

/** core.lead served under a node id that is NOT its logical id, so any
 *  substitution of one for the other resolves the wrong seat (or none). */
function servedIdDiffersFromLogicalId() {
  // The detail read (by logical id) reports the served node id, which the
  // guarded admission requires to equal the selected graph node's.
  details["core.lead"] = { ...seatDetail("core.lead"), nodeId: "n-lead" };
  const g = graphs["abc-rig"] as Graph;
  graphs["abc-rig"] = {
    nodes: g.nodes.map((n) => ((n as { id: string }).id === "core.lead" ? seat("n-lead", "pod-core", { logicalId: "core.lead", canonicalSessionName: "core.lead@acme" }) : n)),
    edges: g.edges.map((e) => ({ ...(e as object), source: (e as { source: string }).source === "core.lead" ? "n-lead" : (e as { source: string }).source })),
  };
}

const inputFrames = (i: number) => sockets[i]!.sent.filter((f) => /"type":"(input|text|keys)"/.test(f));
const writes = () => mockFetch.mock.calls.filter(([url, init]) => /\/focus\b/.test(String(url)) || ((init as RequestInit | undefined)?.method ?? "GET") !== "GET");

describe("tablet Graph: an agent tap docks its live terminal beneath the graph panel", () => {
  const restores: Array<() => void> = [];
  afterEach(() => { while (restores.length) restores.pop()!(); });

  it.each([
    ["host", "/topology", "host-multi-rig-graph", 834, 1194],
    ["host", "/topology", "host-multi-rig-graph", 1194, 834],
    ["rig", "/topology/rig/abc-rig", "graph-view", 834, 1194],
    ["pod", "/topology/pod/abc-rig/core", "graph-view", 1180, 820],
  ] as const)("%s scope (%s, %s) at %ix%i: the exact seat's guarded terminal opens under the still-mounted graph", async (_scope, path, renderer, w, h) => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    servedIdDiffersFromLogicalId();
    const { container, router } = renderAt(path, w, h);
    const frame = await graphFrame(container, renderer);
    const graph = q(container, `[data-testid='${renderer}']`);
    fireEvent.click(await desktopAgent(container, "n-lead"));
    // Keyed by the served node id; the session/detail/link use the logical id.
    const dock = await seatDock(container, "local|abc-rig|n-lead");
    // Same route, same mounted graph (camera and expansion kept), no modal.
    expect(router.state.location.pathname).toBe(path);
    expect(q(container, `[data-testid='${renderer}']`)).toBe(graph);
    expect(q(document.body, "[data-testid='phone-graph-terminal']")).toBeNull();
    // Directly beneath the graph panel, ahead of Health/Recent.
    expect(frame.nextElementSibling).toBe(dock);
    const recent = q(container, "[data-testid='topology-recent-frame']");
    if (recent) expect(dock.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The guarded dock admits the exact pane; opening sends nothing,
    // focuses no cmux surface and moves no focus into the terminal.
    await waitFor(() => expect(within(dock).getByTestId("spatial-terminal-live").getAttribute("data-terminal-pane")).toBe("%1"));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url).toContain(encodeURIComponent("core.lead@acme"));
    expect(inputFrames(0)).toEqual([]);
    expect(writes()).toEqual([]);
    expect(dock.contains(document.activeElement)).toBe(false);
    expect(within(dock).getByTestId("graph-seat-dock-details").getAttribute("href")).toBe("/topology/seat/abc-rig/core.lead?sourceHost=local");
    expect(within(dock).getByRole("button", { name: "Close terminal" })).toBeTruthy();
  }, 20000);

  it("another agent switches the one dock; close frees the socket and leaves the graph; reopen attaches again", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    details["core.lead"] = seatDetail("core.lead");
    details["ops.watch"] = seatDetail("ops.watch");
    const { container } = renderAt("/topology/rig/abc-rig", 834, 1194);
    await graphFrame(container, "graph-view");
    const graph = q(container, "[data-testid='graph-view']");
    fireEvent.click(await desktopAgent(container, "core.lead"));
    await seatDock(container, "local|abc-rig|core.lead");
    await waitFor(() => expect(sockets).toHaveLength(1));

    fireEvent.click(await desktopAgent(container, "ops.watch"));
    const dock = await seatDock(container, "local|abc-rig|ops.watch");
    expect(qa(container, "[data-testid='graph-seat-dock']")).toHaveLength(1);
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0]!.closeCalled).toBe(true);
    expect(sockets[1]!.url).toContain(encodeURIComponent("ops.watch@acme"));

    fireEvent.click(within(dock).getByTestId("graph-seat-dock-close"));
    await waitFor(() => expect(q(container, "[data-testid='graph-seat-dock']")).toBeNull());
    expect(sockets[1]!.closeCalled).toBe(true);
    expect(q(container, "[data-testid='graph-view']")).toBe(graph);
    // Closing stops nothing: no lifecycle or focus request was made.
    expect(writes()).toEqual([]);

    fireEvent.click(await desktopAgent(container, "core.lead"));
    await seatDock(container, "local|abc-rig|core.lead");
    await waitFor(() => expect(sockets).toHaveLength(3));
    expect(sockets[2]!.url).toContain(encodeURIComponent("core.lead@acme"));
  }, 20000);

  it("re-tapping the open agent reveals its dock again with the same terminal and socket", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    details["core.lead"] = seatDetail("core.lead");
    const revealed: Array<{ el: HTMLElement; options: ScrollIntoViewOptions | boolean | undefined }> = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: ScrollIntoViewOptions | boolean) { revealed.push({ el: this, options }); };
    restores.push(() => { HTMLElement.prototype.scrollIntoView = original; });
    const { container } = renderAt("/topology/rig/abc-rig", 834, 1194);
    await graphFrame(container, "graph-view");
    fireEvent.click(await desktopAgent(container, "core.lead"));
    const dock = await seatDock(container, "local|abc-rig|core.lead");
    await waitFor(() => expect(within(dock).getByTestId("spatial-terminal-live")).toBeTruthy());
    await waitFor(() => expect(sockets).toHaveLength(1));
    const live = within(dock).getByTestId("spatial-terminal-live");
    const dockReveals = () => revealed.filter((r) => r.el === dock);
    const reveals = () => dockReveals().length;
    expect(reveals()).toBe(1);
    fireEvent.click(await desktopAgent(container, "core.lead"));
    await waitFor(() => expect(reveals()).toBe(2));
    expect(q(container, "[data-testid='graph-seat-dock']")).toBe(dock);
    expect(within(dock).getByTestId("spatial-terminal-live")).toBe(live);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closeCalled).toBe(false);
    expect(dock.contains(document.activeElement)).toBe(false);
    // Every reveal aligns the dock's top (not "nearest"): the terminal that
    // mounts taller after the read must not decide how much is revealed.
    for (const r of dockReveals()) expect(r.options).toMatchObject({ block: "start" });
  }, 20000);

  it("a pod page detaches a seat the refreshed graph moved to another pod; a rig page keeps it", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    servedIdDiffersFromLogicalId();
    const moved = () => {
      const g = graphs["abc-rig"] as Graph;
      return { ...g, nodes: g.nodes.map((n) => ((n as { id: string }).id === "n-lead" ? { ...(n as object), parentId: "pod-ops" } : n)) };
    };
    const before = graphs["abc-rig"];
    for (const [path, staysAttached] of [["/topology/pod/abc-rig/core", false], ["/topology/rig/abc-rig", true]] as const) {
      graphs["abc-rig"] = before;
      sockets.length = 0;
      const { container, queryClient, unmount } = renderAt(path, 834, 1194);
      await graphFrame(container, "graph-view");
      fireEvent.click(await desktopAgent(container, "n-lead"));
      const dock = await seatDock(container, "local|abc-rig|n-lead");
      await waitFor(() => expect(within(dock).getByTestId("spatial-terminal-live")).toBeTruthy());
      await waitFor(() => expect(sockets).toHaveLength(1));
      graphs["abc-rig"] = moved();
      await act(async () => { await queryClient.invalidateQueries({ queryKey: ["rig", "abc-rig", "graph"] }); });
      if (staysAttached) {
        // Same agent, same rig: still resolves; its terminal stays attached.
        await waitFor(() => expect(within(dock).getByTestId("spatial-terminal-live")).toBeTruthy());
        expect(q(container, "[data-testid='graph-seat-dock-unresolved']")).toBeNull();
        expect(sockets[0]!.closeCalled).toBe(false);
      } else {
        await waitFor(() => expect(q(container, "[data-testid='graph-seat-dock-unresolved']")?.textContent).toContain("pod core"), { timeout: 5000 });
        expect(q(container, "[data-testid='spatial-terminal-dock']")).toBeNull();
        expect(sockets[0]!.closeCalled).toBe(true);
      }
      unmount();
    }
  }, 30000);

  it("a stopped seat or failed detail read is refused; a seat dropped from the refreshed graph detaches", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    details["core.worker"] = seatDetail("core.worker", null);
    details["ops.watch"] = seatDetail("ops.watch");
    const { container, queryClient } = renderAt("/topology/rig/abc-rig", 834, 1194);
    await graphFrame(container, "graph-view");
    fireEvent.click(await desktopAgent(container, "core.worker"));
    let dock = await seatDock(container, "local|abc-rig|core.worker");
    await waitFor(() => expect(within(dock).getByTestId("spatial-terminal-state").getAttribute("data-state")).toBe("no-pane"));
    fireEvent.click(await desktopAgent(container, "core.lead")); // no detail served → 503
    dock = await seatDock(container, "local|abc-rig|core.lead");
    await waitFor(() => expect(within(dock).getByTestId("spatial-terminal-state").getAttribute("data-state")).toBe("unreadable"));
    expect(sockets).toHaveLength(0);

    fireEvent.click(await desktopAgent(container, "ops.watch"));
    await seatDock(container, "local|abc-rig|ops.watch");
    await waitFor(() => expect(sockets).toHaveLength(1));
    // The served graph no longer has ops.watch: the dock detaches, never substitutes.
    const g = graphs["abc-rig"] as Graph;
    graphs["abc-rig"] = { nodes: g.nodes.filter((n) => (n as { id: string }).id !== "ops.watch"), edges: [] };
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["rig", "abc-rig", "graph"] }); });
    await waitFor(() => expect(q(container, "[data-testid='graph-seat-dock-unresolved']")).toBeTruthy(), { timeout: 5000 });
    expect(q(container, "[data-testid='spatial-terminal-dock']")).toBeNull();
    expect(sockets[0]!.closeCalled).toBe(true);
  }, 25000);

  it("host, scope, view and rig changes drop the dock (no stale or cross-host terminal)", async () => {
    restores.push(stubInputs(TOUCH_ONLY).restore);
    details["core.lead"] = seatDetail("core.lead");
    summary = [{ id: "abc-rig", name: "acme", nodeCount: 3 }, { id: "other-rig", name: "other", nodeCount: 0 }];
    graphs["other-rig"] = { nodes: [], edges: [] };
    const { container, router, queryClient } = renderAt("/topology/rig/abc-rig", 834, 1194);
    await graphFrame(container, "graph-view");
    const open = async () => {
      fireEvent.click(await desktopAgent(container, "core.lead"));
      await seatDock(container, "local|abc-rig|core.lead");
      await waitFor(() => expect(sockets.at(-1)!.closeCalled).toBe(false));
    };
    const dropped = async () => {
      await waitFor(() => expect(q(container, "[data-testid='graph-seat-dock']")).toBeNull());
      expect(sockets.at(-1)!.closeCalled).toBe(true);
    };
    await open();
    // A different selected host: the dock is the old host's, so it goes.
    act(() => queryClient.setQueryData(["hosts"], { ownName: "localhost", selected: "vps-a", hosts: [] }));
    await dropped();
    act(() => queryClient.setQueryData(["hosts"], { ownName: "localhost", selected: "local", hosts: [] }));
    await graphFrame(container, "graph-view");
    // Switching back to the same host does not resurrect it.
    expect(q(container, "[data-testid='graph-seat-dock']")).toBeNull();

    await open();
    fireEvent.click(q(container, "[data-testid='topology-rig-tab-table']")!);
    await dropped();
    fireEvent.click(q(container, "[data-testid='topology-rig-tab-graph']")!);
    await graphFrame(container, "graph-view");
    expect(q(container, "[data-testid='graph-seat-dock']")).toBeNull();

    await open();
    act(() => { void router.navigate({ to: "/topology/rig/$rigId", params: { rigId: "other-rig" } }); });
    await dropped();
    act(() => { void router.navigate({ to: "/topology/rig/$rigId", params: { rigId: "abc-rig" } }); });
    await graphFrame(container, "graph-view");
    expect(q(container, "[data-testid='graph-seat-dock']")).toBeNull();

    await open();
    act(() => { void router.navigate({ to: "/topology/pod/$rigId/$podName", params: { rigId: "abc-rig", podName: "core" } }); });
    await dropped();
  }, 30000);

  it("a pointer change and a keyboard-height viewport keep the open dock and its socket", async () => {
    const inputs = stubInputs(TOUCH_ONLY);
    restores.push(inputs.restore);
    details["core.lead"] = seatDetail("core.lead");
    const { container } = renderAt("/topology", 1180, 820);
    await graphFrame(container, "host-multi-rig-graph");
    fireEvent.click(await desktopAgent(container, "core.lead"));
    const dock = await seatDock(container, "local|abc-rig|core.lead");
    await waitFor(() => expect(sockets).toHaveLength(1));
    inputs.set(TOUCH_WITH_POINTER);
    act(() => setViewportHeight(400));
    expect(q(container, "[data-testid='graph-seat-dock']")).toBe(dock);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closeCalled).toBe(false);
  }, 20000);

  it("a mouse-only desktop still navigates to the seat page; a phone keeps its modal terminal", async () => {
    restores.push(stubInputs(MOUSE_ONLY).restore);
    details["core.lead"] = seatDetail("core.lead");
    const desktop = renderAt("/topology/rig/abc-rig", 1440, 900);
    await graphFrame(desktop.container, "graph-view");
    fireEvent.click(await desktopAgent(desktop.container, "core.lead"));
    await waitFor(() => expect(desktop.router.state.location.pathname).toBe("/topology/seat/abc-rig/core.lead"));
    expect(q(desktop.container, "[data-testid='graph-seat-dock']")).toBeNull();
    desktop.unmount();

    restores.push(stubInputs(TOUCH_ONLY).restore);
    const phone = renderAt("/topology/rig/abc-rig", 430, 932);
    tapNode(await seatChip(phone.container, "core.lead"));
    expect((await terminalOverlay()).getAttribute("data-agent-key")).toContain("/agent/core.lead");
    expect(q(phone.container, "[data-testid='graph-seat-dock']")).toBeNull();
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
