// Project/workflow absolute times adopt the connected instance's configured
// `ui.timezone` through the shared DisplayTime provider, keep the exact served
// instant in `dateTime`, and fall back explicitly (invalid/missing setting,
// malformed or missing stamp). Relative ages and identities are unchanged.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { DisplayTimeProvider } from "../src/components/time/DisplayTime.js";
import { WorkflowInstancePage } from "../src/components/workflow/WorkflowInstancePage.js";
import { Timestamp } from "../src/components/project/catalog/evidence-ui.js";

const created = "2026-10-04T20:40:00.000Z";
const failedAt = "2026-10-04T20:51:23.609Z";
const closedAt = "2026-10-04 20:45:00"; // SQLite UTC form: still exact
const trace = {
  instance: { instanceId: "wf-a", workflowName: "release", workflowVersion: "1", createdBySession: "lead@rig", createdAt: created, status: "failed",
    currentFrontier: [], currentStepId: null, hopCount: 2, fallbackSynthesis: null, lastContinuationDecision: null, completedAt: failedAt,
    version: 3, resumeCount: 0, hopsBaseline: 0, deadline: { state: "healthy", evidence: null } },
  trail: [{ trailId: "t1", instanceId: "wf-a", stepId: "plan", stepRole: "owner", closedAt, closureReason: "handoff", closureEvidence: null,
    actorSession: "owner@rig", nextQitemId: null, priorQitemId: "q0" }],
  failures: [], frontier: [], boundaryObligations: [], unknowns: [],
};
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); vi.unstubAllGlobals(); });

function mount(timezone: { value: unknown } | null) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test.local");
    if (url.pathname === "/api/config") return Response.json({ settings: timezone ? { "ui.timezone": { ...timezone, source: "file", defaultValue: "America/Los_Angeles" } } : {} });
    if (url.pathname === "/api/workflow/wf-a/trace") return Response.json(trace);
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "connected", selected: "local", hosts: [] });
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/workflow/instance/$instanceId", component: () => (
        <>
          <WorkflowInstancePage instanceId="wf-a" />
          <Timestamp iso={failedAt} testId="catalog-stamp" />
          <Timestamp iso="2026-13-40T99:00:00Z" testId="catalog-bad" />
          <Timestamp iso={null} testId="catalog-none" />
        </>
      ) }),
      createRoute({ getParentRoute: () => root, path: "/workflows", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/specs/library/$entryId", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/workflow/instance/wf-a"] }),
  });
  render(<QueryClientProvider client={client}><DisplayTimeProvider><RouterProvider router={router} /></DisplayTimeProvider></QueryClientProvider>);
}
const time = (testId: string) => screen.getByTestId(testId);
const stampTime = () => screen.getByTestId("wf-inst-terminal-stamp").querySelector("time")!;

describe("project/workflow display time", () => {
  it("adopts a configured zone that differs from the browser default and keeps exact instants", async () => {
    mount({ value: "Asia/Tokyo" });
    await waitFor(() => expect(time("workflow-display-zone").getAttribute("data-state")).toBe("configured"));
    // The browser default renders differently; the page must not use it.
    expect(new Date(failedAt).toLocaleString()).not.toContain("05:51:23");
    expect(stampTime().textContent).toBe("2026-10-05 05:51:23 GMT+9");
    expect(stampTime().getAttribute("datetime")).toBe(failedAt);
    expect(time("wf-inst-created-at").textContent).toBe("2026-10-05 05:40:00 GMT+9");
    expect(screen.getByTestId("workflow-instance-page").textContent).toContain("2026-10-05 05:45:00 GMT+9");
    expect(time("catalog-stamp").textContent).toBe("2026-10-05 05:51:23 GMT+9");
    expect(time("catalog-stamp").getAttribute("datetime")).toBe(failedAt);
    expect(time("catalog-stamp").getAttribute("title")).toContain(failedAt);
    expect(time("catalog-bad").textContent).toBe("time unknown");
    expect(time("catalog-none").textContent).toBe("not recorded");
  });

  it("invalid configured zone: explicit fallback, exact instant kept", async () => {
    mount({ value: "Mars/Olympus" });
    await waitFor(() => expect(time("workflow-display-zone").getAttribute("data-state")).toBe("invalid"));
    expect(time("workflow-display-zone").textContent).toContain("Mars/Olympus");
    expect(stampTime().textContent).toBe("2026-10-04 13:51:23 PDT");
    expect(stampTime().getAttribute("datetime")).toBe(failedAt);
  });

  it("missing setting: explicit fallback zone", async () => {
    mount(null);
    await waitFor(() => expect(time("workflow-display-zone").getAttribute("data-state")).toBe("unavailable"));
    expect(time("catalog-stamp").textContent).toBe("2026-10-04 13:51:23 PDT");
  });
});
