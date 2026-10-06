// Sequential (non-occurrence) workflow failure recovery. A plain serial
// workflow that fails serves `failureOccurrences: []`, yet the daemon resumes
// it. The GUI offers a separate Sequential failure panel bound to the exact
// served version / failed packet / step, sends them as `expectedFailure`
// (never an occurrence ID), and treats lost responses as unknown without
// retrying. Uses the actual instance page in an actual router, real workflow
// hooks, real daemon Hono routes and WorkflowRuntime over private in-memory
// SQLite with a temporary spec file. No sockets, fleet or native sessions.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from "@tanstack/react-router";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { WorkflowRuntime } from "../../daemon/src/domain/workflow-runtime.js";
import { workflowRoutes } from "../../daemon/src/routes/workflow.js";
import { WorkflowInstancePage } from "../src/components/workflow/WorkflowInstancePage.js";
import { readWorkflowInstance, workflowSequentialFailure, type WorkflowInstanceWithDeadline } from "../src/hooks/useWorkflow.js";
import { resumeWorkflowSequential } from "../src/hooks/useWorkflowMutations.js";
import { LOCAL_OPERATOR_INSTANCE as local } from "../src/lib/operator-read.js";

const dispose: Array<() => void> = [];
afterEach(() => { cleanup(); dispose.splice(0).reverse().forEach((f) => f()); vi.unstubAllGlobals(); });

type Post = { url: string; body: Record<string, unknown> };
type Behaviour = "deliver" | "lose-before" | "lose-after";

function fixture(postBehaviour: (n: number) => Behaviour = () => "deliver") {
  const dir = mkdtempSync(join(tmpdir(), "openrig-sequential-recovery-"));
  dispose.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = createDb();
  dispose.push(() => db.close());
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs(id,name) VALUES('fixture-rig','fixture-rig')").run();
  const eventBus = new EventBus(db);
  const queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
  queueRepo.attachOutbox(new OutboxHandler(db));
  const runtime = new WorkflowRuntime({ db, eventBus, queueRepo, exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" } });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime); c.set("eventBus" as never, eventBus); await next(); });
  app.route("/api/workflow", workflowRoutes());
  const posts: Post[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/hosts") return Response.json({ ownName: "studio", selected: "local", hosts: [] });
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const behaviour = postBehaviour(posts.length);
      if (behaviour === "lose-before") throw new TypeError("fictional transport lost before delivery");
      const response = await app.request(url, { method: "POST", headers: init.headers, body: init.body });
      if (behaviour === "lose-after") { void response.body?.cancel(); throw new TypeError("fictional transport lost after delivery"); }
      return response;
    }
    return app.request(url, { method: init?.method, headers: init?.headers });
  });

  async function start(kind: "plain" | "dependency" = "plain") {
    const specPath = join(dir, `${kind}.yaml`);
    writeFileSync(specPath, `workflow:
  id: sequential-${kind}
  version: 1
  objective: Fictional recovery fixture
  entry:
    role: owner
  roles:
    owner:
      preferred_targets: [owner@fixture-rig]
  steps:
    - id: produce
      actor_role: owner
${kind === "dependency" ? "      depends_on: []\n" : ""}      allowed_exits: [done, failed]
  exception_routing:
    orchestrator_role: owner
`);
    const created = await runtime.instantiate({ specPath, rootObjective: "fictional recovery", createdBySession: "owner@fixture-rig" });
    const id = created.instance.instanceId;
    await fail(id, created.instance.currentFrontier[0]!);
    return id;
  }
  async function fail(id: string, packetId: string) {
    await runtime.project({ instanceId: id, currentPacketId: packetId, exit: "failed", resultNote: "fixture failure", actorSession: "owner@fixture-rig" });
    const row = runtime.instanceStore.getByIdOrThrow(id);
    return { version: row.version, failedPacketId: packetId, stepId: "produce" };
  }
  const row = (id: string) => runtime.instanceStore.getByIdOrThrow(id);

  let client!: QueryClient;
  let router!: ReturnType<typeof createRouter>;
  function mount(id: string) {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    dispose.push(() => client.clear());
    const root = createRootRoute({ component: () => <Outlet /> });
    function Instance() {
      const { instanceId } = useParams({ from: "/workflow/instance/$instanceId" });
      return <WorkflowInstancePage instanceId={instanceId} />;
    }
    router = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: "/workflow/instance/$instanceId", component: Instance }),
        createRoute({ getParentRoute: () => root, path: "/workflows", component: () => null }),
      ]),
      history: createMemoryHistory({ initialEntries: [`/workflow/instance/${id}`] }),
    });
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  }
  const go = async (id: string) => {
    await act(() => router.navigate({ to: "/workflow/instance/$instanceId", params: { instanceId: id } }));
    await waitFor(() => expect(screen.getByTestId("workflow-instance-page").getAttribute("data-instance")).toBe(id));
  };
  const refetch = () => act(() => client.invalidateQueries({ queryKey: ["workflow"] }));
  return { runtime, posts, start, fail, row, mount, go, refetch };
}

const panel = () => screen.getByTestId("workflow-sequential-failure");
const review = () => fireEvent.click(within(panel()).getByTestId("workflow-sequential-review"));
const send = () => fireEvent.click(within(panel()).getByTestId("workflow-sequential-confirm-send"));

describe("sequential workflow failure recovery through the actual page and daemon", () => {
  it("reads the served failure, requires deliberate confirmation, and resumes with exactly the guarded bytes", async () => {
    const f = fixture();
    const id = await f.start();
    const failed = f.row(id);
    const packet = failed.lastContinuationDecision!.closedPacket as string;
    f.mount(id);
    await screen.findByTestId("workflow-sequential-failure");
    // The occurrence chooser is unchanged: it truthfully reports none.
    expect(screen.getByTestId("workflow-failures-state").textContent).toBe("none");
    expect(screen.getByTestId("workflow-sequential-step").textContent).toBe("produce");
    expect(screen.getByTestId("workflow-sequential-packet").textContent).toBe(packet);
    expect(screen.getByTestId("workflow-sequential-version").textContent).toBe(String(failed.version));
    expect(screen.queryByTestId("workflow-sequential-confirm")).toBeNull();

    fireEvent.change(screen.getByTestId("workflow-sequential-actor"), { target: { value: "ops@fixture-rig" } });
    fireEvent.change(screen.getByTestId("workflow-sequential-decision"), { target: { value: "  retry\n'exact' bytes " } });
    review();
    expect(f.posts).toHaveLength(0);
    expect(screen.getByTestId("workflow-sequential-confirm").textContent).toContain(packet);
    send();
    const receipt = await screen.findByTestId("workflow-sequential-succeeded");

    expect(f.posts).toEqual([{ url: `/api/workflow/${id}/resume`, body: {
      actorSession: "ops@fixture-rig", decision: "  retry\n'exact' bytes ",
      expectedFailure: { version: failed.version, failedPacketId: packet, stepId: "produce" } } }]);
    expect("occurrenceId" in f.posts[0]!.body).toBe(false);
    const active = f.row(id);
    expect(active).toMatchObject({ status: "active", resumeCount: 1 });
    expect(receipt.textContent).toContain(active.currentFrontier[0]!);
    // The receipt survives the instance leaving the failed state; the review control does not.
    await waitFor(() => expect(screen.getByTestId("wf-inst-status").textContent).toContain("active"));
    expect(screen.getByTestId("workflow-sequential-succeeded")).toBeTruthy();
    expect(screen.queryByTestId("workflow-sequential-review")).toBeNull();
  });

  it("a lost response after commit stays unknown, is never retried, stays with its instance across navigation, and readback asserts no receipt", async () => {
    const f = fixture((n) => (n === 1 ? "lose-after" : "deliver"));
    const a = await f.start();
    const b = await f.start();
    f.mount(a);
    await screen.findByTestId("workflow-sequential-failure");
    review();
    send();
    const unknown = await screen.findByTestId("workflow-sequential-unknown");
    expect(unknown.textContent).toContain("locked");
    expect(f.row(a)).toMatchObject({ status: "active", resumeCount: 1 }); // it did commit
    expect(f.posts).toHaveLength(1);

    await f.go(b);
    await waitFor(() => expect(screen.getByTestId("workflow-sequential-packet").textContent).toBe(f.row(b).lastContinuationDecision!.closedPacket));
    expect(screen.queryByTestId("workflow-sequential-unknown")).toBeNull();
    expect(within(panel()).getByTestId(`workflow-sequential-other-open-${a}`)).toBeTruthy();
    expect((screen.getByTestId("workflow-sequential-review") as HTMLButtonElement).disabled).toBe(false);

    await f.go(a);
    await screen.findByTestId("workflow-sequential-unknown");
    fireEvent.click(screen.getByTestId("workflow-sequential-inspect"));
    const changed = await screen.findByTestId("workflow-sequential-readback-changed");
    expect(changed.textContent).toContain("active");
    expect(changed.textContent).toContain("cannot show whether this request");
    expect(screen.queryByTestId("workflow-sequential-succeeded")).toBeNull();
    expect(f.posts).toHaveLength(1);
    expect(f.row(b)).toMatchObject({ status: "failed", resumeCount: 0 });
  });

  it("a response lost before delivery reads back as the same failure and unlocks a deliberate resubmission", async () => {
    const f = fixture((n) => (n === 1 ? "lose-before" : "deliver"));
    const id = await f.start();
    f.mount(id);
    await screen.findByTestId("workflow-sequential-failure");
    review();
    send();
    await screen.findByTestId("workflow-sequential-unknown");
    expect(screen.queryByTestId("workflow-sequential-review")).toBeTruthy();
    expect((screen.getByTestId("workflow-sequential-review") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("workflow-sequential-inspect"));
    await screen.findByTestId("workflow-sequential-readback-same");
    expect(f.posts).toHaveLength(1);
    expect(f.row(id)).toMatchObject({ status: "failed", resumeCount: 0 });
    await waitFor(() => expect((screen.getByTestId("workflow-sequential-review") as HTMLButtonElement).disabled).toBe(false));
    review();
    send();
    await screen.findByTestId("workflow-sequential-succeeded");
    expect(f.posts).toHaveLength(2);
    expect(f.posts[1]!.body).toEqual(f.posts[0]!.body);
    expect(f.row(id)).toMatchObject({ status: "active", resumeCount: 1 });
  });

  it("a newer failure episode is refused with 409, re-read, and needs a new review before the next exact POST", async () => {
    const f = fixture();
    const id = await f.start();
    const first = { version: f.row(id).version, failedPacketId: f.row(id).lastContinuationDecision!.closedPacket };
    f.mount(id);
    await screen.findByTestId("workflow-sequential-failure");
    review();
    // Another operator resumes from the CLI and the step fails again: same
    // step, new packet and version. This page has not re-read yet.
    const cli = await f.runtime.resume({ instanceId: id, actorSession: "cli@fixture-rig" });
    const second = await f.fail(id, cli.newPacketId);
    send();
    const rejected = await screen.findByTestId("workflow-sequential-rejected");
    expect(rejected.textContent).toContain("resume_failure_changed");
    expect(rejected.textContent).toContain("HTTP 409");
    expect(f.posts[0]!.body.expectedFailure).toEqual({ ...first, stepId: "produce" });
    expect(f.row(id)).toMatchObject({ status: "failed", resumeCount: 1, version: second.version });

    await waitFor(() => expect(screen.getByTestId("workflow-sequential-packet").textContent).toBe(second.failedPacketId));
    expect(screen.queryByTestId("workflow-sequential-confirm")).toBeNull();
    review();
    expect(screen.getByTestId("workflow-sequential-confirm").textContent).toContain(second.failedPacketId);
    send();
    await screen.findByTestId("workflow-sequential-succeeded");
    expect(f.posts).toHaveLength(2);
    expect(f.posts[1]!.body.expectedFailure).toEqual(second);
    expect(f.row(id)).toMatchObject({ status: "active", resumeCount: 2 });
  });

  it("a re-read that changes the failure voids an open review without sending anything", async () => {
    const f = fixture();
    const id = await f.start();
    f.mount(id);
    await screen.findByTestId("workflow-sequential-failure");
    review();
    const cli = await f.runtime.resume({ instanceId: id, actorSession: "cli@fixture-rig" });
    const second = await f.fail(id, cli.newPacketId);
    await f.refetch();
    await screen.findByTestId("workflow-sequential-review-stale");
    expect(screen.queryByTestId("workflow-sequential-confirm-send")).toBeNull();
    expect(f.posts).toHaveLength(0);
    review();
    expect(screen.getByTestId("workflow-sequential-confirm").textContent).toContain(second.failedPacketId);
    expect(screen.queryByTestId("workflow-sequential-review-stale")).toBeNull();
  });

  it("an occurrence-backed (dependency) failure keeps the occurrence chooser and exposes no sequential control", async () => {
    const f = fixture();
    const id = await f.start("dependency");
    f.mount(id);
    await screen.findByTestId("workflow-failures");
    await waitFor(() => expect(screen.getByTestId("workflow-failures-state").textContent).toBe("single"));
    expect(screen.queryByTestId("workflow-sequential-failure")).toBeNull();
    // Even a caller that bypasses the panel cannot route a sequential guard
    // onto an occurrence-backed instance: the daemon refuses it before commit.
    const read = await readWorkflowInstance(local, id);
    const lcd = read.lastContinuationDecision!;
    await expect(resumeWorkflowSequential(local, id, { actorSession: "ops@fixture-rig",
      expectedFailure: { version: read.version, failedPacketId: lcd.closedPacket as string, stepId: lcd.currentStep as string } }))
      .rejects.toMatchObject({ code: "rejected", status: 409, serverCode: "resume_failure_changed" });
    expect(f.row(id)).toMatchObject({ status: "failed", resumeCount: 0 });
  });
});

describe("sequential failure eligibility from served reads", () => {
  const base = (over: Partial<WorkflowInstanceWithDeadline> = {}): WorkflowInstanceWithDeadline => ({
    instanceId: "wf-1", workflowName: "w", workflowVersion: "1", createdBySession: "s", createdAt: "2026-10-06T00:00:00Z", status: "failed",
    currentFrontier: [], currentStepId: "produce", hopCount: 1, fallbackSynthesis: null, completedAt: null, version: 3, resumeCount: 0, hopsBaseline: 0,
    lastContinuationDecision: { exit: "failed", closedPacket: "packet-1", currentStep: "produce" }, deadline: { state: "healthy", evidence: null },
    failureOccurrences: [], ...over,
  });
  const occurrence = (id: string) => ({ occurrenceId: id, instanceId: "wf-1", failedPacketId: `p-${id}`, stepId: "produce", branchDrive: 0, hopCount: 1, hopsBaseline: 0,
    failureReason: null, status: "unresolved" as const, redrivePacketId: null, resumeDecision: null, failedAt: "2026-10-06T00:00:00Z", resolvedAt: null, targetedAction: "resume" as const });

  it("selects exactly the served version, closed packet and step", () => {
    expect(workflowSequentialFailure(base())).toEqual({ state: "eligible", selection: { version: 3, failedPacketId: "packet-1", stepId: "produce" } });
    expect(workflowSequentialFailure(base({ failureOccurrences: undefined }), [])).toMatchObject({ state: "eligible" });
  });
  it.each([
    ["absent occurrence projection", base({ failureOccurrences: undefined }), undefined, "occurrences-unavailable"],
    ["one occurrence row", base({ failureOccurrences: [occurrence("o1")] }), undefined, "occurrence-backed"],
    ["multiple occurrence rows", base({ failureOccurrences: [occurrence("o1"), occurrence("o2")] }), undefined, "occurrence-backed"],
    ["trace rows disagree with an empty instance projection", base(), [occurrence("o1")], "occurrence-backed"],
    ["no recorded decision", base({ lastContinuationDecision: null }), undefined, "failure-unrecorded"],
    ["blank closed packet", base({ lastContinuationDecision: { closedPacket: "  ", currentStep: "produce" } }), undefined, "failure-unrecorded"],
    ["non-text step", base({ lastContinuationDecision: { closedPacket: "packet-1", currentStep: 7 } }), undefined, "failure-unrecorded"],
    ["unsafe version", base({ version: -1 }), undefined, "failure-unrecorded"],
    ["active", base({ status: "active" }), undefined, "not-failed"],
    ["waiting", base({ status: "waiting" }), undefined, "not-failed"],
    ["aborted", base({ status: "aborted" }), undefined, "terminal"],
    ["completed", base({ status: "completed" }), undefined, "terminal"],
  ] as const)("refuses %s", (_, instance, failures, reason) => {
    expect(workflowSequentialFailure(instance, failures === undefined ? instance.failureOccurrences : [...failures])).toEqual({ state: "ineligible", reason });
  });
});
