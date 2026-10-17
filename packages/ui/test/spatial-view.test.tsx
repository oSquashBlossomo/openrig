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
import { setPreferredSeatView } from "../src/components/native-chat/NativeChatPanel.js";
// These cover the terminal; seats open in Chat by default (native-chat-panel.test.tsx).
setPreferredSeatView("terminal");

const controller = vi.hoisted(() => ({
  fit: vi.fn(),
  reset: vi.fn(),
  preset: vi.fn(),
  zoom: vi.fn(),
  orbit: vi.fn(),
  focus: vi.fn(),
  refreshOverlays: vi.fn(),
}));

vi.mock("../src/components/topology/spatial/SpatialRenderer.js", async () => {
  const React = await import("react");
  type StubProps = {
    model: { agentsByKey: Map<string, unknown> };
    selectedKey: string | null;
    matchKeys: ReadonlySet<string> | null;
    density?: string;
    controllerRef: { current: unknown };
    onSelect: (key: string | null) => void;
    onReady?: () => void;
    traffic?: readonly unknown[];
    palette: { theme: string; atelier: { stage: { l: number } } };
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
        "data-density": props.density ?? "full",
        "data-traffic": props.traffic ? String(props.traffic.length) : "none",
        "data-palette-theme": props.palette.theme,
        "data-stage-lightness": String(props.palette.atelier.stage.l),
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

function renderView(scope: SpatialScope = { kind: "host" }, opts: { selected?: string; initialPath?: string } = {}) {
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
    history: createMemoryHistory({ initialEntries: [opts.initialPath ?? "/topology"] }),
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

function chipFor(name: string) {
  return screen.getAllByTestId("spatial-seat-chip").find((c) => c.textContent?.includes(name))!;
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
    // Observed-traffic pulses are composed into the renderer (none here: no feed events).
    expect(screen.getByTestId("stub-renderer").getAttribute("data-traffic")).toBe("0");
    // Night Atelier styling is local to this view, and the scene palette is the
    // dark atelier even though no app theme provider resolves dark here (the
    // default app theme is light): labels and renderer agree on one subtree.
    expect(screen.getByTestId("spatial-topology-view").classList.contains("spatial-atelier")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByTestId("stub-renderer").getAttribute("data-palette-theme")).toBe("dark");
    expect(Number(screen.getByTestId("stub-renderer").getAttribute("data-stage-lightness"))).toBeLessThan(20);
  });

  it("selecting from the index docks the seat workspace and focuses the camera; a seat with no session explains why no terminal opens", async () => {
    renderView();
    await ready();
    fireEvent.click(rowFor("reviewer"));
    const workspace = await screen.findByTestId("spatial-workspace");
    expect(workspace.getAttribute("data-layout")).toBe("side");
    expect(screen.getByTestId("spatial-body").getAttribute("data-docked")).toBe("true");
    expect(within(workspace).getByTestId("spatial-inspector-name").textContent).toBe("reviewer");
    expect(within(workspace).getByTestId("spatial-inspector-status").textContent).toContain("identity mismatch");
    expect(within(workspace).getByTestId("spatial-inspector-status").textContent).toContain("not live");
    // The mismatch stays visible above the terminal, not behind a tab.
    expect(within(workspace).getByTestId("spatial-inspector-problems").textContent).toContain("pane runs zsh");
    // Docked: the persistent index gives way to the compact switcher, with the
    // full index one tap away; the selected seat is pressed in the switcher.
    expect(screen.queryByTestId("spatial-index-region")).toBeNull();
    expect(chipFor("reviewer").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("spatial-all-seats-toggle"));
    expect(rowFor("reviewer").getAttribute("aria-pressed")).toBe("true");
    expect(controller.focus).toHaveBeenCalledWith(expect.stringContaining("/agent/n3"));
    // graphA serves no canonical session for this seat: honest refusal, no viewer.
    expect(within(workspace).getByTestId("spatial-terminal-state").getAttribute("data-state")).toBe("no-session");
    expect(document.querySelector(".xterm, [data-testid='spatial-terminal-live']")).toBeNull();
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
    await waitFor(() => expect(chipFor("editor")).toBeTruthy());
    if (action === "index click") {
      fireEvent.click(screen.getByTestId("spatial-all-seats-toggle"));
      fireEvent.click(rowFor("editor"));
    }
    else {
      const input = screen.getByTestId("spatial-search");
      fireEvent.change(input, { target: { value: "editor" } });
      fireEvent.keyDown(input, { key: "Enter" });
    }
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("editor"));
    expect(chipFor("editor").getAttribute("aria-pressed")).toBe("true");
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
    fireEvent.click(screen.getByTestId("spatial-workspace-tab-relationships"));
    expect(screen.getByTestId("spatial-inspector-relationships").textContent).toContain("delegates_to");
    fireEvent.click(screen.getByTestId("stub-pick-empty"));
    expect(await screen.findByTestId("spatial-inspector-empty")).toBeTruthy();
    expect(screen.queryByTestId("spatial-workspace")).toBeNull();
  });

  it("relationship peers are selectable from the inspector", async () => {
    renderView();
    await ready();
    fireEvent.click(rowFor("coordinator"));
    fireEvent.click(await screen.findByTestId("spatial-workspace-tab-relationships"));
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

  it("wide: selecting from a focused index row hands keyboard focus to the same seat in the switcher, which roves with arrows", async () => {
    renderView();
    await ready();
    const row = rowFor("builder1");
    row.focus();
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("builder1"));
    await waitFor(() => expect(document.activeElement).toBe(chipFor("builder1")));
    expect(chipFor("builder1").getAttribute("data-spatial-key")).toMatch(/\/agent\/n2$/);
    fireEvent.keyDown(chipFor("builder1"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(chipFor("reviewer"));
    fireEvent.keyDown(chipFor("reviewer"), { key: "Home" });
    expect(document.activeElement).toBe(chipFor("coordinator"));
  });

  it("the search field keeps its accessible name while the Clear button is shown", async () => {
    renderView();
    await ready();
    expect(screen.getByRole("searchbox", { name: "Search seats" })).toBe(screen.getByTestId("spatial-search"));
    fireEvent.change(screen.getByTestId("spatial-search"), { target: { value: "builder" } });
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(screen.getByRole("searchbox", { name: "Search seats" })).toBe(screen.getByTestId("spatial-search"));
    // Browsers fold an embedded control's name into a wrapping <label>
    // ("Search seats Clear search"); jsdom's accname does not, so pin the
    // field's own name source instead of the label's contents.
    const input = screen.getByTestId("spatial-search");
    expect(input.closest("label")?.contains(clear)).toBe(true);
    expect(input.getAttribute("aria-label")).toBe("Search seats");
  });

  it("closing the workspace by keyboard returns focus to that seat's index row, not the page", async () => {
    renderView();
    await ready();
    const row = rowFor("builder1");
    row.focus();
    fireEvent.click(row);
    await waitFor(() => expect(document.activeElement).toBe(chipFor("builder1")));
    const close = screen.getByTestId("spatial-workspace-close");
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId("spatial-workspace")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowFor("builder1")));
    expect(rowFor("builder1").getAttribute("data-spatial-key")).toMatch(/\/agent\/n2$/);
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

  it("search Enter selects the first match in the index's order, not the graph's node order", async () => {
    // A seat added to an earlier pod later (rig expand) comes after another
    // pod's seats in the served node list; the index still groups by pod.
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return json([{ id: "ra", name: "acme-build", nodeCount: 2 }]);
      if (url === "/api/rigs/ra/graph") return json({
        nodes: [
          { id: "pod-p1", type: "podGroup", data: { podId: "p1", podNamespace: "lead" } },
          { id: "pod-p2", type: "podGroup", data: { podId: "p2", podNamespace: "builders" } },
          { id: "n-late", type: "rigNode", parentId: "pod-p2", data: { logicalId: "builders.worker", status: "running" } },
          { id: "n-first", type: "rigNode", parentId: "pod-p1", data: { logicalId: "lead.worker", status: "running" } },
        ],
        edges: [],
      });
      return json({}, 404);
    });
    const { router } = renderView();
    await ready();
    const input = screen.getByTestId("spatial-search");
    fireEvent.change(input, { target: { value: "worker" } });
    const rows = within(screen.getByTestId("spatial-seat-index-compact")).getAllByTestId("spatial-agent-row");
    expect(rows[0]!.getAttribute("data-spatial-key")).toContain("/agent/n-first");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(router.history.location.href).toContain("n-first"));
    expect(controller.focus).toHaveBeenLastCalledWith(expect.stringContaining("/agent/n-first"));
  });

  // Navigation contract change: the selection is exact URL intent. A seat
  // removed on refresh drops out of the inspector (nothing stale is shown as
  // current) and the inspector says it is absent instead of silently
  // forgetting the selection or substituting another seat.
  it("selection follows current data: a seat removed on refresh drops out of the inspector", async () => {
    const { router } = renderView();
    await ready();
    fireEvent.click(rowFor("reviewer"));
    await screen.findByTestId("spatial-workspace");
    act(() => {
      qc.setQueryData(["rig", "ra", "graph", "local"], { ...graphA, nodes: graphA.nodes.filter((n) => n.id !== "n3") });
    });
    const notice = await screen.findByTestId("spatial-selection-notice");
    expect(notice.getAttribute("data-state")).toBe("absent");
    expect(notice.textContent).toContain("Graph node n3 is not in rig ra's current graph");
    expect(screen.queryByTestId("spatial-workspace")).toBeNull();
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
    await screen.findByTestId("spatial-workspace");
    act(() => {
      qc.setQueryData(["hosts"], { ownName: "me", selected: "other", hosts: [] });
    });
    expect(await screen.findByTestId("spatial-loading")).toBeTruthy();
    expect(screen.queryByTestId("spatial-agent-row")).toBeNull();
    expect(screen.queryByTestId("spatial-workspace")).toBeNull();
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
    // Bounded by a share of the small viewport (spatial.css), so the page
    // always keeps area outside the touch-capturing canvas to scroll by.
    expect(classesOf(screen.getByTestId("spatial-stage"))).toContain("spatial-stage--stacked");
    expect(classesOf(screen.getByTestId("spatial-inspector-region"))).not.toContain("overflow-auto");
    expect(classesOf(screen.getByTestId("spatial-index-region"))).toEqual(expect.arrayContaining(["max-h-[70vh]", "overflow-auto"]));
  });
});

// Phone stage: the view measures its own stage (no device detection) and a
// small stage (phone portrait, short landscape) gets the compact scene —
// collapsed camera controls and key, one-line labels — with the selected
// seat in a compact card OUTSIDE the scene whose Details disclose the full
// inspector. Every seat stays reachable through search and the index.
describe("SpatialTopologyView phone stage", () => {
  type Observed = { el: Element; cb: ResizeObserverCallback };
  let observed: Observed[] = [];
  const originalWidth = window.innerWidth;

  beforeEach(() => {
    observed = [];
    vi.stubGlobal("ResizeObserver", class {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.cb = cb; }
      observe(el: Element) { observed.push({ el, cb: this.cb }); }
      unobserve() {}
      disconnect() { observed = observed.filter((o) => o.cb !== this.cb); }
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalWidth });
    window.dispatchEvent(new Event("resize"));
  });

  function viewport(width: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  }
  function stageIs(width: number, height: number) {
    const stage = screen.getByTestId("spatial-stage");
    const entry = { target: stage, contentRect: { width, height } } as unknown as ResizeObserverEntry;
    act(() => { for (const o of observed.filter((o) => o.el === stage)) o.cb([entry], {} as ResizeObserver); });
  }

  it("a phone-sized stage gets compact labels, collapsed controls and key, and an empty-state hint outside the scene", async () => {
    viewport(430);
    renderView();
    await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
    stageIs(398, 480);
    expect(screen.getByTestId("stub-renderer").getAttribute("data-density")).toBe("compact");
    // Camera: Fit + More only; the rest is one tap away and refreshes label occluders.
    expect(screen.getByTestId("spatial-camera-fit")).toBeTruthy();
    expect(screen.queryByTestId("spatial-camera-zoom-in")).toBeNull();
    const more = screen.getByTestId("spatial-camera-more");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    controller.refreshOverlays.mockClear();
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    for (const id of ["iso", "top", "zoom-in", "zoom-out", "reset"]) expect(screen.getByTestId(`spatial-camera-${id}`)).toBeTruthy();
    expect(controller.refreshOverlays).toHaveBeenCalled();
    // Key collapsed; opening it shows shape markers with text, not colour alone.
    expect(screen.queryByTestId("spatial-legend")).toBeNull();
    fireEvent.click(screen.getByTestId("spatial-key-toggle"));
    const legend = screen.getByTestId("spatial-legend");
    expect(legend.textContent).toContain("needs input");
    expect(legend.querySelectorAll(".spatial-mark[data-tone]").length).toBeGreaterThanOrEqual(5);
    // No inspector wall under the stage: a one-line hint instead.
    expect(screen.getByTestId("spatial-selection-card-empty").textContent).toMatch(/tap a seat/i);
    expect(screen.queryByTestId("spatial-inspector-empty")).toBeNull();
  });

  it("a tapped seat docks the workspace under a smaller stage with a seat switcher; Details disclose the tabs; the URL keeps the exact node", async () => {
    viewport(430);
    const { router } = renderView();
    await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
    stageIs(398, 480);
    fireEvent.click(screen.getAllByTestId("stub-pick").find((b) => b.getAttribute("data-key")?.endsWith("/n3"))!);
    const workspace = await screen.findByTestId("spatial-workspace");
    expect(workspace.getAttribute("data-layout")).toBe("stacked");
    expect(screen.getByTestId("spatial-stage").className).toContain("spatial-stage--docked");
    expect(within(workspace).getByTestId("spatial-inspector-name").textContent).toBe("reviewer");
    expect(within(workspace).getByTestId("spatial-workspace-context").textContent).toContain("acme-build / builders");
    expect(within(workspace).getByTestId("spatial-inspector-status").textContent).toContain("identity mismatch");
    expect(within(workspace).getByTestId("spatial-open-seat").getAttribute("href")).toContain("/topology/seat/ra/builders.reviewer");
    expect(within(workspace).getByTestId("spatial-inspector-problems").textContent).toContain("pane runs zsh");
    // Progressive disclosure on a phone: the tabs are behind Details.
    const details = within(workspace).getByTestId("spatial-workspace-details-toggle");
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("spatial-workspace-tab-work")).toBeNull();
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("spatial-workspace-tab-work").getAttribute("aria-selected")).toBe("true");
    expect(router.state.location.search).toMatchObject({ selectedRig: "ra", selectedNode: "n3" });
    // Tap-to-switch: the strip lists every seat by exact key; switching keeps Details open.
    const chips = within(screen.getByTestId("spatial-seat-switcher")).getAllByTestId("spatial-seat-chip");
    expect(chips).toHaveLength(3);
    expect(chips.find((c) => c.getAttribute("aria-pressed") === "true")?.getAttribute("data-spatial-key")).toMatch(/\/agent\/n3$/);
    fireEvent.click(chips.find((c) => c.getAttribute("data-spatial-key")?.endsWith("/agent/n1"))!);
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("coordinator"));
    expect(router.state.location.search).toMatchObject({ selectedRig: "ra", selectedNode: "n1" });
    expect(screen.getByTestId("spatial-workspace-tab-work")).toBeTruthy();
    // Close returns the room to the scene.
    fireEvent.click(screen.getByTestId("spatial-workspace-close"));
    await waitFor(() => expect(screen.queryByTestId("spatial-workspace")).toBeNull());
    expect(screen.getByTestId("spatial-stage").className).not.toContain("spatial-stage--docked");
    expect(router.state.location.search).not.toHaveProperty("selectedNode");
  });

  it("explicit phone selection reveals the docked workspace once; restore, refresh, switcher and docked scene taps never scroll", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      // Initial URL restore of a selection: docks without moving the page.
      viewport(430);
      const restored = renderView({ kind: "host" }, { initialPath: "/topology?selectedRig=ra&selectedNode=n1" });
      await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
      stageIs(398, 480);
      await screen.findByTestId("spatial-workspace");
      act(() => { qc.setQueryData(["rig", "ra", "graph", "local"], { ...graphA }); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(scrolled).toEqual([]);
      restored.unmount();

      viewport(430);
      renderView();
      await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
      stageIs(398, 480);
      // Index row (below the workspace slot): reveal the dock and focus its heading.
      fireEvent.click(rowFor("reviewer"));
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0]).toBe(screen.getByTestId("spatial-dock"));
      expect(document.activeElement).toBe(screen.getByTestId("spatial-inspector-name"));
      // Switcher changes keep the anchor; a scene tap while docked keeps the scene.
      fireEvent.click(chipFor("coordinator"));
      await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("coordinator"));
      fireEvent.click(screen.getAllByTestId("stub-pick").find((b) => b.getAttribute("data-key")?.endsWith("/agent/n2"))!);
      await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("builder1"));
      // Typing and Enter in search never scroll.
      const input = screen.getByTestId("spatial-search");
      fireEvent.change(input, { target: { value: "reviewer" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("reviewer"));
      expect(scrolled).toHaveLength(1);
      // Close, then a scene tap docks again: that first dock is revealed.
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.click(screen.getByTestId("spatial-workspace-close"));
      await waitFor(() => expect(screen.queryByTestId("spatial-workspace")).toBeNull());
      fireEvent.click(screen.getAllByTestId("stub-pick").find((b) => b.getAttribute("data-key")?.endsWith("/agent/n1"))!);
      await waitFor(() => expect(scrolled).toHaveLength(2));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("re-picking the selected seat in the lower index reveals at once; a request consumed on wide never replays on rotation", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      // Phone: the seat is already docked (restored from the URL). Picking
      // that same seat again from the All seats index is explicit intent.
      viewport(430);
      const phone = renderView({ kind: "host" }, { initialPath: "/topology?selectedRig=ra&selectedNode=n1" });
      await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
      stageIs(398, 480);
      await screen.findByTestId("spatial-workspace");
      expect(scrolled).toHaveLength(0);
      fireEvent.click(screen.getByTestId("spatial-all-seats-toggle"));
      fireEvent.click(rowFor("coordinator"));
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0]).toBe(screen.getByTestId("spatial-dock"));
      expect(document.activeElement).toBe(screen.getByTestId("spatial-inspector-name"));
      phone.unmount();
      scrolled.length = 0;

      // Wide: the same explicit pick is consumed without scrolling; a later
      // rotation to the phone layout must not deliver it.
      viewport(1194);
      renderView({ kind: "host" }, { initialPath: "/topology?selectedRig=ra&selectedNode=n1" });
      await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
      stageIs(700, 500);
      await screen.findByTestId("spatial-workspace");
      fireEvent.click(screen.getByTestId("spatial-all-seats-toggle"));
      fireEvent.click(rowFor("coordinator"));
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      act(() => viewport(430));
      stageIs(398, 480);
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      // …nor does a later unrelated selection change reuse it.
      fireEvent.click(chipFor("builder1"));
      await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("builder1"));
      expect(scrolled).toHaveLength(0);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("rotation keeps the docked workspace and the exact selection across phone, landscape and tablet", async () => {
    viewport(430);
    renderView();
    await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
    stageIs(398, 480);
    fireEvent.click(screen.getAllByTestId("stub-pick").find((b) => b.getAttribute("data-key")?.endsWith("/n1"))!);
    const workspace = await screen.findByTestId("spatial-workspace");
    // Short landscape phone stage is still compact; same workspace element.
    viewport(932);
    stageIs(900, 300);
    expect(screen.getByTestId("stub-renderer").getAttribute("data-density")).toBe("compact");
    expect(screen.getByTestId("spatial-workspace")).toBe(workspace);
    // Tablet portrait: roomy stage and full camera column; still docked.
    viewport(834);
    stageIs(802, 660);
    expect(screen.getByTestId("stub-renderer").getAttribute("data-density")).toBe("full");
    expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("coordinator");
    expect(screen.getByTestId("spatial-camera-zoom-in")).toBeTruthy();
    expect(screen.getByTestId("spatial-legend")).toBeTruthy();
    viewport(430);
    stageIs(398, 480);
    expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("coordinator");
    expect(screen.getByTestId("stub-renderer").getAttribute("data-selected")).toMatch(/\/n1$/);
  });

  it("a squeezed stage in the wide layout uses compact labels but keeps the side inspector", async () => {
    viewport(1194);
    renderView();
    await screen.findByTestId("stub-renderer", {}, { timeout: 5000 });
    stageIs(520, 700);
    expect(screen.getByTestId("stub-renderer").getAttribute("data-density")).toBe("compact");
    fireEvent.click(screen.getAllByTestId("stub-pick").find((b) => b.getAttribute("data-key")?.endsWith("/n1"))!);
    await waitFor(() => expect(screen.getByTestId("spatial-inspector-name").textContent).toBe("coordinator"));
    expect(screen.queryByTestId("spatial-selection-card")).toBeNull();
  });
});
