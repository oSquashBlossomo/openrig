// Real lazy renderer + real three.js under jsdom: jsdom has no WebGL, so the
// WebGLRenderer constructor fails exactly like a GPU-less browser. The view
// must fall back to a readable, selectable topology — never a blank stage.

import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import SpatialTopologyView, { type SpatialRendererLoader } from "../src/components/topology/spatial/SpatialTopologyView.js";
import type { SpatialRendererProps } from "../src/components/topology/spatial/SpatialRenderer.js";

const graph = {
  nodes: [
    { id: "pod-p", type: "podGroup", data: { podNamespace: "core" } },
    { id: "a", type: "rigNode", parentId: "pod-p", data: { logicalId: "core.alpha", status: "running", terminalActive: true } },
    { id: "b", type: "rigNode", parentId: "pod-p", data: { logicalId: "core.bravo", status: "running", terminalActive: false } },
  ],
  edges: [{ id: "e", source: "a", target: "b", label: "delegates_to" }],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderView(loadRenderer?: SpatialRendererLoader) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  qc.setQueryData(["hosts"], { ownName: "me", selected: "local", hosts: [] });
  const root = createRootRoute({ component: () => <QueryClientProvider client={qc}><Outlet /></QueryClientProvider> });
  const view = createRoute({ getParentRoute: () => root, path: "/topology", component: () => <SpatialTopologyView scope={{ kind: "host" }} loadRenderer={loadRenderer} /> });
  const any = createRoute({ getParentRoute: () => root, path: "$", component: () => null });
  const router = createRouter({ routeTree: root.addChildren([view, any]), history: createMemoryHistory({ initialEntries: ["/topology"] }) });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (url === "/api/rigs/summary") return json([{ id: "r", name: "rig-one", nodeCount: 2 }]);
    if (url === "/api/rigs/r/graph") return json(graph);
    return json({}, 404);
  }) as unknown as typeof fetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("SpatialTopologyView without WebGL", () => {
  it("falls back to an explained, usable seat index with retry and list options", async () => {
    renderView();
    const fallback = await screen.findByTestId("spatial-fallback", {}, { timeout: 8000 });
    expect(fallback.textContent).toContain("WebGL isn't available");
    expect(screen.queryByTestId("spatial-canvas")).toBeNull();
    // Camera HUD is not offered without a renderer.
    expect(screen.queryByTestId("spatial-camera-hud")).toBeNull();

    // The same topology stays readable and selectable.
    const index = screen.getByTestId("spatial-seat-index-compact");
    const rows = within(index).getAllByTestId("spatial-agent-row");
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]!);
    expect((await screen.findByTestId("spatial-inspector-name")).textContent).toBe("bravo");
    expect((screen.getByTestId("spatial-focus-seat") as HTMLButtonElement).disabled).toBe(true);

    // Retry re-attempts (and, still without WebGL, falls back again).
    fireEvent.click(screen.getByTestId("spatial-retry-renderer"));
    await waitFor(() => expect(screen.getByTestId("spatial-fallback")).toBeTruthy());

    fireEvent.click(within(screen.getByTestId("spatial-fallback")).getByText(/List view/));
    expect(screen.getByTestId("spatial-seat-index-table")).toBeTruthy();
    expect(screen.queryByTestId("spatial-fallback")).toBeNull();
  }, 15000);
});

// A stand-in renderer chunk: proves the view mounted a real renderer module
// with the current model, and reports ready like the three.js renderer does.
function StubRenderer({ model, onReady }: SpatialRendererProps) {
  useEffect(() => onReady(), [onReady]);
  return <div data-testid="stub-renderer" data-seats={model.counts.agents} />;
}

describe("SpatialTopologyView renderer chunk recovery", () => {
  it("re-imports the renderer chunk on Retry after a transient import failure", async () => {
    let available = false;
    const loader = vi.fn<SpatialRendererLoader>(async () => {
      if (!available) throw new TypeError("Failed to fetch dynamically imported module: /assets/SpatialRenderer.js");
      return { default: StubRenderer };
    });
    renderView(loader);

    const fallback = await screen.findByTestId("spatial-fallback", {}, { timeout: 8000 });
    await waitFor(() => expect(fallback.getAttribute("data-failure")).toBe("load-error"));
    expect(fallback.textContent).toContain("could not be downloaded");
    expect(loader).toHaveBeenCalledTimes(1);
    // The topology stays usable while the chunk is unavailable.
    expect(within(screen.getByTestId("spatial-seat-index-compact")).getAllByTestId("spatial-agent-row")).toHaveLength(2);

    available = true;
    fireEvent.click(screen.getByTestId("spatial-retry-renderer"));

    const renderer = await screen.findByTestId("stub-renderer");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(renderer.getAttribute("data-seats")).toBe("2");
    expect(screen.queryByTestId("spatial-fallback")).toBeNull();
    await waitFor(() => expect((screen.getByTestId("spatial-camera-fit") as HTMLButtonElement).disabled).toBe(false));
  }, 15000);

  it("keeps a loaded chunk and only re-runs the renderer when Retry follows a GPU failure", async () => {
    let mounts = 0;
    function FlakyGpuRenderer(props: SpatialRendererProps) {
      const { onFailure } = props;
      useEffect(() => {
        mounts += 1;
        if (mounts === 1) onFailure("unsupported");
      }, [onFailure]);
      return <StubRenderer {...props} />;
    }
    const loader = vi.fn<SpatialRendererLoader>(async () => ({ default: FlakyGpuRenderer }));
    renderView(loader);

    const fallback = await screen.findByTestId("spatial-fallback", {}, { timeout: 8000 });
    expect(fallback.getAttribute("data-failure")).toBe("unsupported");

    fireEvent.click(screen.getByTestId("spatial-retry-renderer"));
    expect(await screen.findByTestId("stub-renderer")).toBeTruthy();
    expect(mounts).toBe(2);
    expect(loader).toHaveBeenCalledTimes(1);
  }, 15000);
});
