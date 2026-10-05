// WorkflowsPage spec links over the connected instance's workflow catalog.
// A warm catalog whose refresh fails keeps its exact matches only as an
// explicitly stale observation dated by its original successful read; a cold
// failure, a pending read and a successful empty catalog stay distinct; the
// selected topology host never supplies the catalog. Observer updates are
// awaited (React Query notifies on its scheduled tick).

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { WorkflowsPage } from "../src/components/workflow/WorkflowsPage.js";

const at = "2026-10-04T12:00:00Z";
const instance = (instanceId: string, workflowName: string, workflowVersion: string) => ({
  instanceId, workflowName, workflowVersion, createdBySession: "lead@rig", createdAt: at, status: "active", currentFrontier: [], currentStepId: null,
  hopCount: 1, fallbackSynthesis: null, lastContinuationDecision: null, completedAt: null, version: 1, resumeCount: 0, hopsBaseline: 0,
  deadline: { state: "healthy", evidence: null },
});
const entry = { id: "workflow:@WyJyZWxlYXNlIiwiMToyIl0", kind: "workflow", name: "release", version: "1:2", sourceType: "user_file",
  sourcePath: "/specs/release.yaml", relativePath: "release.yaml", updatedAt: at };

type Catalog = "ok" | "empty" | "503" | "hang";
const state: { catalog: Catalog; selected: string } = { catalog: "ok", selected: "local" };
const requests: string[] = [];
const clients: QueryClient[] = [];

function serve() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test.local");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "connected", selected: state.selected, hosts: [] });
    if (url.pathname === "/api/workflow/list") return Response.json([instance("wf-a", "release", "1:2")]);
    if (url.pathname === "/api/workflow/specs") return Response.json({ specs: [] });
    if (url.pathname === "/api/specs/library") {
      if (state.catalog === "hang") return new Promise<Response>(() => {});
      if (state.catalog === "503") return Response.json({ error: "service_unavailable" }, { status: 503 });
      return Response.json(state.catalog === "empty" ? [] : [entry]);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/workflows", component: WorkflowsPage }),
      createRoute({ getParentRoute: () => root, path: "/specs/library/$entryId", component: () => <div data-testid="library-destination" /> }),
      createRoute({ getParentRoute: () => root, path: "/specs", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/workflow/instance/$instanceId", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/workflows"] }),
  });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { client, router };
}
const catalogKey = ["spec-library", "workflow", "local"];
const link = () => screen.getByTestId("workflows-group-spec-release") as HTMLButtonElement;
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); requests.length = 0; state.catalog = "ok"; state.selected = "local"; vi.unstubAllGlobals(); });

describe("WorkflowsPage connected catalog freshness", () => {
  it("discloses a failed refresh of a warm catalog, keeps exact matches dated by the original success, and recovers", async () => {
    serve();
    const { client, router } = mount();
    await waitFor(() => expect(link().getAttribute("data-spec")).toBe("matched"));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByTestId("workflows-spec-catalog-stale")).toBeNull();
    const query = client.getQueryCache().find({ queryKey: catalogKey, exact: true })!;
    const succeededAt = new Date(query.state.dataUpdatedAt).toISOString();
    expect(screen.getByTestId("workflows-spec-catalog-read-at").getAttribute("datetime")).toBe(succeededAt);

    await pause();
    state.catalog = "503";
    await act(async () => { await client.refetchQueries({ queryKey: catalogKey, exact: true }); });
    expect(query.state.status).toBe("error");
    expect(query.state.data).toBeDefined();
    const notice = await screen.findByTestId("workflows-spec-catalog-stale");
    expect(notice.textContent).toMatch(/library.*refresh failed/i);
    expect(notice.textContent).toContain("HTTP 503");
    expect(query.state.errorUpdatedAt).toBeGreaterThan(query.state.dataUpdatedAt);
    expect(screen.getByTestId("workflows-spec-catalog-read-at").getAttribute("datetime")).toBe(succeededAt);
    // The retained exact link stays usable, explicitly stale, with its exact served ID.
    expect(link().getAttribute("data-spec")).toBe("matched");
    expect(link().getAttribute("data-stale")).toBe("true");
    expect(link().title).toContain("last successful");
    fireEvent.click(link());
    await screen.findByTestId("library-destination");
    expect(router.state.location.publicHref).toBe(`/specs/library/${encodeURIComponent(entry.id)}?source=local`);
    act(() => router.history.back());
    await screen.findByTestId("workflows-spec-catalog-stale");

    await pause();
    state.catalog = "ok";
    fireEvent.click(screen.getByTestId("workflows-spec-catalog-retry"));
    await waitFor(() => expect(screen.queryByTestId("workflows-spec-catalog-stale")).toBeNull());
    expect(link().getAttribute("data-stale")).toBe("false");
    expect(Date.parse(screen.getByTestId("workflows-spec-catalog-read-at").getAttribute("datetime")!)).toBeGreaterThan(Date.parse(succeededAt));
    expect(requests.filter((r) => !r.startsWith("GET "))).toEqual([]);
  });

  it("cold unavailable catalog: explicit failure, disabled links, no stale claim", async () => {
    state.catalog = "503";
    serve();
    mount();
    expect((await screen.findByTestId("workflows-spec-catalog-unavailable")).textContent).toContain("HTTP 503");
    expect(screen.queryByTestId("workflows-spec-catalog-stale")).toBeNull();
    await waitFor(() => expect(link().getAttribute("data-spec")).toBe("unavailable"));
    expect(link().disabled).toBe(true);
    expect(screen.queryByTestId("workflows-spec-catalog-read-at")).toBeNull();
  });

  it("successful empty catalog: absent links, read time shown, no failure notice", async () => {
    state.catalog = "empty";
    serve();
    mount();
    await waitFor(() => expect(link().getAttribute("data-spec")).toBe("absent"));
    expect(link().disabled).toBe(true);
    expect(screen.getByTestId("workflows-spec-catalog-read-at").getAttribute("datetime")).toBeTruthy();
    expect(screen.queryByTestId("workflows-spec-catalog-stale")).toBeNull();
    expect(screen.queryByTestId("workflows-spec-catalog-unavailable")).toBeNull();
  });

  it("pending catalog: links wait, no read time or failure is claimed", async () => {
    state.catalog = "hang";
    serve();
    mount();
    await waitFor(() => expect(link().getAttribute("data-spec")).toBe("pending"));
    expect(screen.queryByTestId("workflows-spec-catalog-read-at")).toBeNull();
    expect(screen.queryByTestId("workflows-spec-catalog-unavailable")).toBeNull();
  });

  it("reads the catalog from the connected instance while topology selects a remote host", async () => {
    state.selected = "far";
    serve();
    mount();
    await waitFor(() => expect(link().getAttribute("data-spec")).toBe("matched"));
    expect(requests.filter((r) => r.includes("/api/specs/library")).every((r) => !r.includes("host="))).toBe(true);
  });
});
