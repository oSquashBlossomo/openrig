// Topology scope integration for the 3D view-mode + the graph Explorer inset.
//
// Inset regression (reproduced in-browser by root): in graph-overlay mode the
// AppShell sets <main> padding to 0 so the canvas runs under the vellum
// Explorer, and React Flow fit the FULL canvas — nodes landed beneath the
// 288px Explorer and Fit View could not reveal them. The graph frame must now
// start at --header-anchor-offset (the Explorer's right edge), which tracks
// expanded (21rem) / collapsed (3rem) / narrow (0) states. jsdom has no layout
// engine, so this asserts the wiring between the frame and the shell variable;
// root verifies pixels in the browser.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryHistory, RouterProvider, createRouter, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { AppShell } from "../src/components/AppShell.js";
import { HostScopePage, PodScopePage, RigScopePage } from "../src/components/topology/ScopePages.js";
import { HOST_SCOPE_TABS, RIG_POD_SCOPE_TABS } from "../src/components/topology/TopologyViewModeTabs.js";

const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  globalThis.fetch = mockFetch;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    // Topology bodies mount only behind a successfully read source host.
    if (url === "/api/hosts") return new Response(JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }));
    if (url === "/api/rigs/summary") return new Response(JSON.stringify([{ id: "abc-rig", name: "acme", nodeCount: 1 }]));
    if (url === "/api/rigs/abc-rig/graph") {
      return new Response(JSON.stringify({
        nodes: [
          { id: "pod-p", type: "podGroup", data: { podNamespace: "core" } },
          { id: "n", type: "rigNode", parentId: "pod-p", data: { logicalId: "core.seat", status: "running", terminalActive: true } },
        ],
        edges: [],
      }));
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
});

function renderAt(initialPath: string, width = 1440) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width, writable: true });
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
    createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { ...render(<RouterProvider router={router} />), router };
}

function mainEl(container: HTMLElement) {
  return container.querySelector("[data-testid='content-area']") as HTMLElement;
}

describe("3D view-mode tab", () => {
  it("is discoverable on host and rig/pod scopes, second after Graph; Graph stays the default", () => {
    // Health (scoped canonical Health) follows Terminal; Overview stays last.
    expect(HOST_SCOPE_TABS.map((t) => t.id)).toEqual(["graph", "spatial", "table", "terminal", "health"]);
    expect(RIG_POD_SCOPE_TABS.map((t) => t.id)).toEqual(["graph", "spatial", "table", "terminal", "health", "overview"]);
    expect(HOST_SCOPE_TABS.find((t) => t.id === "spatial")?.label).toBe("3D");
  });

  it.each([
    ["/topology", "topology-host"],
    ["/topology/rig/abc-rig", "topology-rig"],
    ["/topology/pod/abc-rig/core", "topology-pod"],
  ])("at %s the 3D tab switches in place, mounts the spatial view opaque (never under the Explorer)", async (path, prefix) => {
    const { container, router } = renderAt(path);
    // Re-query: the rig tab bar remounts once its trailing launcher slot resolves.
    const tab = () => container.querySelector(`[data-testid='${prefix}-tab-spatial']`) as HTMLElement | null;
    await waitFor(() => expect(tab()).toBeTruthy(), { timeout: 5000 });
    expect(container.querySelector(`[data-testid='${prefix}-tab-graph']`)?.getAttribute("data-active")).toBe("true");
    await waitFor(() => {
      if (tab()?.getAttribute("data-active") !== "true") fireEvent.click(tab()!);
      expect(tab()?.getAttribute("data-active")).toBe("true");
    });
    expect(router.history.location.pathname).toBe(path);
    await waitFor(() => expect(container.querySelector("[data-testid='spatial-topology-view']")).toBeTruthy(), { timeout: 8000 });
    expect(container.querySelector("[data-testid='topology-graph-frame']")).toBeNull();
    // Opaque layout: <main> is padded past the Explorer; nothing is drawn beneath it.
    expect(mainEl(container).getAttribute("data-explorer-mode")).toBe("opaque");
    expect(mainEl(container).style.paddingLeft).toBe("var(--workspace-left-offset, 0px)");
    expect(mainEl(container).style.getPropertyValue("--workspace-left-offset")).toBe("21rem");
  }, 15000);
});

describe("Graph Explorer inset (fit/draw bounds exclude the Explorer)", () => {
  it.each([["/topology"], ["/topology/rig/abc-rig"], ["/topology/pod/abc-rig/core"]])(
    "%s: graph frame starts at the Explorer edge and tracks expand/collapse",
    async (path) => {
      const { container } = renderAt(path);
      const frame = await waitFor(() => {
        const el = container.querySelector("[data-testid='topology-graph-frame']") as HTMLElement | null;
        expect(el).toBeTruthy();
        return el!;
      }, { timeout: 5000 });
      const main = mainEl(container);
      await waitFor(() => expect(main.getAttribute("data-explorer-mode")).toBe("overlay"));
      // Overlay: <main> is NOT padded (canvas would run under the Explorer)…
      expect(main.style.getPropertyValue("--workspace-left-offset")).toBe("0rem");
      // …so the frame itself must start past the expanded Explorer.
      expect(frame.style.marginLeft).toBe("var(--header-anchor-offset, 0px)");
      expect(main.style.getPropertyValue("--header-anchor-offset")).toBe("21rem");

      const toggle = container.querySelector("[data-testid='explorer-edge-toggle']") as HTMLElement | null;
      expect(toggle).toBeTruthy();
      fireEvent.click(toggle!);
      await waitFor(() => expect(main.style.getPropertyValue("--header-anchor-offset")).toBe("3rem"));
      expect((container.querySelector("[data-testid='topology-graph-frame']") as HTMLElement).style.marginLeft)
        .toBe("var(--header-anchor-offset, 0px)");
    },
    15000,
  );

  it("narrow viewports carry no Explorer inset (phone graph frame, offset 0)", async () => {
    const { container } = renderAt("/topology/rig/abc-rig", 800);
    await waitFor(() => expect(container.querySelector("[data-testid='topology-phone-graph-frame']")).toBeTruthy(), { timeout: 5000 });
    expect(container.querySelector("[data-testid='topology-graph-frame']")).toBeNull();
    expect(mainEl(container).style.getPropertyValue("--header-anchor-offset")).toBe("0rem");
  }, 15000);
});
