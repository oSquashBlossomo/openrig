// Topology navigation round trip — actual scope pages, actual seat detail,
// real TanStack memory router with the PRODUCTION search parse/stringify
// adapters (a router without them can pass while the App stays broken), and
// actual query hooks/transports over a fictional fetch fixture. Only the GPU
// renderer is replaced by a stub that honours the same controller contract
// (snapshot/restore/onCameraSettle/initialCamera).
//
// Covers root's reported journey (Topology → 3D → search → select → Open
// seat → Back lost 3D/query/selection), rapid input before a drill, stale
// queued search writes, same-route Back/Forward, source assertion and
// mismatch (no automatic host writes), cold/failed host reads, invalid links,
// exact duplicate/numeric/reserved identities, and per-visit camera/scroll
// isolation. jsdom proves DOM/router/request behavior, not pixels or WebGL.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { parseTopologySearch, stringifyTopologySearch } from "../src/lib/topology-search.js";
import { HostScopePage, PodScopePage, RigScopePage, SeatScopePage } from "../src/components/topology/ScopePages.js";
import { HostIndicator } from "../src/components/HostIndicator.js";
import { TOPOLOGY_VISIT_STATE_KEY, navigateTopology, topologyTarget } from "../src/components/topology/topology-navigation.js";
import { spatialVisitStore } from "../src/components/topology/spatial/spatial-visit-store.js";
import { SPATIAL_SEARCH_WRITE_MS } from "../src/components/topology/spatial/SpatialTopologyView.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

// --- Renderer stub with the real controller contract ------------------------
type Pose = { position: [number, number, number]; target: [number, number, number]; userMoved: boolean; bounds: { center: [number, number, number]; radius: number } };
const FITTED: Pose = { position: [40, 50, 60], target: [0, 0, 0], userMoved: false, bounds: { center: [0, 0, 0], radius: 30 } };
const MOVED: Pose = { position: [5, 80, 12], target: [3, 0, -2], userMoved: true, bounds: { center: [0, 0, 0], radius: 30 } };

const rendererLog = vi.hoisted(() => ({
  mounts: [] as Array<unknown>,
  restores: [] as Array<unknown>,
  focus: [] as string[],
  /** Live pose readings of the mounted stub (what the controller holds now). */
  poses: [] as Array<unknown>,
}));

vi.mock("../src/components/topology/spatial/SpatialRenderer.js", async () => {
  const React = await import("react");
  type StubProps = {
    model: { agentsByKey: Map<string, unknown> };
    selectedKey: string | null;
    controllerRef: { current: unknown };
    onSelect: (key: string | null) => void;
    onReady?: () => void;
    initialCamera?: Pose | null;
    onCameraSettle?: (pose: Pose) => void;
  };
  function StubRenderer(props: StubProps) {
    const pose = React.useRef<Pose>(props.initialCamera?.userMoved ? props.initialCamera : FITTED);
    const propsRef = React.useRef(props);
    propsRef.current = props;
    React.useEffect(() => {
      rendererLog.mounts.push(props.initialCamera ?? null);
      props.controllerRef.current = {
        fit() {}, reset() { pose.current = FITTED; }, preset() {}, zoom() {}, orbit() {},
        focus(key: string) { rendererLog.focus.push(key); },
        snapshot: () => pose.current,
        restore: (s: Pose) => { rendererLog.restores.push(s); pose.current = s; return true; },
      };
      props.onReady?.();
      return () => {
        propsRef.current.onCameraSettle?.(pose.current);
        props.controllerRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement(
      "div",
      { "data-testid": "stub-renderer", "data-selected": props.selectedKey ?? "" },
      React.createElement("button", {
        type: "button",
        "data-testid": "stub-read-pose",
        onClick: () => rendererLog.poses.push(pose.current),
      }),
      React.createElement("button", {
        type: "button",
        "data-testid": "stub-move-camera",
        "data-pose": "",
        onClick: () => { pose.current = MOVED; props.onCameraSettle?.(MOVED); },
      }),
    );
  }
  return { default: StubRenderer };
});

// --- Fictional daemon fixture ------------------------------------------------
type HostsPayload = { ownName: string; selected: string; hosts: Array<Record<string, unknown>> };
const HOST_A = { id: "A", transport: "http", url: "http://a.invalid:7433", selected: false, status: "reachable" };

function node(id: string, logicalId: string, pod = "pod-desk") {
  return { id, type: "rigNode", parentId: pod, data: { logicalId, status: "running", startupStatus: "ready", runtime: "claude-code" } };
}
const desk = { id: "pod-desk", type: "podGroup", data: { podId: "desk", podNamespace: "desk" } };
const lead = { id: "pod-lead", type: "podGroup", data: { podId: "lead", podNamespace: "lead" } };

function nodeDetail(rigId: string, logicalId: string) {
  return {
    rigId, logicalId, rigName: `rig ${rigId}`, podId: null, canonicalSessionName: `${logicalId}@${rigId}`, nodeKind: "agent", runtime: null,
    sessionStatus: null, startupStatus: null, restoreOutcome: "unknown", tmuxAttachCommand: null, resumeCommand: null,
    recoveryGuidance: null, latestError: null, model: null, agentRef: null, profile: null, resolvedSpecName: null,
    resolvedSpecVersion: null, cwd: null, startupFiles: [], startupActions: [], recentEvents: [],
    infrastructureStartupCommand: null, peers: [], edges: { outgoing: [], incoming: [] },
    transcript: { enabled: false, path: null, tailCommand: null },
    compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
  };
}

interface Fixture {
  hosts: HostsPayload | null;
  hostsStatus: number;
  rigs: Record<string, Array<{ id: string; name: string; nodeCount: number }>>;
  graphs: Record<string, unknown>;
}
let fx: Fixture;
const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> | Response {
  if (init?.method && init.method !== "GET") return json({ ok: true });
  const url = new URL(String(input), "http://fixture.invalid");
  const host = url.searchParams.get("host") ?? "local";
  if (url.pathname === "/api/hosts") return fx.hosts && fx.hostsStatus === 200 ? json(fx.hosts) : json({ error: "unavailable" }, fx.hostsStatus || 503);
  if (url.pathname === "/api/queue/recent-transitions") return json([]);
  if (url.pathname === "/api/rigs/summary") return json(fx.rigs[host] ?? []);
  const graph = url.pathname.match(/^\/api\/rigs\/([^/]+)\/graph$/);
  if (graph) {
    const key = `${host}|${decodeURIComponent(graph[1]!)}`;
    return key in fx.graphs ? json(fx.graphs[key]) : json({ error: "missing" }, 404);
  }
  const detail = url.pathname.match(/^\/api\/rigs\/([^/]+)\/nodes\/([^/]+)$/);
  if (detail) return json(nodeDetail(decodeURIComponent(detail[1]!), decodeURIComponent(detail[2]!)));
  return json({ error: "not in fixture" }, 404);
}

const requests = () => fetchMock.mock.calls.map(([input, init]) => ({ url: String(input), method: (init as RequestInit | undefined)?.method ?? "GET" }));
const posts = () => requests().filter((r) => r.method !== "GET");
const targetReads = () => requests().filter((r) => r.url.startsWith("/api/rigs"));

let OriginalEventSource: typeof EventSource | undefined;
beforeEach(() => {
  fx = {
    hosts: { ownName: "fixture", selected: "local", hosts: [HOST_A] },
    hostsStatus: 200,
    rigs: { local: [{ id: "rig_bravo", name: "bravo", nodeCount: 3 }] },
    graphs: {
      "local|rig_bravo": {
        nodes: [desk, lead, node("node_editor", "desk.editor"), node("node_writer", "desk.writer"), node("node_lead", "lead.coordinator", "pod-lead")],
        edges: [{ id: "e1", source: "node_lead", target: "node_editor", label: "delegates_to" }],
      },
    },
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(serve);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  rendererLog.mounts.length = 0;
  rendererLog.poses.length = 0;
  rendererLog.restores.length = 0;
  rendererLog.focus.length = 0;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  // jsdom has no layout: give scroll containers real extents so restoration
  // is clamped against something (and assert DOM scrollTop, not classes).
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 4000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 500 });
});

afterEach(() => {
  cleanup();
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  vi.useRealTimers();
});

function renderApp(initial: string, opts: { state?: Record<string, unknown>; client?: QueryClient; browser?: boolean } = {}) {
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <HostIndicator />
        <main data-testid="content-area" style={{ overflow: "auto" }}>
          <Outlet />
        </main>
      </QueryClientProvider>
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/topology", component: HostScopePage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/topology/rig/$rigId", component: RigScopePage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/topology/pod/$rigId/$podName", component: PodScopePage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/topology/seat/$rigId/$logicalId", component: SeatScopePage }),
  ];
  if (opts.browser) window.history.replaceState(null, "", initial);
  const history = opts.browser ? createBrowserHistory() : createMemoryHistory({ initialEntries: [initial] });
  if (opts.state) history.replace(initial, { ...history.location.state, ...opts.state });
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history,
    parseSearch: parseTopologySearch,
    stringifySearch: stringifyTopologySearch,
  });
  const view = render(<RouterProvider router={router} />);
  return { ...view, router, client };
}

const search = (router: ReturnType<typeof renderApp>["router"]) => router.state.location.search as Record<string, unknown>;
const tab = (prefix: string, id: string) => screen.getByTestId(`${prefix}-tab-${id}`);
const indexRows = () => within(screen.getByTestId("spatial-seat-index-compact")).getAllByTestId("spatial-agent-row");
const rowNamed = (name: string) => indexRows().find((r) => r.textContent?.includes(name))!;

async function spatialReady() {
  // The first mount transforms the lazy spatial chunk; allow for a loaded host.
  await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
  await waitFor(() => expect((screen.getByTestId("spatial-camera-fit") as HTMLButtonElement).disabled).toBe(false));
}

describe("reported journey: 3D → search → select → Open seat → Back", () => {
  it("returns to the same source, 3D view, query, exact selection, camera pose and index scroll; Forward revisits the seat", async () => {
    const { router } = renderApp("/topology");
    // Legacy entry binds once to the successfully read selected host.
    await waitFor(() => expect(search(router).sourceHost).toBe("local"));
    await waitFor(() => expect(tab("topology-host", "graph").getAttribute("aria-selected")).toBe("true"));

    fireEvent.click(tab("topology-host", "spatial"));
    await waitFor(() => expect(search(router).view).toBe("spatial"));
    expect(router.state.location.pathname).toBe("/topology");
    await spatialReady();

    fireEvent.change(screen.getByTestId("spatial-search"), { target: { value: "editor" } });
    fireEvent.keyDown(screen.getByTestId("spatial-search"), { key: "Enter" });
    await waitFor(() => expect(search(router)).toMatchObject({ spatialQuery: "editor", selectedRig: "rig_bravo", selectedNode: "node_editor" }));
    expect(await screen.findByTestId("spatial-inspector-name")).toHaveProperty("textContent", "editor");
    expect(rendererLog.focus).toEqual([expect.stringMatching(/\/agent\/node_editor$/)]);

    fireEvent.click(screen.getByTestId("stub-move-camera"));
    const indexRegion = screen.getByTestId("spatial-index-region");
    indexRegion.scrollTop = 320;
    fireEvent.scroll(indexRegion);
    const visit = (router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY];
    expect(typeof visit).toBe("string");
    const indexBefore = router.history.location.state.__TSR_index;

    // Keyboard activation: focus is on Open seat when the entry is left.
    screen.getByTestId("spatial-open-seat").focus();
    fireEvent.click(screen.getByTestId("spatial-open-seat"));
    await screen.findByTestId("live-node-details");
    await waitFor(() => expect(screen.getByText("desk.editor@rig_bravo")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/topology/seat/rig_bravo/desk.editor");
    expect(search(router)).toEqual({ sourceHost: "local" });
    expect(router.history.location.state.__TSR_index).toBe(indexBefore + 1);
    expect(requests().some((r) => r.url === "/api/rigs/rig_bravo/nodes/desk.editor")).toBe(true);

    rendererLog.mounts.length = 0;
    act(() => router.history.back());
    await spatialReady();
    expect(router.state.location.pathname).toBe("/topology");
    expect(search(router)).toMatchObject({ sourceHost: "local", view: "spatial", spatialQuery: "editor", selectedRig: "rig_bravo", selectedNode: "node_editor" });
    expect(tab("topology-host", "spatial").getAttribute("aria-selected")).toBe("true");
    expect((screen.getByTestId("spatial-search") as HTMLInputElement).value).toBe("editor");
    expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("editor");
    expect(rowNamed("editor").getAttribute("aria-pressed")).toBe("true");
    expect((router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY]).toBe(visit);
    // Useful pose and offset return (restored once, from this visit only).
    expect(rendererLog.mounts).toEqual([MOVED]);
    await waitFor(() => expect(screen.getByTestId("spatial-index-region").scrollTop).toBe(320));
    // Focus returns to the control that drilled, without stealing it later.
    expect(document.activeElement).toBe(screen.getByTestId("spatial-open-seat"));

    act(() => router.history.forward());
    await waitFor(() => expect(screen.getByText("desk.editor@rig_bravo")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/topology/seat/rig_bravo/desk.editor");
    // Navigation, reload and Back never wrote the global host selection.
    expect(posts()).toEqual([]);
  });

  it("last typed characters immediately before Open seat survive Back; history grows by one drill, not by keystrokes", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial&selectedRig=rig_bravo&selectedNode=node_editor");
    await spatialReady();
    const start = router.history.location.state.__TSR_index;
    const input = screen.getByTestId("spatial-search");
    for (const value of ["e", "ed", "edi", "edit"]) fireEvent.change(input, { target: { value } });
    // No trailing write has fired yet: the drill must commit "edit" first.
    expect(search(router).spatialQuery).toBeUndefined();
    fireEvent.click(screen.getByTestId("spatial-open-seat"));
    await screen.findByTestId("live-node-details");
    expect(router.history.location.state.__TSR_index).toBe(start + 1);
    await new Promise((r) => setTimeout(r, SPATIAL_SEARCH_WRITE_MS * 2));
    expect(router.state.location.pathname).toBe("/topology/seat/rig_bravo/desk.editor");
    act(() => router.history.back());
    await spatialReady();
    expect(search(router)).toMatchObject({ spatialQuery: "edit", selectedNode: "node_editor" });
    expect((screen.getByTestId("spatial-search") as HTMLInputElement).value).toBe("edit");
    expect(router.history.location.state.__TSR_index).toBe(start);
  });

  it("browser history: the pre-drill commit is flushed, not coalesced into the drill's pushState", async () => {
    // TanStack's browser history batches a replace and a push queued in one
    // tick into ONE pushState; without an explicit flush the source entry
    // would keep its old query. Real window.history (jsdom), real popstate.
    const { router } = renderApp("/topology?sourceHost=local&view=spatial&selectedRig=rig_bravo&selectedNode=node_editor", { browser: true });
    await spatialReady();
    fireEvent.change(screen.getByTestId("spatial-search"), { target: { value: "edit" } });
    fireEvent.click(screen.getByTestId("spatial-open-seat"));
    await screen.findByTestId("live-node-details");
    await waitFor(() => expect(window.location.pathname).toBe("/topology/seat/rig_bravo/desk.editor"));
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/topology"));
    expect(new URLSearchParams(window.location.search).get("spatialQuery")).toBe("edit");
    await spatialReady();
    expect((screen.getByTestId("spatial-search") as HTMLInputElement).value).toBe("edit");
    expect(search(router)).toMatchObject({ spatialQuery: "edit", selectedNode: "node_editor" });
    router.history.destroy();
  });

  it("a drill from a producer that does not know its scope still commits the pending draft to the entry it leaves", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial");
    await spatialReady();
    const { TopologyLink: Link, topologyTarget } = await import("../src/components/topology/topology-navigation.js");
    const { render: renderExtra } = await import("@testing-library/react");
    fireEvent.change(screen.getByTestId("spatial-search"), { target: { value: "wri" } });
    // An Explorer-style link outside the 3D view (from = null).
    const target = topologyTarget({ scope: { kind: "rig", rigId: "rig_bravo" }, sourceHost: "local" })!;
    const { RouterContextProvider } = await import("@tanstack/react-router");
    renderExtra(<RouterContextProvider router={router}><Link target={target} from={null} data-testid="outside-link">rig</Link></RouterContextProvider>);
    fireEvent.click(screen.getByTestId("outside-link"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/topology/rig/rig_bravo"));
    act(() => router.history.back());
    await waitFor(() => expect(search(router).spatialQuery).toBe("wri"));
  });

  it("a queued search write is bound to its entry: Back cancels it and it never overwrites either entry", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial&spatialQuery=one");
    await spatialReady();
    await act(() => router.navigate({ to: "/topology", search: { sourceHost: "local", view: "spatial", spatialQuery: "two" } } as never));
    await waitFor(() => expect((screen.getByTestId("spatial-search") as HTMLInputElement).value).toBe("two"));
    const input = screen.getByTestId("spatial-search");
    fireEvent.change(input, { target: { value: "twox" } });
    act(() => router.history.back());
    await waitFor(() => expect((screen.getByTestId("spatial-search") as HTMLInputElement).value).toBe("one"));
    await new Promise((r) => setTimeout(r, SPATIAL_SEARCH_WRITE_MS * 3));
    expect(search(router).spatialQuery).toBe("one");
    act(() => router.history.forward());
    await waitFor(() => expect(search(router).spatialQuery).toBe("two"));
  });

  it("a trailing search write replaces the current entry and keeps unrelated search, hash and visit state", async () => {
    // Unrelated keys keep the router's existing default serialization.
    const { router } = renderApp("/topology?sourceHost=local&view=spatial&keep=yes#anchor");
    await spatialReady();
    await waitFor(() => expect((router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY]).toBeTruthy());
    const visit = (router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY];
    const index = router.history.location.state.__TSR_index;
    fireEvent.change(screen.getByTestId("spatial-search"), { target: { value: "writer" } });
    await waitFor(() => expect(search(router).spatialQuery).toBe("writer"));
    expect(router.history.location.state.__TSR_index).toBe(index);
    expect(router.state.location.hash).toBe("anchor");
    expect(router.state.location.searchStr).toContain("keep=yes");
    expect((router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY]).toBe(visit);
  });
});

describe("same-route Back/Forward drives the controls without a remount", () => {
  it("view, Scene/List, query and selection follow history on one pathname", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=table");
    await waitFor(() => expect(tab("topology-host", "table").getAttribute("aria-selected")).toBe("true"));
    await act(() => router.navigate({ to: "/topology", search: { sourceHost: "local", view: "spatial", spatialQuery: "desk" } } as never));
    await spatialReady();
    const inputBefore = screen.getByTestId("spatial-search");
    expect((inputBefore as HTMLInputElement).value).toBe("desk");
    await act(() => router.navigate({ to: "/topology", search: { sourceHost: "local", view: "spatial", spatialMode: "list", spatialQuery: "writer", selectedRig: "rig_bravo", selectedNode: "node_writer" } } as never));
    await screen.findByTestId("spatial-seat-index-table");
    expect(screen.getByTestId("spatial-search")).toBe(inputBefore);
    expect((inputBefore as HTMLInputElement).value).toBe("writer");
    expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("writer");

    act(() => router.history.back());
    await screen.findByTestId("stub-renderer");
    expect(screen.getByTestId("spatial-search")).toBe(inputBefore);
    expect((inputBefore as HTMLInputElement).value).toBe("desk");
    expect(screen.getByTestId("spatial-inspector-empty")).toBeTruthy();
    act(() => router.history.back());
    await waitFor(() => expect(tab("topology-host", "table").getAttribute("aria-selected")).toBe("true"));
    act(() => router.history.forward());
    act(() => router.history.forward());
    await screen.findByTestId("spatial-seat-index-table");
    expect(screen.getByTestId("spatial-mode-list").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("writer");
  });

  it("tab keyboard movement replaces the entry and names the active panel", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=table");
    await waitFor(() => expect(tab("topology-host", "table").getAttribute("aria-selected")).toBe("true"));
    const index = router.history.location.state.__TSR_index;
    fireEvent.keyDown(tab("topology-host", "table"), { key: "ArrowRight" });
    await waitFor(() => expect(search(router).view).toBe("terminal"));
    expect(document.activeElement).toBe(tab("topology-host", "terminal"));
    expect(tab("topology-host", "terminal").getAttribute("tabindex")).toBe("0");
    expect(tab("topology-host", "table").getAttribute("tabindex")).toBe("-1");
    const panel = document.getElementById("topology-host-panel")!;
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("topology-host-tab-terminal");
    fireEvent.keyDown(tab("topology-host", "terminal"), { key: "Home" });
    await waitFor(() => expect(search(router).view).toBeUndefined());
    expect(router.history.location.state.__TSR_index).toBe(index);
  });
});

describe("source assertion: no automatic host writes", () => {
  it("an A-link while B is selected reads nothing for B until an explicit selection is confirmed by readback", async () => {
    fx.hosts = { ownName: "fixture", selected: "local", hosts: [HOST_A] };
    fx.rigs.A = [{ id: "rig_bravo", name: "bravo-on-A", nodeCount: 1 }];
    const { router, client } = renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=A");
    expect((await screen.findByTestId("topology-source-mismatch")).textContent).toBe("This link is for host A; the selected host is local.");
    await new Promise((r) => setTimeout(r, 30));
    expect(targetReads()).toEqual([]);
    expect(posts()).toEqual([]);
    expect(screen.queryByTestId("live-node-details")).toBeNull();

    fireEvent.click(screen.getByTestId("topology-source-select"));
    await waitFor(() => expect(posts()).toEqual([{ url: "/api/config/host.selected", method: "POST" }]));
    // The daemon has not confirmed A yet: still gated, still no target read.
    await screen.findByText(/Waiting for the daemon to confirm A/);
    expect(targetReads()).toEqual([]);
    fx.hosts = { ownName: "fixture", selected: "A", hosts: [{ ...HOST_A, selected: true }] };
    // The next host read (the 5s poll; triggered here) confirms A.
    await act(async () => { await client.refetchQueries({ queryKey: ["hosts"] }); });
    await waitFor(() => expect(screen.getByText("desk.editor@rig_bravo")).toBeTruthy());
    expect(targetReads().map((r) => r.url)).toContain("/api/rigs/rig_bravo/nodes/desk.editor?host=A");
    expect(targetReads().some((r) => r.url === "/api/rigs/rig_bravo/nodes/desk.editor")).toBe(false);
    expect(search(router)).toEqual({ sourceHost: "A" });
    expect(posts()).toHaveLength(1);
  }, 15000);

  it("a removed alias stays inspectable as unavailable; View selected host goes to B's host scope with no write", async () => {
    const { router } = renderApp("/topology/rig/rig_bravo?sourceHost=gone&view=spatial&selectedRig=rig_bravo&selectedNode=node_editor");
    expect((await screen.findByTestId("topology-source-mismatch")).textContent).toContain("host gone");
    expect(screen.getByTestId("topology-source-gate").textContent).toContain("gone is not registered");
    expect(screen.queryByTestId("topology-source-select")).toBeNull();
    fireEvent.click(screen.getByTestId("topology-source-view-selected"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/topology"));
    expect(search(router)).toEqual({ sourceHost: "local" });
    expect(posts()).toEqual([]);
  });

  it("an external host switch gates the open body instead of replaying the same IDs on the new host", async () => {
    const { client } = renderApp("/topology?sourceHost=local&view=spatial&selectedRig=rig_bravo&selectedNode=node_editor");
    await spatialReady();
    const before = targetReads().length;
    act(() => client.setQueryData(["hosts"], { ownName: "fixture", selected: "A", hosts: [{ ...HOST_A, selected: true }] }));
    expect((await screen.findByTestId("topology-source-mismatch")).textContent).toBe("This link is for host local; the selected host is A.");
    expect(screen.queryByTestId("spatial-topology-view")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(targetReads().slice(before).filter((r) => r.url.includes("host=A"))).toEqual([]);
    expect(posts()).toEqual([]);
  });
});

describe("host read state gates target reads", () => {
  it("cold 503: nothing is presumed local — indicator unknown, body gated, zero target reads", async () => {
    fx.hostsStatus = 503;
    renderApp("/topology/seat/rig_bravo/desk.editor");
    const gate = await screen.findByTestId("topology-source-gate");
    await waitFor(() => expect(gate.getAttribute("data-state")).toBe("unavailable"));
    expect(gate.textContent).toContain("No host selection has been confirmed yet.");
    expect(screen.getByTestId("host-indicator").getAttribute("data-state")).toBe("unknown");
    expect(screen.getByTestId("host-indicator").textContent?.toLowerCase()).not.toContain("local");
    expect(targetReads()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("a failed refresh with a cached host unmounts the body and labels the cached selection stale", async () => {
    const { client } = renderApp("/topology?sourceHost=local&view=spatial");
    await spatialReady();
    fx.hostsStatus = 503;
    await act(async () => { await client.refetchQueries({ queryKey: ["hosts"] }); });
    const gate = await screen.findByTestId("topology-source-gate");
    expect(gate.getAttribute("data-state")).toBe("unavailable");
    expect(gate.textContent).toContain("Last confirmed selection: local (cached — not current proof).");
    expect(screen.queryByTestId("spatial-topology-view")).toBeNull();
    expect(screen.getByTestId("host-indicator").getAttribute("data-state")).toBe("stale");
    fx.hostsStatus = 200;
    fireEvent.click(screen.getByTestId("topology-source-retry"));
    await spatialReady();
    expect(posts()).toEqual([]);
  });
});

describe("invalid and partial links", () => {
  it("a malformed path escape is no active rig (never a shell-level crash)", async () => {
    const { parseActiveRigId } = await import("../src/components/topology/topology-overlay-context.js");
    expect(parseActiveRigId("/topology/rig/%E0%A4%A")).toBeNull();
    expect(parseActiveRigId("/topology/seat/a%2Fb/x")).toBe("a/b");
  });

  it("a lone-surrogate path segment never matches a topology route: no body, no target read", async () => {
    renderApp("/topology/seat/rig_bravo/%ED%A0%80?sourceHost=local");
    await screen.findByTestId("host-indicator");
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("seat-scope-page")).toBeNull();
    expect(targetReads()).toEqual([]);
  });

  it.each([
    "/topology?sourceHost=local&sourceHost=A",
    "/topology?sourceHost=%ED%A0%80",
    "/topology/rig/%2E%2E?sourceHost=local",
  ])("%s is rejected without mounting any body or reading any target", async (href) => {
    renderApp(href);
    const gate = await screen.findByTestId("topology-source-gate");
    expect(gate.getAttribute("data-state")).toBe("invalid");
    await new Promise((r) => setTimeout(r, 30));
    expect(targetReads()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("invalid optional fields render the defaults with a notice; a wrong-rig or partial pair selects nothing", async () => {
    renderApp("/topology/rig/rig_bravo?sourceHost=local&view=bogus&selectedRig=rig_other&selectedNode=node_editor");
    const notices = await screen.findByTestId("topology-location-notices");
    expect(notices.textContent).toContain("the requested view is not valid — showing the default view.");
    expect(notices.textContent).toContain("the selected seat belongs to a different rig");
    expect(tab("topology-rig", "graph").getAttribute("aria-selected")).toBe("true");
    cleanup();
    const { router } = renderApp(`/topology?sourceHost=local&view=spatial&selectedRig=rig_bravo&spatialQuery=${"q".repeat(257)}`);
    await spatialReady();
    const second = screen.getByTestId("topology-location-notices").textContent!;
    expect(second).toContain("the selected seat is not valid");
    expect(second).toContain("the search text is too long");
    expect(screen.getByTestId("spatial-inspector-empty")).toBeTruthy();
    expect((screen.getByTestId("spatial-search") as HTMLInputElement).value).toBe("");
    expect(search(router).selectedRig).toBe("rig_bravo");
  });
});

describe("exact opaque identities through drill and Back", () => {
  it.each(["1.0", "9007199254740993", "a%2Fb", "x/y?#", " sp ", "日本🙂", "true", "null", "007"])(
    "graph/rig/logical identity %j round-trips exactly (href once-encoded, request exact, no coercion)",
    async (value) => {
      fx.rigs.local = [{ id: value, name: "odd", nodeCount: 1 }, { id: "1", name: "one", nodeCount: 1 }];
      fx.graphs[`local|${value}`] = { nodes: [desk, node(value, value)], edges: [] };
      fx.graphs["local|1"] = { nodes: [desk, node("1", value)], edges: [] };
      const { router } = renderApp("/topology?sourceHost=local&view=spatial");
      await spatialReady();
      const oddRig = screen.getAllByTestId("spatial-index-rig").find((s) => s.getAttribute("aria-label") === "Rig odd")!;
      fireEvent.click(within(oddRig).getByTestId("spatial-agent-row"));
      await waitFor(() => expect(search(router)).toMatchObject({ selectedRig: value, selectedNode: value }));
      const open = screen.getByTestId("spatial-open-seat") as HTMLAnchorElement;
      expect(open.getAttribute("href")).toBe(`/topology/seat/${encodeURIComponent(value)}/${encodeURIComponent(value)}?sourceHost=local`);
      fireEvent.click(open);
      await screen.findByTestId("live-node-details");
      await waitFor(() => expect(screen.getByText(`${value}@${value}`, { normalizer: (text) => text })).toBeTruthy());
      expect(requests().map((r) => r.url)).toContain(`/api/rigs/${encodeURIComponent(value)}/nodes/${encodeURIComponent(value)}`);
      expect(requests().some((r) => r.url === `/api/rigs/1/nodes/${encodeURIComponent(value)}`)).toBe(false);
      act(() => router.history.back());
      await spatialReady();
      expect(search(router)).toMatchObject({ selectedRig: value, selectedNode: value });
      const selectedRow = screen.getAllByTestId("spatial-agent-row").find((r) => r.getAttribute("aria-pressed") === "true")!;
      expect(screen.getAllByTestId("spatial-index-rig").find((s) => s.contains(selectedRow))!.getAttribute("aria-label")).toBe("Rig odd");
    },
    15000,
  );

  it.each(["1.0", "a%2Fb", "x/y?#", "日本🙂"])("same-entry replaces on a rig/pod path keep the exact %j route identity", async (value) => {
    fx.rigs.local = [{ id: value, name: "odd", nodeCount: 1 }];
    fx.graphs[`local|${value}`] = { nodes: [{ ...desk, data: { podId: value, podNamespace: value } }, node("n1", "seat", "pod-desk")], edges: [] };
    const { router } = renderApp(`/topology/pod/${encodeURIComponent(value)}/${encodeURIComponent(value)}?sourceHost=local&view=spatial`);
    await spatialReady();
    const index = router.history.location.state.__TSR_index;
    fireEvent.click(screen.getByTestId("spatial-mode-list"));
    await waitFor(() => expect(search(router).spatialMode).toBe("list"));
    // The serialized URL (what Back/reload/copy use) keeps the exact, once-
    // encoded identity; router params stay the raw value.
    expect(router.history.location.pathname).toBe(`/topology/pod/${encodeURIComponent(value)}/${encodeURIComponent(value)}`);
    expect(router.state.matches.at(-1)!.params).toEqual({ rigId: value, podName: value });
    expect(router.history.location.state.__TSR_index).toBe(index);
  });

  it("duplicate logical labels in two rigs keep the exact selected rig through Open seat", async () => {
    fx.rigs.local = [{ id: "rig_alpha", name: "alpha", nodeCount: 1 }, { id: "rig_bravo", name: "bravo", nodeCount: 1 }];
    fx.graphs["local|rig_alpha"] = { nodes: [desk, node("node_editor", "desk.editor")], edges: [] };
    fx.graphs["local|rig_bravo"] = { nodes: [desk, node("node_editor", "desk.editor")], edges: [] };
    const { router } = renderApp("/topology?sourceHost=local&view=spatial&spatialQuery=editor");
    await spatialReady();
    const bravo = screen.getAllByTestId("spatial-index-rig").find((s) => s.getAttribute("aria-label") === "Rig bravo")!;
    fireEvent.click(within(bravo).getByTestId("spatial-agent-row"));
    await waitFor(() => expect(search(router)).toMatchObject({ selectedRig: "rig_bravo", selectedNode: "node_editor" }));
    fireEvent.click(screen.getByTestId("spatial-open-seat"));
    await waitFor(() => expect(screen.getByText("desk.editor@rig_bravo")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/topology/seat/rig_bravo/desk.editor");
  });
});

describe("selection intent survives partial, failed and filtered data", () => {
  it("unreadable, absent and outside-filter selections are distinct and never substitute another seat", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial&spatialQuery=writer&selectedRig=rig_bravo&selectedNode=node_editor");
    await spatialReady();
    expect(screen.getByTestId("spatial-selection-outside-filter").textContent).toContain("Selected seat is outside the filter.");
    expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("editor");
    fireEvent.click(within(screen.getByTestId("spatial-selection-outside-filter")).getByRole("button"));
    await waitFor(() => expect(search(router).spatialQuery).toBeUndefined());
    expect(rowNamed("editor").getAttribute("aria-pressed")).toBe("true");
    cleanup();

    fx.graphs["local|rig_bravo"] = { nodes: [desk, null, node("node_writer", "desk.writer")], edges: [] };
    renderApp("/topology?sourceHost=local&view=spatial&selectedRig=rig_bravo&selectedNode=node_editor");
    const absent = await screen.findByTestId("spatial-selection-notice");
    expect(absent.getAttribute("data-state")).toBe("absent");
    expect(absent.textContent).toContain("1 malformed entry was skipped");
    expect(screen.queryByTestId("spatial-inspector")).toBeNull();
    cleanup();

    fx.rigs.local = [{ id: "rig_bravo", name: "bravo", nodeCount: 3 }, { id: "rig_down", name: "down", nodeCount: 1 }];
    const { router: second } = renderApp("/topology?sourceHost=local&view=spatial&selectedRig=rig_down&selectedNode=n1");
    const unreadable = await screen.findByTestId("spatial-selection-notice");
    await waitFor(() => expect(unreadable.getAttribute("data-state")).toBe("unreadable"));
    expect(unreadable.textContent).toContain("Selection unavailable while rig rig_down's graph cannot be read.");
    expect(search(second)).toMatchObject({ selectedRig: "rig_down", selectedNode: "n1" });
  });
});

describe("per-visit camera and scroll isolation", () => {
  it("Scene → List → Scene within a visit restores the pose; Reset-free refresh does not re-fit", async () => {
    renderApp("/topology?sourceHost=local&view=spatial");
    await spatialReady();
    fireEvent.click(screen.getByTestId("stub-move-camera"));
    fireEvent.click(screen.getByTestId("spatial-mode-list"));
    await screen.findByTestId("spatial-seat-index-table");
    rendererLog.mounts.length = 0;
    fireEvent.click(screen.getByTestId("spatial-mode-scene"));
    await spatialReady();
    expect(rendererLog.mounts).toEqual([MOVED]);
  });

  it("same-tab reload restores this visit; a copied link in a new tab starts fitted with no copied scroll", async () => {
    const first = renderApp("/topology?sourceHost=local&view=spatial");
    await spatialReady();
    fireEvent.click(screen.getByTestId("stub-move-camera"));
    const region = screen.getByTestId("spatial-index-region");
    region.scrollTop = 210;
    fireEvent.scroll(region);
    const href = first.router.state.location.href;
    const state = first.router.state.location.state as Record<string, unknown>;
    cleanup(); // pagehide/unmount capture

    rendererLog.mounts.length = 0;
    renderApp(href, { state: { [TOPOLOGY_VISIT_STATE_KEY]: state[TOPOLOGY_VISIT_STATE_KEY] } });
    await spatialReady();
    expect(rendererLog.mounts).toEqual([MOVED]);
    await waitFor(() => expect(screen.getByTestId("spatial-index-region").scrollTop).toBe(210));
    cleanup();

    rendererLog.mounts.length = 0;
    const copied = renderApp(href);
    await spatialReady();
    expect(rendererLog.mounts).toEqual([null]);
    expect(screen.getByTestId("spatial-index-region").scrollTop).toBe(0);
    await waitFor(() => expect((copied.router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY]).toBeTruthy());
    expect((copied.router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY]).not.toBe(state[TOPOLOGY_VISIT_STATE_KEY]);
  });

  it("a snapshot recorded for another host or scope under the same visit id is ignored", async () => {
    spatialVisitStore.put("visit-other-host-01", { v: 1, scope: { host: "A", kind: "host" }, camera: MOVED, scroll: { main: 0, index: 900, inspector: 0, list: 0 } });
    renderApp("/topology?sourceHost=local&view=spatial", { state: { [TOPOLOGY_VISIT_STATE_KEY]: "visit-other-host-01" } });
    await spatialReady();
    expect(rendererLog.mounts).toEqual([null]);
    expect(screen.getByTestId("spatial-index-region").scrollTop).toBe(0);
  });

  it("a rig drill from the 3D index keeps the rich view, starts a fresh scope visit, and Back restores the parent", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial&spatialQuery=desk&selectedRig=rig_bravo&selectedNode=node_writer");
    await spatialReady();
    fireEvent.click(screen.getByTestId("stub-move-camera"));
    const parentVisit = (router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY];
    rendererLog.mounts.length = 0;
    fireEvent.click(within(screen.getByTestId("spatial-seat-index-compact")).getByTitle("Open rig bravo"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/topology/rig/rig_bravo"));
    expect(search(router)).toEqual({ sourceHost: "local", view: "spatial" });
    await spatialReady();
    expect(rendererLog.mounts).toEqual([null]);
    expect((screen.getByTestId("spatial-search") as HTMLInputElement).value).toBe("");
    expect((router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY]).not.toBe(parentVisit);
    rendererLog.mounts.length = 0;
    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/topology"));
    await spatialReady();
    expect(search(router)).toMatchObject({ spatialQuery: "desk", selectedNode: "node_writer" });
    expect(rendererLog.mounts).toEqual([MOVED]);
  });
});

// Reused-body visit boundaries (independent review 2026-10-04): a scope body
// and its renderer are reused across same-scope history entries, so visit
// state must be switched explicitly — zero offsets included, and a fresh
// pushed visit must not inherit the departing camera.
describe("same-scope visit boundaries on a reused body", () => {
  const visitOf = (router: ReturnType<typeof renderApp>["router"]) =>
    (router.state.location.state as Record<string, unknown>)[TOPOLOGY_VISIT_STATE_KEY];
  const scrollAll = (main: number, index: number, inspector: number) => {
    const els = [screen.getByTestId("content-area"), screen.getByTestId("spatial-index-region"), screen.getByTestId("spatial-inspector-region")];
    [main, index, inspector].forEach((top, i) => { els[i]!.scrollTop = top; fireEvent.scroll(els[i]!); });
  };

  it("Back to a visit saved at zero actively restores zero in main, index and inspector", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial", { state: { [TOPOLOGY_VISIT_STATE_KEY]: "maintained-zero-visit" } });
    await spatialReady();
    await act(() => router.navigate({ to: "/topology", search: { sourceHost: "local", view: "spatial", spatialQuery: "desk" }, state: { [TOPOLOGY_VISIT_STATE_KEY]: "maintained-later-visit" } } as never));
    await waitFor(() => expect(search(router).spatialQuery).toBe("desk"));
    scrollAll(400, 320, 150);
    act(() => router.history.back());
    await waitFor(() => expect(visitOf(router)).toBe("maintained-zero-visit"));
    await waitFor(() => expect(screen.getByTestId("spatial-index-region").scrollTop).toBe(0));
    expect(screen.getByTestId("spatial-inspector-region").scrollTop).toBe(0);
    expect(screen.getByTestId("content-area").scrollTop).toBe(0);
    // Positive control in the same harness: Forward restores the later offsets.
    act(() => router.history.forward());
    await waitFor(() => expect(screen.getByTestId("spatial-index-region").scrollTop).toBe(320));
    expect(screen.getByTestId("spatial-inspector-region").scrollTop).toBe(150);
    expect(screen.getByTestId("content-area").scrollTop).toBe(400);
  });

  it("Back to a List visit saved at zero restores the list region to zero", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial&spatialMode=list", { state: { [TOPOLOGY_VISIT_STATE_KEY]: "maintained-list-zero" } });
    await screen.findByTestId("spatial-seat-index-table");
    await act(() => router.navigate({ to: "/topology", search: { sourceHost: "local", view: "spatial", spatialMode: "list", spatialQuery: "desk" }, state: { [TOPOLOGY_VISIT_STATE_KEY]: "maintained-list-later" } } as never));
    await waitFor(() => expect(search(router).spatialQuery).toBe("desk"));
    const list = screen.getByTestId("spatial-list-mode");
    list.scrollTop = 300;
    fireEvent.scroll(list);
    act(() => router.history.back());
    await waitFor(() => expect(visitOf(router)).toBe("maintained-list-zero"));
    await waitFor(() => expect(screen.getByTestId("spatial-list-mode").scrollTop).toBe(0));
  });

  it("a fresh pushed same-scope visit starts fitted at the top; the departing pose is stored under its own visit and returns on Back", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial", { state: { [TOPOLOGY_VISIT_STATE_KEY]: "maintained-moved-camera" } });
    await spatialReady();
    fireEvent.click(screen.getByTestId("stub-move-camera"));
    const index = screen.getByTestId("spatial-index-region");
    index.scrollTop = 260;
    fireEvent.scroll(index);
    const target = topologyTarget({ scope: { kind: "host" }, sourceHost: "local", view: "spatial" })!;
    await act(() => navigateTopology(router, { kind: "host" }, target));
    await waitFor(() => expect(visitOf(router)).not.toBe("maintained-moved-camera"));
    fireEvent.click(screen.getByTestId("stub-read-pose"));
    expect(rendererLog.poses.at(-1)).toEqual(FITTED);
    await waitFor(() => expect(screen.getByTestId("spatial-index-region").scrollTop).toBe(0));
    expect(spatialVisitStore.get("maintained-moved-camera")).toMatchObject({ camera: MOVED, scroll: { index: 260 } });
    // A later renderer mount in the fresh visit must not inherit the old pose.
    fireEvent.click(screen.getByTestId("spatial-mode-list"));
    await screen.findByTestId("spatial-seat-index-table");
    rendererLog.mounts.length = 0;
    fireEvent.click(screen.getByTestId("spatial-mode-scene"));
    await spatialReady();
    // The fresh visit's own pose is auto-fit (userMoved:false means "fit"),
    // never the departing manual pose.
    expect(rendererLog.mounts).toHaveLength(1);
    expect(rendererLog.mounts[0] === null || (rendererLog.mounts[0] as Pose).userMoved === false).toBe(true);
    expect(rendererLog.mounts).not.toContainEqual(MOVED);
    act(() => router.history.back());
    act(() => router.history.back());
    await waitFor(() => expect(visitOf(router)).toBe("maintained-moved-camera"));
    await waitFor(() => expect(rendererLog.restores.at(-1)).toEqual(MOVED));
    fireEvent.click(screen.getByTestId("stub-read-pose"));
    expect(rendererLog.poses.at(-1)).toEqual(MOVED);
  });

  it("ordinary semantic replaces keep the same visit and the operator's camera", async () => {
    const { router } = renderApp("/topology?sourceHost=local&view=spatial", { state: { [TOPOLOGY_VISIT_STATE_KEY]: "maintained-replace-visit" } });
    await spatialReady();
    fireEvent.click(screen.getByTestId("stub-move-camera"));
    fireEvent.change(screen.getByTestId("spatial-search"), { target: { value: "writer" } });
    await waitFor(() => expect(search(router).spatialQuery).toBe("writer"));
    fireEvent.click(rowNamed("writer"));
    await waitFor(() => expect(search(router).selectedNode).toBe("node_writer"));
    expect(visitOf(router)).toBe("maintained-replace-visit");
    fireEvent.click(screen.getByTestId("stub-read-pose"));
    expect(rendererLog.poses.at(-1)).toEqual(MOVED);
    expect(rendererLog.restores).toEqual([]);
  });
});

// Seat Overview/Details is URL state (`view`) on the seat route: direct URL and
// reload, tab choice REPLACES the entry, Back/Forward restore each seat's own
// tab with its exact identity, and a reused LiveNodeDetails follows the route.
describe("seat Overview/Details URL continuity", () => {
  const seatTab = (id: "overview" | "details") => screen.getByTestId(`live-tab-${id}`);
  const seatReady = async (name: string) => {
    await waitFor(() => expect(screen.getByText(name)).toBeTruthy(), { timeout: 5000 });
  };

  it("a direct details URL opens Details; choosing Overview replaces the entry", async () => {
    const { router } = renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local&view=details");
    await seatReady("desk.editor@rig_bravo");
    // The actual source-gated SeatScopePage may delegate to a helper, but it
    // must render only the canonical Overview/Details row, no outer tabs.
    const seat = within(screen.getByTestId("seat-scope-page"));
    expect(seat.getAllByRole("tablist")).toHaveLength(1);
    const tabs = seat.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs.map(tab => tab.textContent?.trim())).toEqual(["overview", "details"]);
    expect(seatTab("details").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("live-details-section")).toBeTruthy();
    const index = router.history.location.state.__TSR_index;
    fireEvent.click(seatTab("overview"));
    await waitFor(() => expect(search(router)).toEqual({ sourceHost: "local" }));
    expect(router.history.location.state.__TSR_index).toBe(index);
    expect(seatTab("overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("live-details-section")).toBeNull();
  });

  it("Back/Forward restore each seat's own tab; the reused component never carries the previous seat's tab", async () => {
    const { router } = renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local");
    await seatReady("desk.editor@rig_bravo");
    fireEvent.click(seatTab("details"));
    await waitFor(() => expect(search(router).view).toBe("details"));
    const detailsRoot = screen.getByTestId("live-node-details");
    const target = topologyTarget({ scope: { kind: "seat", rigId: "rig_bravo", logicalId: "desk.writer" }, sourceHost: "local" })!;
    await act(() => navigateTopology(router, null, target));
    await seatReady("desk.writer@rig_bravo");
    expect(screen.getByTestId("live-node-details")).toBe(detailsRoot);
    expect(seatTab("overview").getAttribute("aria-selected")).toBe("true");
    expect(router.state.location.pathname).toBe("/topology/seat/rig_bravo/desk.writer");
    act(() => router.history.back());
    await seatReady("desk.editor@rig_bravo");
    expect(search(router)).toEqual({ sourceHost: "local", view: "details" });
    expect(seatTab("details").getAttribute("aria-selected")).toBe("true");
    act(() => router.history.forward());
    await seatReady("desk.writer@rig_bravo");
    expect(seatTab("overview").getAttribute("aria-selected")).toBe("true");
    expect(requests().map((r) => r.url)).toEqual(expect.arrayContaining([
      "/api/rigs/rig_bravo/nodes/desk.editor", "/api/rigs/rig_bravo/nodes/desk.writer",
    ]));
    expect(posts()).toEqual([]);
  });

  it("an invalid seat view renders Overview with a notice; a seat link from another host is gated before any detail read", async () => {
    renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local&view=graph");
    await seatReady("desk.editor@rig_bravo");
    expect(seatTab("overview").getAttribute("aria-selected")).toBe("true");
    cleanup();
    fetchMock.mockClear();
    renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=A&view=details");
    expect(await screen.findByTestId("topology-source-mismatch")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(targetReads()).toEqual([]);
  });
});

// Recent on host/rig topology scopes (gui-recent-pulse-ui.md): connected
// instance only, exact served rig NAME for the confirmed rig id.
describe("topology Recent panel", () => {
  const recentReads = () => requests().map((r) => r.url).filter((u) => u.startsWith("/api/queue/recent-transitions"));

  it("host scope reads the instance window; rig scope filters by the served name of the exact rig id", async () => {
    renderApp("/topology?sourceHost=local&view=table");
    expect(await screen.findByTestId("recent-scope-panel")).toBeTruthy();
    await waitFor(() => expect(recentReads()).toContain("/api/queue/recent-transitions?scope=instance&limit=20"));
    cleanup();
    fetchMock.mockClear();
    renderApp("/topology/rig/rig_bravo?sourceHost=local&view=table");
    expect(await screen.findByTestId("recent-scope-panel")).toBeTruthy();
    await waitFor(() => expect(recentReads()).toContain("/api/queue/recent-transitions?scope=rig&rig=bravo&limit=20"));
    expect(recentReads().some((u) => u.includes("rig=rig_bravo"))).toBe(false);
  });

  it("a rig whose summary row is missing is unavailable, never a guessed name; a failed summary is not 'pending'", async () => {
    fx.rigs.local = [{ id: "rig_other", name: "other", nodeCount: 0 }];
    renderApp("/topology/rig/rig_bravo?sourceHost=local&view=table");
    expect(await screen.findByTestId("recent-scope-panel-rig-unavailable")).toBeTruthy();
    expect(recentReads().filter((u) => u.includes("scope=rig"))).toEqual([]);
    cleanup();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("/api/rigs/summary") ? json({ error: "down" }, 503) : serve(input, init));
    renderApp("/topology/rig/rig_bravo?sourceHost=local&view=table");
    expect(await screen.findByTestId("recent-scope-panel-rig-unavailable")).toBeTruthy();
  });

  it("a remote selection shows the unsupported state with no Recent read; pod and seat scopes have no panel", async () => {
    fx.hosts = { ownName: "fixture", selected: "A", hosts: [{ ...HOST_A, selected: true }] };
    fx.rigs.A = [{ id: "rig_bravo", name: "bravo", nodeCount: 1 }];
    renderApp("/topology?sourceHost=A&view=table");
    expect(await screen.findByTestId("recent-scope-panel-list-unsupported")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(recentReads()).toEqual([]);
    cleanup();
    fx.hosts = { ownName: "fixture", selected: "local", hosts: [HOST_A] };
    renderApp("/topology/pod/rig_bravo/desk?sourceHost=local&view=table");
    await screen.findByTestId("topology-pod-tabs");
    renderApp("/topology/seat/rig_bravo/desk.editor?sourceHost=local");
    await waitFor(() => expect(screen.getByText("desk.editor@rig_bravo")).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByTestId("recent-scope-panel")).toBeNull();
  });
});

// Recent's rig filter needs a CURRENT summary read: a failed same-key refresh
// keeps the old row in the cache, but cannot certify its name.
describe("Recent rig filter admission on summary failure", () => {
  const recentRigReads = () => requests().map((r) => r.url).filter((u) => u.includes("recent-transitions?scope=rig"));

  it("a warm summary refresh failure turns the rig filter unavailable instead of reusing the retained name", async () => {
    const { client } = renderApp("/topology/rig/rig_bravo?sourceHost=local&view=table");
    await waitFor(() => expect(recentRigReads()).toContain("/api/queue/recent-transitions?scope=rig&rig=bravo&limit=20"));
    expect(screen.queryByTestId("recent-scope-panel-rig-unavailable")).toBeNull();
    const key = ["rigs", "summary", "local"];
    const retained = client.getQueryData(key);
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("/api/rigs/summary") ? json({ error: "down" }, 503) : serve(input, init));
    await act(async () => { await client.refetchQueries({ queryKey: key, exact: true }); });
    expect(client.getQueryState(key)!.status).toBe("error");
    expect(client.getQueryData(key)).toBe(retained);
    expect(await screen.findByTestId("recent-scope-panel-rig-unavailable")).toBeTruthy();
    expect(recentRigReads().some((u) => !u.includes("rig=bravo"))).toBe(false);
  });

  it("control: a cold summary failure never requests a rig window", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("/api/rigs/summary") ? json({ error: "down" }, 503) : serve(input, init));
    renderApp("/topology/rig/rig_bravo?sourceHost=local&view=table");
    expect(await screen.findByTestId("recent-scope-panel-rig-unavailable")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(recentRigReads()).toEqual([]);
  });
});
