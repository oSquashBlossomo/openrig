// The workflow liveness feed must be wired into the SHIPPED app lifetime, not
// only exercised by hook tests. This mounts the actual AppProviders (the root
// route's provider stack + AppShell) in StrictMode, as main.tsx does, with a
// real workflow consumer (WorkflowInstancesBand → useWorkflowInstances). Only
// the network edges are faked: fetch and a recording EventSource.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { AppProviders } from "../src/routes.js";
import { WorkflowInstancesBand } from "../src/components/workflow/WorkflowInstancesBand.js";
import { WORKFLOW_SSE_URL } from "../src/hooks/useWorkflowSse.js";
import { operatorTwinBody } from "../twin/operator-fixtures.js";

class RecordingEventSource {
  static all: RecordingEventSource[] = [];
  closed = false;
  private handlers = new Map<string, Array<(event: { data?: string }) => void>>();
  constructor(readonly url: string) { RecordingEventSource.all.push(this); }
  addEventListener(name: string, fn: (event: { data?: string }) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
  removeEventListener(name: string, fn: (event: { data?: string }) => void) { this.handlers.set(name, (this.handlers.get(name) ?? []).filter((h) => h !== fn)); }
  close() { this.closed = true; }
  emit(name: string, data?: unknown) { for (const fn of this.handlers.get(name) ?? []) fn(data === undefined ? {} : { data: JSON.stringify(data) }); }
}

const workflowStreams = () => RecordingEventSource.all.filter((es) => es.url === WORKFLOW_SSE_URL);
const openWorkflowStreams = () => workflowStreams().filter((es) => !es.closed);
let calls: Array<{ path: string; method: string }>;
const workflowListReads = () => calls.filter((c) => c.path === "/api/workflow/list" && c.method === "GET");
const workflowWrites = () => calls.filter((c) => c.path.startsWith("/api/workflow") && c.method !== "GET");

beforeEach(() => {
  RecordingEventSource.all = [];
  calls = [];
  vi.stubGlobal("EventSource", RecordingEventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://local");
    calls.push({ path: url.pathname, method: (init?.method ?? "GET").toUpperCase() });
    if (url.pathname === "/api/workflow/list") return Response.json([]);
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "demo-studio", selected: "local", hosts: [] });
    const served = operatorTwinBody(url.pathname, url.searchParams);
    return served ? Response.json(served.body, { status: served.status }) : Response.json([], { status: 200 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountApp(initialPath = "/workflows") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <AppProviders><Outlet /></AppProviders>
      </QueryClientProvider>
    ),
  });
  const workflows = createRoute({ getParentRoute: () => root, path: "/workflows", component: () => <WorkflowInstancesBand quietWhenEmpty={false} testId="band" /> });
  const other = createRoute({ getParentRoute: () => root, path: "/elsewhere", component: () => <p data-testid="elsewhere">elsewhere</p> });
  const router = createRouter({ routeTree: root.addChildren([workflows, other]), history: createMemoryHistory({ initialEntries: [initialPath] }) });
  const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);
  return { ...view, router, qc };
}

async function settle(ms = 220) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

describe("workflow SSE in the shipped app lifetime (AppProviders → AppShell)", () => {
  it("the app shell opens exactly one live /api/workflow/sse stream", async () => {
    const { qc } = mountApp();
    await waitFor(() => expect(workflowListReads().length).toBeGreaterThan(0));
    expect(openWorkflowStreams()).toHaveLength(1);
    expect(openWorkflowStreams()[0]!.url).toBe("/api/workflow/sse");
    qc.clear();
  });

  it("first open, reconnect and a workflow event each re-read the active workflow query once, with no write", async () => {
    const { qc } = mountApp();
    await waitFor(() => expect(workflowListReads().length).toBeGreaterThan(0));
    await settle(); // StrictMode's double mount may issue more than one initial read.
    const baseline = workflowListReads().length;
    expect(openWorkflowStreams()).toHaveLength(1);
    const stream = () => openWorkflowStreams()[0]!;

    act(() => stream().emit("open"));
    await settle();
    expect(workflowListReads()).toHaveLength(baseline + 1);

    // Browser reconnect: open fires again (twice back to back) → one read.
    act(() => { stream().emit("open"); stream().emit("open"); });
    await settle();
    expect(workflowListReads()).toHaveLength(baseline + 2);

    act(() => stream().emit("message", { type: "workflow.step_closed", instanceId: "wf-one" }));
    await settle();
    expect(workflowListReads()).toHaveLength(baseline + 3);

    // Heartbeats / non-JSON frames stay ignored.
    act(() => stream().emit("message"));
    await settle();
    expect(workflowListReads()).toHaveLength(baseline + 3);

    expect(workflowWrites()).toEqual([]);
    qc.clear();
  });

  it("route changes keep the single stream; unmounting the app closes it", async () => {
    const { router, unmount, qc } = mountApp();
    await waitFor(() => expect(openWorkflowStreams()).toHaveLength(1));
    const first = openWorkflowStreams()[0]!;
    const constructed = workflowStreams().length;

    await act(async () => { await router.navigate({ to: "/elsewhere" }); });
    await act(async () => { await router.navigate({ to: "/workflows" }); });
    await act(async () => { await router.navigate({ to: "/elsewhere" }); });
    expect(openWorkflowStreams()).toEqual([first]);
    expect(workflowStreams()).toHaveLength(constructed);

    unmount();
    expect(first.closed).toBe(true);
    expect(openWorkflowStreams()).toHaveLength(0);
    qc.clear();
  });
});
