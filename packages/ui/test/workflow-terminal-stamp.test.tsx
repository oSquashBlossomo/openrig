// The served `completedAt` is a terminal timestamp whose meaning depends on
// the instance's current status. Older rows can retain a failure stamp after a
// resume (backend clear published in 45cb57f1, not backfilled), so the page
// must describe it by status: failed is never "completed", an active/waiting
// row's leftover stamp never implies completion, aborted/completed stay
// truthful, a missing stamp stays unknown, and the exact raw instant is kept.
// Reproduced service evidence: /private/tmp/openrig-workflow-browser-after-resume.json.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { WorkflowInstancePage } from "../src/components/workflow/WorkflowInstancePage.js";

const created = "2026-10-04T20:40:00.000Z";
const stamp = "2026-10-04T20:51:23.609Z"; // the exact retained stamp from the browser receipt
const instance = (over: Record<string, unknown>) => ({
  instanceId: "wf-a", workflowName: "release", workflowVersion: "1", createdBySession: "lead@rig", createdAt: created, status: "active",
  currentFrontier: [], currentStepId: null, hopCount: 2, fallbackSynthesis: null, lastContinuationDecision: null, completedAt: null,
  version: 3, resumeCount: 0, hopsBaseline: 0, deadline: { state: "healthy", evidence: null }, ...over,
});
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); vi.unstubAllGlobals(); });

async function show(over: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test.local");
    if (url.pathname === "/api/workflow/wf-a/trace") return Response.json({ instance: instance(over), trail: [], failures: [], frontier: [], boundaryObligations: [], unknowns: [] });
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "connected", selected: "local", hosts: [] });
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/workflow/instance/$instanceId", component: () => <WorkflowInstancePage instanceId="wf-a" /> }),
      createRoute({ getParentRoute: () => root, path: "/workflows", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/specs/library/$entryId", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/workflow/instance/wf-a"] }),
  });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return screen.findByTestId("wf-inst-provenance");
}
const stampEl = () => screen.getByTestId("wf-inst-terminal-stamp");

describe("status-aware terminal timestamp", () => {
  it("failed: labels the stamp as the failure time, never completed", async () => {
    const line = await show({ status: "failed", completedAt: stamp });
    expect(line.textContent).not.toMatch(/completed/i);
    expect(stampEl().getAttribute("data-kind")).toBe("failed");
    expect(stampEl().textContent).toMatch(/^failed /);
    expect(stampEl().querySelector("time")!.getAttribute("datetime")).toBe(stamp);
  });

  for (const status of ["active", "waiting"] as const) {
    it(`${status} with a stamp retained from an earlier failure: earlier terminal evidence, not completion`, async () => {
      const line = await show({ status, completedAt: stamp, resumeCount: 1, currentStepId: "left" });
      expect(line.textContent).not.toMatch(/completed/i);
      expect(stampEl().getAttribute("data-kind")).toBe("retained");
      expect(stampEl().textContent).toMatch(/earlier terminal stamp/i);
      expect(stampEl().textContent).toContain(`now ${status}`);
      expect(stampEl().querySelector("time")!.getAttribute("datetime")).toBe(stamp);
    });
  }

  it("completed: labels completion with the exact instant", async () => {
    await show({ status: "completed", completedAt: stamp });
    expect(stampEl().getAttribute("data-kind")).toBe("completed");
    expect(stampEl().textContent).toMatch(/^completed /);
    expect(stampEl().querySelector("time")!.getAttribute("datetime")).toBe(stamp);
  });

  it("aborted: labels the abort time", async () => {
    await show({ status: "aborted", completedAt: stamp, lastContinuationDecision: { action: "abort", actorSession: "ops@rig", reason: "stop" } });
    expect(stampEl().getAttribute("data-kind")).toBe("aborted");
    expect(stampEl().textContent).toMatch(/^aborted /);
    expect(screen.getByTestId("wf-inst-provenance").textContent).not.toMatch(/completed/i);
  });

  it("terminal status without a stamp: time stays unknown, nothing is synthesized", async () => {
    await show({ status: "failed", completedAt: null });
    expect(stampEl().getAttribute("data-kind")).toBe("failed");
    expect(stampEl().textContent).toMatch(/failed · time not recorded/);
    expect(stampEl().querySelector("time")).toBeNull();
  });

  it("active without a stamp: no terminal claim at all", async () => {
    await show({ status: "active", completedAt: null });
    expect(screen.queryByTestId("wf-inst-terminal-stamp")).toBeNull();
  });
});
