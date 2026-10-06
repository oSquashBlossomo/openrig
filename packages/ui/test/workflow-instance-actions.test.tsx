// Workflow instance page: exact-occurrence Resume, abort and read states over
// stubbed workflow HTTP, rendered inside an actual router so route-param
// changes behave as they do in the app. No action is ever replayed or
// retargeted; known rejections, HTTP 500 after commit and lost responses are
// shown as the distinct outcomes they are.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from "@tanstack/react-router";
import { WorkflowInstancePage } from "../src/components/workflow/WorkflowInstancePage.js";
import { WorkflowsPage } from "../src/components/workflow/WorkflowsPage.js";
import { FailureOccurrenceChooser } from "../src/components/workflow/FailureOccurrenceChooser.js";

const at = "2026-10-04T12:00:00Z";
const failure = (instanceId: string, id: string, over: Record<string, unknown> = {}) => ({
  occurrenceId: id, instanceId, failedPacketId: `packet-${id}`, stepId: `step-${id}`, branchDrive: 1, hopCount: 3, hopsBaseline: 2,
  failureReason: `reason ${id}`, status: "unresolved", redrivePacketId: null, resumeDecision: null, failedAt: at, resolvedAt: null, targetedAction: "resume", ...over,
});
const instance = (instanceId: string, over: Record<string, unknown> = {}) => ({
  instanceId, workflowName: "release", workflowVersion: "1", createdBySession: "lead@rig", createdAt: at, status: "failed", currentFrontier: [],
  currentStepId: null, hopCount: 3, fallbackSynthesis: null, lastContinuationDecision: null, completedAt: null, version: 4, resumeCount: 0, hopsBaseline: 2,
  deadline: { state: "healthy", evidence: null }, ...over,
});
type Trace = { instance: ReturnType<typeof instance>; trail: unknown[]; failures?: unknown[]; frontier?: unknown[]; boundaryObligations?: unknown[]; unknowns?: string[] };
const trace = (inst: ReturnType<typeof instance>, failures: unknown[], over: Partial<Trace> = {}): Trace => ({ instance: inst, trail: [], failures, frontier: [], boundaryObligations: [], unknowns: [], ...over });
const current = { status: "current", adopted: true, boundDigest: "d1", proposedDigest: "d1", boundVersion: "1", proposedVersion: "1", compatible: true, changes: [], reasons: [],
  composition: { mode: "extend", explanation: "Running plan matches its sources.", boundSlices: [], executableSteps: [] }, nextAction: "nothing to apply", expectedVersion: 4 };

type PostHandler = (body: Record<string, unknown>, id: string) => Response | Promise<Response>;
const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
const clients: QueryClient[] = [];
let traces: Record<string, Trace | Response> = {};
let onPost: Record<string, PostHandler> = {};

function serve() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test.local");
    const m = url.pathname.match(/^\/api\/workflow\/([^/]+)(?:\/(\w+))?$/);
    if (init?.method === "POST" && m) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url: url.pathname, body });
      return onPost[m[2]!]!(body, decodeURIComponent(m[1]!));
    }
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "studio", selected: "local", hosts: [] });
    if (url.pathname === "/api/workflow/list") return Response.json(Object.values(traces).filter((t): t is Trace => !(t instanceof Response)).map((t) => t.instance));
    if (m && m[2] === "trace") {
      const t = traces[decodeURIComponent(m[1]!)];
      return t instanceof Response ? t.clone() : t ? Response.json(t) : Response.json({ error: "instance_not_found" }, { status: 404 });
    }
    if (m && m[2] === "revision") return Response.json(current);
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const root = createRootRoute({ component: () => <Outlet /> });
  function Instance() {
    const { instanceId } = useParams({ from: "/workflow/instance/$instanceId" });
    return <WorkflowInstancePage instanceId={instanceId} />;
  }
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/workflow/instance/$instanceId", component: Instance }),
      createRoute({ getParentRoute: () => root, path: "/workflows", component: WorkflowsPage }),
      createRoute({ getParentRoute: () => root, path: "/specs/library/$entryId", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/specs", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/remote", component: () => (
        <FailureOccurrenceChooser instance={instance("wf-a") as never} failures={[failure("wf-a", "f1")] as never} scope={{ kind: "remote-instance", hostId: "far" }} />
      ) }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
const go = async (router: ReturnType<typeof mount>, id: string) => {
  await act(() => router.navigate({ to: "/workflow/instance/$instanceId", params: { instanceId: id } }));
  await waitFor(() => expect(screen.getByTestId("workflow-instance-page").getAttribute("data-instance")).toBe(id));
};
const resumed = (id: string) => Response.json({ instanceId: id, stepId: "step-f2", newPacketId: "redrive-9", ownerSession: "owner@rig", resumeCount: 1, exceptionItemsClosed: 1 });

afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); posts.length = 0; traces = {}; onPost = {}; vi.unstubAllGlobals(); });

describe("occurrence-specific Resume", () => {
  it("preselects nothing among several unresolved failures and sends exactly the chosen occurrence, actor and decision bytes", async () => {
    traces = { "wf-a": trace(instance("wf-a"), [failure("wf-a", "f1"), failure("wf-a", "f2"), failure("wf-a", "f0", { status: "resolved", redrivePacketId: "old-redrive", resumeDecision: "earlier", resolvedAt: at, targetedAction: "none" })]) };
    onPost = { resume: (_, id) => resumed(id) };
    serve();
    mount("/workflow/instance/wf-a");
    await screen.findByTestId("workflow-failures");
    expect(screen.getByTestId("workflow-failures-state").textContent).toBe("multiple");
    expect(screen.getByTestId("workflow-exception-failures-link").textContent).toContain("2 unresolved");
    expect((screen.getByTestId("workflow-resume") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("workflow-occurrence-choose-f0")).toBeNull();
    for (const id of ["f1", "f2"]) expect((screen.getByTestId(`workflow-occurrence-choose-${id}`) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId("workflow-occurrence-choose-f2"));
    fireEvent.change(screen.getByTestId("workflow-resume-actor"), { target: { value: "ops@rig" } });
    fireEvent.change(screen.getByTestId("workflow-resume-decision"), { target: { value: "  keep\nexact bytes " } });
    fireEvent.click(screen.getByTestId("workflow-resume"));
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByTestId("workflow-resume-confirm-send"));
    await screen.findByTestId("workflow-resume-succeeded");
    expect(posts).toEqual([{ url: "/api/workflow/wf-a/resume", body: { occurrenceId: "f2", actorSession: "ops@rig", decision: "  keep\nexact bytes " } }]);
    expect(screen.getByTestId("workflow-resume-succeeded").textContent).toContain("not an accepted outcome");
  });

  it("shows a known wrong-occurrence rejection without retargeting or resending", async () => {
    traces = { "wf-a": trace(instance("wf-a"), [failure("wf-a", "f1"), failure("wf-a", "f2")]) };
    onPost = { resume: () => {
      traces["wf-a"] = trace(instance("wf-a"), [failure("wf-a", "f1", { status: "resolved", redrivePacketId: "other-redrive", resumeDecision: "someone else", resolvedAt: at, targetedAction: "none" }), failure("wf-a", "f2")]);
      return Response.json({ error: "failure_occurrence_not_unresolved", message: "Occurrence f1 is not unresolved" }, { status: 409 });
    } };
    serve();
    mount("/workflow/instance/wf-a");
    fireEvent.click(await screen.findByTestId("workflow-occurrence-choose-f1"));
    fireEvent.click(screen.getByTestId("workflow-resume"));
    fireEvent.click(screen.getByTestId("workflow-resume-confirm-send"));
    const rejected = await screen.findByTestId("workflow-resume-rejected");
    expect(rejected.textContent).toContain("failure_occurrence_not_unresolved");
    expect(rejected.textContent).toContain("HTTP 409");
    await screen.findByTestId("workflow-selected-not-actionable");
    expect((screen.getByTestId("workflow-occurrence-choose-f2") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("workflow-resume") as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it("treats HTTP 500 after commit as unknown, locks resuming until the exact occurrence is read back, then reports the committed redrive", async () => {
    traces = { "wf-a": trace(instance("wf-a"), [failure("wf-a", "f1"), failure("wf-a", "f2")]) };
    onPost = { resume: (body) => {
      traces["wf-a"] = trace(instance("wf-a", { status: "active", resumeCount: 1 }), [failure("wf-a", "f1", { status: "resolved", redrivePacketId: "redrive-1", resumeDecision: body.decision as string, resolvedAt: at, targetedAction: "none" }), failure("wf-a", "f2")]);
      return Response.json({ error: "internal_error", message: "wake delivery failed" }, { status: 500 });
    } };
    serve();
    mount("/workflow/instance/wf-a");
    fireEvent.click(await screen.findByTestId("workflow-occurrence-choose-f1"));
    fireEvent.change(screen.getByTestId("workflow-resume-decision"), { target: { value: "retry with fix" } });
    fireEvent.click(screen.getByTestId("workflow-resume"));
    fireEvent.click(screen.getByTestId("workflow-resume-confirm-send"));
    const unknown = await screen.findByTestId("workflow-resume-unknown");
    expect(unknown.textContent).toContain("HTTP 500");
    expect(within(unknown).getByTestId("workflow-resume-attempt").textContent).toContain("wf-a");
    await waitFor(() => expect(screen.getByTestId("workflow-occurrence-choose-f2").matches(":disabled")).toBe(true));

    fireEvent.click(screen.getByTestId("workflow-resume-inspect"));
    expect((await screen.findByTestId("workflow-resume-readback-committed")).textContent).toContain("redrive-1");
    expect(posts).toHaveLength(1);
    expect(screen.getByTestId("workflow-occurrence-choose-f2").matches(":disabled")).toBe(false);
  });

  it("keeps an uncertain resume bound to instance A: B is not locked, gets no selection, and points back to A", async () => {
    traces = {
      "wf-a": trace(instance("wf-a"), [failure("wf-a", "f1")]),
      "wf-b": trace(instance("wf-b"), [failure("wf-b", "f1")]),
    };
    onPost = { resume: () => { throw new TypeError("lost"); } };
    serve();
    const router = mount("/workflow/instance/wf-a");
    fireEvent.click(await screen.findByTestId("workflow-occurrence-choose-f1"));
    fireEvent.click(screen.getByTestId("workflow-resume"));
    fireEvent.click(screen.getByTestId("workflow-resume-confirm-send"));
    await screen.findByTestId("workflow-resume-unknown");

    await go(router, "wf-b");
    await screen.findByTestId("workflow-failures");
    expect(screen.getByTestId("workflow-resume-other").textContent).toContain("wf-a");
    expect(screen.queryByTestId("workflow-resume-unknown")).toBeNull();
    const radio = screen.getByTestId("workflow-occurrence-choose-f1") as HTMLInputElement;
    expect([radio.checked, radio.matches(":disabled")]).toEqual([false, false]);
    expect(posts.map((p) => p.url)).toEqual(["/api/workflow/wf-a/resume"]);

    await go(router, "wf-a");
    expect((await screen.findByTestId("workflow-resume-unknown")).textContent).toContain("f1");
  });

  it("sends nothing for an unsupported remote scope", async () => {
    serve();
    mount("/remote");
    await screen.findByTestId("workflow-failures");
    fireEvent.click(screen.getByTestId("workflow-occurrence-choose-f1"));
    expect((screen.getByTestId("workflow-resume") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/unavailable for remote host far/)).toBeTruthy();
    expect(posts).toHaveLength(0);
  });
});

describe("abort and instance states", () => {
  it("reads back an uncertain abort from the exact instance before claiming anything", async () => {
    traces = { "wf-a": trace(instance("wf-a", { status: "active", currentFrontier: ["p1"], currentStepId: "build" }), []) };
    onPost = { abort: (body) => {
      traces["wf-a"] = trace(instance("wf-a", { status: "aborted", completedAt: at, lastContinuationDecision: { action: "abort", actorSession: body.actorSession, reason: body.reason } }), []);
      throw new TypeError("lost after delivery");
    } };
    serve();
    mount("/workflow/instance/wf-a");
    fireEvent.click(await screen.findByTestId("workflow-abort-open"));
    fireEvent.change(screen.getByTestId("workflow-abort-reason"), { target: { value: "Superseded plan" } });
    fireEvent.click(screen.getByTestId("workflow-abort-confirm"));
    await screen.findByTestId("workflow-abort-unknown");
    fireEvent.click(screen.getByTestId("workflow-abort-inspect"));
    await screen.findByTestId("workflow-abort-readback-committed");
    expect(posts).toEqual([{ url: "/api/workflow/wf-a/abort", body: { reason: "Superseded plan", actorSession: "human@host" } }]);
    await screen.findByTestId("workflow-aborted");
  });

  it("renders an aborted instance with its decision, no abort action and no resumable failure", async () => {
    traces = { "wf-a": trace(instance("wf-a", { status: "aborted", completedAt: at, lastContinuationDecision: { action: "abort", actorSession: "ops@rig", reason: "Stopped" } }),
      [failure("wf-a", "f1")]) };
    serve();
    mount("/workflow/instance/wf-a");
    expect((await screen.findByTestId("workflow-aborted")).textContent).toContain("ops@rig — Stopped");
    expect(screen.getByTestId("wf-inst-position").textContent).toContain("aborted");
    expect(screen.getByTestId("workflow-failures-state").textContent).toBe("terminal");
    expect(screen.queryByTestId("workflow-occurrence-choose-f1")).toBeNull();
    expect(screen.queryByTestId("workflow-abort-open")).toBeNull();
  });

  it("distinguishes a missing instance from an unavailable read", async () => {
    traces = { "wf-down": Response.json({ error: "unavailable" }, { status: 503 }) };
    serve();
    const router = mount("/workflow/instance/wf-missing");
    expect((await screen.findByTestId("workflow-instance-error")).textContent).toContain("Instance Not Found");
    await act(() => router.navigate({ to: "/workflow/instance/$instanceId", params: { instanceId: "wf-down" } }));
    await waitFor(() => expect(screen.getByTestId("workflow-instance-error").textContent).toContain("Instance Unavailable"));
    expect(screen.getByTestId("workflow-instance-read-code").textContent).toContain("HTTP 503");
  });

  it("lists aborted instances as aborted and never reports a failed list read as zero instances", async () => {
    traces = { "wf-a": trace(instance("wf-a", { status: "aborted" }), []) };
    serve();
    mount("/workflows");
    await waitFor(() => expect(screen.getByTestId("workflows-page").textContent).toContain("ABORTED"));
    expect(screen.getByTestId("workflows-page").textContent).toContain("1 aborted");
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));
    mount("/workflows");
    await screen.findByTestId("workflows-error");
    expect(screen.queryByTestId("workflows-empty")).toBeNull();
  });
});
