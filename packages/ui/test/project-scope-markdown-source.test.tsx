// Project scope README/PROGRESS inline Markdown carries the exact served
// source (gui-files-markdown-ui.md): relative links resolve against the served
// canonical path on the producing LOCAL instance and open the Files route;
// without a confirmed local selection nothing local is linked or read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SliceScopePage } from "../src/components/project/ScopePages.js";

const detail = {
  name: "idea-ledger", missionId: null, slicePath: "/ws/slices/idea-ledger", displayName: "Idea Ledger", railItem: null,
  status: "active", rawStatus: "active", qitemIds: [], commitRefs: [], lastActivityAt: "2026-05-06T18:00:00Z",
  workflowBinding: null, story: { events: [], phaseDefinitions: null },
  acceptance: { totalItems: 0, doneItems: 0, percentage: 0, items: [], closureCallout: null, currentStep: null },
  decisions: { rows: [] }, docs: { tree: [] }, tests: { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } },
  topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
};
const README = "# Idea\n\nSee [the notes](notes/plan.md) and [overview](#idea).\n";

const fetchMock = vi.fn();
let hostsSelected = "local";
beforeEach(() => {
  hostsSelected = "local";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/hosts") return Response.json({ ownName: "fixture", selected: hostsSelected, hosts: hostsSelected === "local" ? [] : [{ id: hostsSelected, transport: "http", url: "http://h.invalid", selected: true, status: "reachable" }] });
    if (url.startsWith("/api/slices/idea-ledger")) return Response.json(detail);
    if (url === "/api/files/roots") return Response.json({ roots: [{ name: "ws", path: "/ws" }] });
    if (url.startsWith("/api/files/read")) {
      // The README is a symlink: its canonical source lives elsewhere.
      return Response.json({ root: "ws", path: "slices/idea-ledger/README.md", absolutePath: "/ws/docs/canonical/README.md",
        resolvedPath: "docs/canonical/README.md", content: README, mtime: "2026-05-06T18:00:00Z", contentHash: "h", size: README.length });
    }
    return Response.json([]);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => cleanup());

function renderSlice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/project/slice/$sliceId", component: () => (
        <DrawerSelectionContext.Provider value={{ selection: null, setSelection: vi.fn() }}><SliceScopePage /></DrawerSelectionContext.Provider>
      ) }),
      createRoute({ getParentRoute: () => root, path: "$", component: () => <div data-testid="other-route" /> }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/project/slice/idea-ledger"] }),
  });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

describe("project scope Markdown source", () => {
  it("relative links resolve against the served canonical source on the local instance", async () => {
    renderSlice();
    fireEvent.click(await screen.findByTestId("project-tab-overview"));
    const link = await screen.findByText("the notes");
    expect(link.getAttribute("data-link-kind")).toBe("file");
    expect(link.getAttribute("data-target-root")).toBe("ws");
    expect(link.getAttribute("data-target-path")).toBe("docs/canonical/notes/plan.md");
    expect(link.getAttribute("href")).toMatch(/^\/files\?/);
    expect(new URLSearchParams(link.getAttribute("href")!.split("?")[1]).get("file")).toBe("docs/canonical/notes/plan.md");
    expect(screen.getByText("overview").getAttribute("href")).toBe("#idea");
  });

  it("a remote selection reads no local file and links nothing local", async () => {
    hostsSelected = "vps-a";
    renderSlice();
    fireEvent.click(await screen.findByTestId("project-tab-overview"));
    await screen.findByTestId("slice-overview-summary");
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/files"))).toEqual([]);
    expect(screen.queryByText("the notes")).toBeNull();
  });
});
