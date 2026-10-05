// Project queue hydration source (gui-project-workflow-ui.md §5): queue rows
// are read from exactly the source the slice reads use, and only once a host
// read confirmed it. A remote source is an unsupported queue scope (no local
// GET; raw work IDs + disclosure), and an unknown source is never presumed
// local. Also the Workspace header's catalog entry point (§2).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SliceScopePage, WorkspaceScopePage } from "../src/components/project/ScopePages.js";

const fetchMock = vi.fn();
const HOST_A = { id: "vps-a", transport: "http", url: "http://vps-a.invalid:7433", selected: true, status: "reachable" };
let hosts: () => Promise<Response> | Response;

const queueItem = (qitemId: string) => ({
  qitemId, tsCreated: "2026-05-06T18:00:00Z", tsUpdated: "2026-05-06T18:00:00Z", sourceSession: "source@rig",
  destinationSession: "dest@rig", state: "in-progress", priority: "routine", tier: "mode2", tags: [], body: `Body for ${qitemId}`,
});
const detail = {
  name: "idea-ledger", missionId: null, slicePath: "/workspace/slices/idea-ledger", displayName: "Idea Ledger", railItem: null,
  status: "active", rawStatus: "active", qitemIds: ["qitem-A", "qitem-B"], commitRefs: [], lastActivityAt: "2026-05-06T18:00:00Z",
  workflowBinding: null, story: { events: [], phaseDefinitions: null },
  acceptance: { totalItems: 0, doneItems: 0, percentage: 0, items: [], closureCallout: null, currentStep: null },
  decisions: { rows: [] }, docs: { tree: [] }, tests: { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } },
  topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
};

beforeEach(() => {
  hosts = () => Response.json({ ownName: "fixture", selected: "local", hosts: [] });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/hosts") return hosts();
    if (url.startsWith("/api/slices/idea-ledger")) return Response.json(detail);
    if (url.startsWith("/api/queue/qitem-A")) return Response.json(queueItem("qitem-A"));
    if (url.startsWith("/api/queue/qitem-B")) return Response.json({ error: "boom" }, { status: 500 });
    if (url.startsWith("/api/slices")) return Response.json({ slices: [] });
    return Response.json([]);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => cleanup());

const queueGets = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/queue"));

function renderAt(path: string, routePath: string, Page: () => JSX.Element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: routePath, component: () => (
        <DrawerSelectionContext.Provider value={{ selection: null, setSelection: vi.fn() }}><Page /></DrawerSelectionContext.Provider>
      ) }),
      createRoute({ getParentRoute: () => root, path: "$", component: () => <div data-testid="other-route" /> }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
const openSliceQueue = async () => {
  renderAt("/project/slice/idea-ledger", "/project/slice/$sliceId", SliceScopePage);
  fireEvent.click(await screen.findByTestId("project-tab-queue"));
};

describe("slice queue source", () => {
  it("local confirmed: reads local queue rows, and a failed item shows its own error beside its raw ID", async () => {
    await openSliceQueue();
    await waitFor(() => expect(screen.getByTestId("slice-queue-trigger-qitem-A").textContent).toContain("Body for qitem-A"));
    await waitFor(() => expect(screen.getByTestId("queue-item-error-qitem-B").textContent).toContain("Queue detail unavailable"));
    expect(screen.getByTestId("slice-queue-trigger-qitem-B").textContent).toContain("qitem-B");
    expect(queueGets().sort()).toEqual(["/api/queue/qitem-A", "/api/queue/qitem-B"]);
    expect(screen.queryByTestId("queue-source-unsupported")).toBeNull();
  });

  it("remote confirmed: slice read from that host, zero local queue GETs, raw IDs with unsupported disclosure", async () => {
    hosts = () => Response.json({ ownName: "fixture", selected: "vps-a", hosts: [HOST_A] });
    await openSliceQueue();
    expect((await screen.findByTestId("queue-source-unsupported")).textContent)
      .toBe("Queue details are not available for remote host vps-a; showing work item IDs only.");
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("/api/slices/idea-ledger?host=vps-a");
    expect(screen.getByTestId("slice-queue-trigger-qitem-A").textContent).toContain("qitem-A");
    expect(screen.getByTestId("slice-queue-trigger-qitem-B").textContent).toContain("qitem-B");
    expect(screen.queryByTestId("queue-item-error-qitem-A")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(queueGets()).toEqual([]);
  });

  it("unconfirmed source (failed host read): never presumed local — no queue GET, IDs shown with a wait notice", async () => {
    hosts = () => Response.json({ error: "down" }, { status: 503 });
    await openSliceQueue();
    expect(await screen.findByTestId("queue-source-unconfirmed")).toBeTruthy();
    expect(screen.getByTestId("slice-queue-trigger-qitem-A").textContent).toContain("qitem-A");
    await new Promise((r) => setTimeout(r, 30));
    expect(queueGets()).toEqual([]);
  });
});

describe("workspace header and rollup", () => {
  it("offers the exact catalog chooser; the remote queue rollup discloses unsupported details without a local GET", async () => {
    hosts = () => Response.json({ ownName: "fixture", selected: "vps-a", hosts: [HOST_A] });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/hosts") return hosts();
      if (url.startsWith("/api/slices/idea-ledger")) return Response.json(detail);
      if (url.startsWith("/api/slices")) return Response.json({ filter: "all", totalCount: 1, slices: [{ name: "idea-ledger", displayName: "Idea Ledger", status: "active", rawStatus: "active", missionId: null, slicePath: "/w/idea-ledger", lastActivityAt: "2026-05-06T18:00:00Z", qitemCount: 2, hasProofPacket: false, railItem: null }] });
      if (url.startsWith("/api/queue")) return Response.json(queueItem("qitem-A"));
      return Response.json([]);
    });
    const router = renderAt("/project", "/project", WorkspaceScopePage);
    const link = await screen.findByTestId("workspace-open-catalog");
    expect(link.getAttribute("href")).toBe("/project/catalog");
    fireEvent.click(await screen.findByTestId("project-tab-queue"));
    expect(await screen.findByTestId("queue-source-unsupported")).toBeTruthy();
    expect((await screen.findByTestId("scope-queue-trigger-qitem-A")).textContent).toContain("qitem-A");
    await new Promise((r) => setTimeout(r, 30));
    expect(queueGets()).toEqual([]);
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/project/catalog"));
  });
});
