// SpatialTopologyView — interaction tests with the GPU renderer replaced by a
// stub that exposes the same contract (controller, onSelect, onReady). jsdom
// cannot prove WebGL rendering; these prove selection, keyboard, search,
// inspector truthfulness, scoping resets, list mode and detail navigation.
// The real-renderer fallback path is covered in spatial-view-fallback.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import SpatialTopologyView from "../src/components/topology/spatial/SpatialTopologyView.js";
import { parseTopologySearch, stringifyTopologySearch } from "../src/lib/topology-search.js";
import type { SpatialScope } from "../src/lib/spatial-topology.js";

const controller = vi.hoisted(() => ({
  fit: vi.fn(),
  reset: vi.fn(),
  preset: vi.fn(),
  zoom: vi.fn(),
  orbit: vi.fn(),
  focus: vi.fn(),
}));

vi.mock("../src/components/topology/spatial/SpatialRenderer.js", async () => {
  const React = await import("react");
  type StubProps = {
    model: { agentsByKey: Map<string, unknown> };
    selectedKey: string | null;
    matchKeys: ReadonlySet<string> | null;
    controllerRef: { current: unknown };
    onSelect: (key: string | null) => void;
    onReady?: () => void;
  };
  function StubRenderer(props: StubProps) {
    React.useEffect(() => {
      props.controllerRef.current = controller;
      props.onReady?.();
      return () => {
        props.controllerRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement(
      "div",
      {
        "data-testid": "stub-renderer",
        "data-selected": props.selectedKey ?? "",
        "data-matches": props.matchKeys ? String(props.matchKeys.size) : "none",
      },
      [...props.model.agentsByKey.keys()].map((key) =>
        React.createElement("button", { key, type: "button", "data-testid": "stub-pick", "data-key": key, onClick: () => props.onSelect(key) }),
      ),
      React.createElement("button", { key: "empty", type: "button", "data-testid": "stub-pick-empty", onClick: () => props.onSelect(null) }),
    );
  }
  return { default: StubRenderer };
});

const graphA = {
  nodes: [
    { id: "pod-p1", type: "podGroup", data: { podId: "p1", podNamespace: "lead" } },
    { id: "pod-p2", type: "podGroup", data: { podId: "p2", podNamespace: "builders" } },
    { id: "n1", type: "rigNode", parentId: "pod-p1", data: { logicalId: "lead.coordinator", status: "running", startupStatus: "ready", terminalActive: true, runtime: "claude-code", pendingWorkCount: 2 } },
    { id: "n2", type: "rigNode", parentId: "pod-p2", data: { logicalId: "builders.builder1", status: "running", startupStatus: "failed" } },
    { id: "n3", type: "rigNode", parentId: "pod-p2", data: { logicalId: "builders.reviewer", status: "running", startupStatus: "attention_required", terminalActive: true, identityVerdict: { verdict: "mismatch", reason: "pane runs zsh" } } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", label: "delegates_to" },
    { id: "e2", source: "n1", target: "ghost", label: "x" },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let qc: QueryClient;

function renderView(scope: SpatialScope = { kind: "host" }, opts: { selected?: string } = {}) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  qc.setQueryData(["hosts"], { ownName: "me", selected: opts.selected ?? "local", hosts: [] });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const viewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/topology", component: () => <SpatialTopologyView scope={scope} /> });
  const seatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology/seat/$rigId/$logicalId",
    component: () => <div data-testid="seat-page">seat</div>,
  });
  const catchAll = createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => <div data-testid="other-page" /> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([viewRoute, seatRoute, catchAll]),
    history: createMemoryHistory({ initialEntries: ["/topology"] }),
    // Production search contract: raw topology identities, never coerced.
    parseSearch: parseTopologySearch,
    stringifySearch: stringifyTopologySearch,
  });
  const result = render(<RouterProvider router={router} />);
  return { ...result, router };
}

beforeEach(() => {
  for (const fn of Object.values(controller)) fn.mockReset();
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/rigs/summary") return json([{ id: "ra", name: "acme-build", nodeCount: 3 }]);
    if (url === "/api/rigs/ra/graph") return json(graphA);
    return json({}, 404);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

async function ready() {
  // The first mount transforms the lazy spatial chunk; allow for a loaded host.
  await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
  await waitFor(() => expect((screen.getByTestId("spatial-camera-fit") as HTMLButtonElement).disabled).toBe(false));
}

function rowFor(name: string) {
  return screen.getAllByTestId("spatial-agent-row").find((r) => r.textContent?.includes(name))!;
}

describe("SpatialTopologyView", () => {
  it("shows real counts, a status tally, skipped-entry notice and the grouped seat index", async () => {
    renderView();
    await ready();
    expect(screen.getByTestId("spatial-counts").textContent).toBe("1 rig · 2 pods · 3 seats · 1 link");
    const tally = screen.getByTestId("spatial-tally");
    expect(tally.textContent).toContain("running1");
    expect(tally.textContent).toContain("blocked1");
    expect(tally.textContent).toContain("attention2");
    expect(screen.getByTestId("spatial-issues").textContent).toContain("1 graph entry skipped");
    const index = screen.getByTestId("spatial-seat-index-compact");
    expect(within(index).getAllByTestId("spatial-index-pod")).toHaveLength(2);
    expect(within(index).getAllByTestId("spatial-agent-row")).toHaveLength(3);
  });

  it("selecting from the index opens the inspector and focuses the camera; no terminal is mounted", async () => {
    renderView();
    await ready();
    fireEvent.click(rowFor("reviewer"));
    const inspector = await screen.findByTestId("spatial-inspector");
    expect(within(inspector).getByTestId("spatial-inspector-name").textContent).toBe("reviewer");
    expect(within(inspector).getByTestId("spatial-inspector-status").textContent).toContain("identity mismatch");
    expect(within(inspector).getByTestId("spatial-inspector-status").textContent).toContain("not live");
    expect(within(inspector).getByTestId("spatial-inspector-problems").textContent).toContain("pane runs zsh");
    expect(rowFor("reviewer").getAttribute("aria-pressed")).toBe("true");
    expect(controller.focus).toHaveBeenCalledWith(expect.stringContaining("/agent/n3"));
    expect(document.querySelector(".xterm, [data-testid*='terminal']")).toBeNull();
  });

  it.each(["index click", "search Enter"] as const)("%s selects a seat from a rig whose graph arrived after the scene became active", async (action) => {
    let deliverSecondGraph!: (response: Response) => void;
    const secondGraph = new Promise<Response>(resolve => { deliverSecondGraph = resolve; });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([
        { id: "ra", name: "acme-build", nodeCount: 3 },
        { id: "rb", name: "acme-comms", nodeCount: 1 },
      ]);
      if (url === "/api/rigs/ra/graph") return json(graphA);
      if (url === "/api/rigs/rb/graph") return secondGraph;
      return json({}, 404);
    });
    const { router } = renderView();
    await ready();
    fireEvent.click(rowFor("coordinator"));
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("coordinator"));
    const earlierLocation = router.history.location.href;
    await act(async () => {
      deliverSecondGraph(json({ nodes: [
        { id: "editor-node", type: "rigNode", data: { logicalId: "desk.editor", canonicalSessionName: "editor@acme-comms", status: "running", startupStatus: "ready" } },
      ], edges: [] }));
    });
    await waitFor(() => expect(rowFor("editor")).toBeTruthy());
    if (action === "index click") fireEvent.click(rowFor("editor"));
    else {
      const input = screen.getByTestId("spatial-search");
      fireEvent.change(input, { target: { value: "editor" } });
      fireEvent.keyDown(input, { key: "Enter" });
    }
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("editor"));
    expect(rowFor("editor").getAttribute("aria-pressed")).toBe("true");
    expect(router.history.location.href).not.toBe(earlierLocation);
    expect(router.history.location.href).toContain("editor-node");
    expect(controller.focus).toHaveBeenLastCalledWith(expect.stringContaining("/agent/editor-node"));
  });

  it("selecting in the scene does not move the camera; clicking empty space clears selection", async () => {
    renderView();
    await ready();
    const pick = screen.getAllByTestId("stub-pick").find((b) => b.getAttribute("data-key")?.endsWith("/agent/n1"))!;
    fireEvent.click(pick);
    expect((await screen.findByTestId("spatial-inspector-name")).textContent).toBe("coordinator");
    expect(screen.getByTestId("stub-renderer").getAttribute("data-selected")).toMatch(/\/agent\/n1$/);
    expect(controller.focus).not.toHaveBeenCalled();
    expect(screen.getByTestId("spatial-inspector-relationships").textContent).toContain("delegates_to");
    fireEvent.click(screen.getByTestId("stub-pick-empty"));
    expect(await screen.findByTestId("spatial-inspector-empty")).toBeTruthy();
  });

  it("relationship peers are selectable from the inspector", async () => {
    renderView();
    await ready();
    fireEvent.click(rowFor("coordinator"));
    const rel = await screen.findByTestId("spatial-inspector-relationships");
    fireEvent.click(within(rel).getByRole("button"));
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("builder1"));
    expect(screen.getByTestId("spatial-inspector-problems").textContent).toContain("Startup failed");
  });

  it("index supports arrow/Home/End roving focus", async () => {
    renderView();
    await ready();
    const rows = within(screen.getByTestId("spatial-seat-index-compact")).getAllByTestId("spatial-agent-row");
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "End" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2]!, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
  });

  it("camera HUD and stage keyboard shortcuts drive the controller", async () => {
    renderView();
    await ready();
    fireEvent.click(screen.getByTestId("spatial-camera-fit"));
    fireEvent.click(screen.getByTestId("spatial-camera-top"));
    fireEvent.click(screen.getByTestId("spatial-camera-zoom-in"));
    expect(controller.fit).toHaveBeenCalledTimes(1);
    expect(controller.preset).toHaveBeenCalledWith("top");
    expect(controller.zoom).toHaveBeenCalledWith(0.8);
    const stage = screen.getByTestId("spatial-stage");
    expect(stage.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    fireEvent.keyDown(stage, { key: "i" });
    fireEvent.keyDown(stage, { key: "-" });
    expect(controller.orbit).toHaveBeenCalledWith(expect.any(Number), 0);
    expect(controller.preset).toHaveBeenCalledWith("iso");
    expect(controller.zoom).toHaveBeenCalledWith(1.25);
  });

  it("search filters the index, dims the scene and Enter selects the first match", async () => {
    renderView();
    await ready();
    const input = screen.getByTestId("spatial-search");
    fireEvent.change(input, { target: { value: "builders" } });
    expect(screen.getByTestId("spatial-search-count").textContent).toBe("2 of 3 seats match");
    expect(screen.getByTestId("stub-renderer").getAttribute("data-matches")).toBe("2");
    expect(within(screen.getByTestId("spatial-seat-index-compact")).getAllByTestId("spatial-agent-row")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("builder1"));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByTestId("stub-renderer").getAttribute("data-matches")).toBe("none");
  });

  // Navigation contract change: the selection is exact URL intent. A seat
  // removed on refresh drops out of the inspector (nothing stale is shown as
  // current) and the inspector says it is absent instead of silently
  // forgetting the selection or substituting another seat.
  it("selection follows current data: a seat removed on refresh drops out of the inspector", async () => {
    const { router } = renderView();
    await ready();
    fireEvent.click(rowFor("reviewer"));
    await screen.findByTestId("spatial-inspector");
    act(() => {
      qc.setQueryData(["rig", "ra", "graph", "local"], { ...graphA, nodes: graphA.nodes.filter((n) => n.id !== "n3") });
    });
    const notice = await screen.findByTestId("spatial-selection-notice");
    expect(notice.getAttribute("data-state")).toBe("absent");
    expect(notice.textContent).toContain("Graph node n3 is not in rig ra's current graph");
    expect(screen.queryByTestId("spatial-inspector")).toBeNull();
    expect(screen.getByTestId("spatial-counts").textContent).toContain("2 seats");
    expect(router.state.location.search).toMatchObject({ selectedRig: "ra", selectedNode: "n3" });
    fireEvent.click(screen.getByTestId("spatial-selection-clear"));
    expect(await screen.findByTestId("spatial-inspector-empty")).toBeTruthy();
    expect(router.state.location.search).not.toHaveProperty("selectedNode");
  });

  it("a host switch resets selection and never shows the previous host's seats", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "ra", name: "acme-build", nodeCount: 3 }]);
      if (url === "/api/rigs/ra/graph") return json(graphA);
      if (url === "/api/rigs/summary?host=other") return new Promise<Response>(() => {});
      return json({}, 404);
    });
    renderView();
    await ready();
    fireEvent.click(rowFor("coordinator"));
    await screen.findByTestId("spatial-inspector");
    act(() => {
      qc.setQueryData(["hosts"], { ownName: "me", selected: "other", hosts: [] });
    });
    expect(await screen.findByTestId("spatial-loading")).toBeTruthy();
    expect(screen.queryByTestId("spatial-agent-row")).toBeNull();
    expect(screen.queryByTestId("spatial-inspector")).toBeNull();
    expect(screen.getByTestId("spatial-remote-host").textContent).toContain("other");
  });

  it("Open seat navigates to the seat detail route (navigation only)", async () => {
    const { router } = renderView();
    await ready();
    fireEvent.click(rowFor("coordinator"));
    fireEvent.click(await screen.findByTestId("spatial-open-seat"));
    await screen.findByTestId("seat-page");
    expect(router.state.location.pathname).toBe(`/topology/seat/ra/${encodeURIComponent(encodeURIComponent("lead.coordinator"))}`);
    expect(fetchMock.mock.calls.every(([, init]) => !init || !(init as RequestInit).method || (init as RequestInit).method === "GET")).toBe(true);
  });

  it("List mode swaps the scene for the table and unmounts the renderer", async () => {
    renderView();
    await ready();
    fireEvent.click(screen.getByTestId("spatial-mode-list"));
    expect(screen.queryByTestId("stub-renderer")).toBeNull();
    const table = screen.getByTestId("spatial-seat-index-table");
    expect(within(table).getAllByTestId("spatial-agent-row")).toHaveLength(3);
    expect(table.textContent).toContain("startup failed");
    fireEvent.click(screen.getByTestId("spatial-mode-scene"));
    expect(await screen.findByTestId("stub-renderer")).toBeTruthy();
  });

  it("pod scope shows only that pod", async () => {
    renderView({ kind: "pod", rigId: "ra", podName: "builders" });
    await ready();
    expect(screen.getByTestId("spatial-counts").textContent).toBe("1 rig · 1 pod · 2 seats · 0 links");
  });

  it("missing pod renders an explanation instead of a scene", async () => {
    renderView({ kind: "pod", rigId: "ra", podName: "nope" });
    expect(await screen.findByTestId("spatial-pod-missing")).toBeTruthy();
    expect(screen.queryByTestId("stub-renderer")).toBeNull();
  });

  it("a live terminal-poll seat says its sample time is not reported instead of borrowing an age", async () => {
    renderView();
    await ready();
    fireEvent.click(rowFor("coordinator"));
    const status = (await screen.findByTestId("spatial-inspector-status")).textContent ?? "";
    expect(status).toContain("current");
    expect(status).toContain("terminal output poll");
    expect(status).toContain("sample time not reported");
    expect(status).not.toMatch(/sample \S+ old/);
  });

  it("over the scene budget: no scene is mounted, every seat stays listed, searchable and selectable", async () => {
    const nodes: Array<Record<string, unknown>> = [{ id: "pod-big", type: "podGroup", data: { podNamespace: "swarm" } }];
    for (let i = 0; i < 450; i++) {
      nodes.push({ id: `s${i}`, type: "rigNode", parentId: "pod-big", data: { logicalId: `swarm.worker-${i}`, status: "running", terminalActive: true } });
    }
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "rb", name: "big-rig", nodeCount: 450 }]);
      if (url === "/api/rigs/rb/graph") return json({ nodes, edges: [] });
      return json({}, 404);
    });
    renderView();
    const notice = await screen.findByTestId("spatial-budget");
    expect(notice.textContent).toContain("450 seats");
    expect(notice.textContent).toContain("Nothing is omitted");
    expect(screen.queryByTestId("stub-renderer")).toBeNull();
    expect(screen.queryByTestId("spatial-camera-hud")).toBeNull();
    const index = screen.getByTestId("spatial-seat-index-compact");
    expect(within(index).getAllByTestId("spatial-agent-row")).toHaveLength(450);
    fireEvent.change(screen.getByTestId("spatial-search"), { target: { value: "worker-449" } });
    expect(screen.getByTestId("spatial-search-count").textContent).toBe("1 of 450 seats match");
    fireEvent.keyDown(screen.getByTestId("spatial-search"), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("worker-449"));
    expect(controller.focus).not.toHaveBeenCalled();
  });

  it("loading and error states are explicit", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json({ error: "x" }, 500);
      return json({}, 404);
    });
    renderView();
    const error = await screen.findByTestId("spatial-error");
    expect(error.textContent).toContain("HTTP 500");
  });
});

// Layout sizing invariants. jsdom has no layout engine, so these assert the
// structural contract that makes the browser size the stage from the space
// left on the page: on wide screens the stage/inspector/index grid is out of
// flow inside a flex-1 body, so the full seat index cannot contribute
// intrinsic height to the page (the defect: a 479x991 canvas mostly below a
// 720px fold). They do not prove pixels; the browser pass does.
describe("SpatialTopologyView layout", () => {
  const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

  function setViewportWidth(width: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  }

  const originalWidth = window.innerWidth;
  afterEach(() => setViewportWidth(originalWidth));

  it("wide: the grid fills the remaining page height out of flow and the index scrolls inside it", async () => {
    setViewportWidth(1280);
    renderView();
    await ready();

    const frame = screen.getByTestId("spatial-topology-view");
    expect(classesOf(frame)).toEqual(expect.arrayContaining(["flex", "min-h-0", "flex-1", "flex-col"]));

    const body = screen.getByTestId("spatial-body");
    expect(body.getAttribute("data-layout")).toBe("bounded");
    expect(classesOf(body)).toEqual(expect.arrayContaining(["relative", "flex-1"]));
    expect(body.parentElement).toBe(frame);

    const grid = screen.getByTestId("spatial-grid");
    expect(grid.parentElement).toBe(body);
    // Out of flow, so its content never grows the body or the page.
    expect(classesOf(grid)).toEqual(expect.arrayContaining(["absolute", "inset-0", "grid-rows-[minmax(0,1fr)]"]));

    // The stage takes its height from the grid row, not from a fixed size.
    const stage = screen.getByTestId("spatial-stage");
    expect(stage.parentElement).toBe(grid);
    expect(classesOf(stage).filter((c) => /^(min-)?h-\[/.test(c))).toEqual([]);
    expect(classesOf(stage)).toContain("min-h-0");

    // Inspector keeps at most part of the column; the index fills the rest
    // and both scroll independently of the page.
    const inspector = screen.getByTestId("spatial-inspector-region");
    expect(classesOf(inspector)).toEqual(expect.arrayContaining(["max-h-[55%]", "overflow-auto", "shrink-0"]));
    const index = screen.getByTestId("spatial-index-region");
    expect(classesOf(index)).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-auto"]));
    expect(index.contains(screen.getByTestId("spatial-seat-index-compact"))).toBe(true);
    expect(classesOf(screen.getByTestId("spatial-side"))).toEqual(expect.arrayContaining(["flex", "min-h-0", "flex-col"]));

    // No region inside the bounded grid is sized from the viewport.
    for (const el of [grid, ...grid.querySelectorAll("*")]) {
      expect(classesOf(el).filter((c) => /\d+vh\]/.test(c))).toEqual([]);
    }
    // All three regions stay in the DOM: nothing is hidden to make room.
    expect(within(index).getAllByTestId("spatial-agent-row")).toHaveLength(3);
    expect(screen.getByTestId("spatial-camera-hud")).toBeTruthy();
  });

  it("wide list mode: the table and the inspector each scroll inside the bounded grid", async () => {
    setViewportWidth(1440);
    renderView();
    await ready();
    fireEvent.click(screen.getByTestId("spatial-mode-list"));
    const list = screen.getByTestId("spatial-list-mode");
    expect(list.parentElement).toBe(screen.getByTestId("spatial-grid"));
    expect(classesOf(list)).toEqual(expect.arrayContaining(["min-h-0", "overflow-auto"]));
    expect(classesOf(screen.getByTestId("spatial-inspector-region"))).toEqual(
      expect.arrayContaining(["min-h-0", "flex-1", "overflow-auto"]),
    );
    expect(screen.queryByTestId("spatial-index-region")).toBeNull();
  });

  it("narrow: stage, inspector and index stack in flow and the page scrolls", async () => {
    setViewportWidth(390);
    renderView();
    await ready();
    const body = screen.getByTestId("spatial-body");
    expect(body.getAttribute("data-layout")).toBe("stacked");
    expect(classesOf(body)).not.toContain("flex-1");
    const grid = screen.getByTestId("spatial-grid");
    expect(classesOf(grid)).not.toContain("absolute");
    expect(classesOf(grid)).toContain("grid-cols-1");
    expect(classesOf(screen.getByTestId("spatial-stage"))).toEqual(expect.arrayContaining(["h-[56vh]", "min-h-[18rem]"]));
    expect(classesOf(screen.getByTestId("spatial-inspector-region"))).not.toContain("overflow-auto");
    expect(classesOf(screen.getByTestId("spatial-index-region"))).toEqual(expect.arrayContaining(["max-h-[70vh]", "overflow-auto"]));
  });
});
