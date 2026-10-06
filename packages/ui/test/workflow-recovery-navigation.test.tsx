// Regression for the reviewed WorkflowRevisionPanel defect: an uncertain
// revision for instance A must never be resubmitted to, or recorded against,
// instance B after an in-place route-param change, even when A and B serve
// identical version/digest proposals. Uses the actual panel inside an actual
// router, the real workflow hooks, real daemon Hono routes and WorkflowRuntime
// over private in-memory SQLite. Mission YAML lives in a temporary directory
// that is removed afterwards; the queue transport and human registry are
// fictional. No sockets, fleet, native sessions or provider actions.

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from "@tanstack/react-router";
import YAML from "yaml";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { isWorkflowReconciliation } from "../src/lib/workflow-contracts.js";
import { WorkflowRevisionPanel } from "../src/components/workflow/WorkflowControls.js";

const dispose: Array<() => void> = [];
afterEach(() => { cleanup(); dispose.splice(0).reverse().forEach((f) => f()); vi.unstubAllGlobals(); });

type Post = { url: string; body: unknown };

/** `postBehaviour(n)` decides the nth POST: deliver, lose before delivery, or hold. */
async function fixture(postBehaviour: (n: number) => "deliver" | "lose" | Promise<"deliver" | "lose">) {
  const root = mkdtempSync(join(tmpdir(), "openrig-workflow-navigation-"));
  dispose.push(() => rmSync(root, { recursive: true, force: true }));
  const mission = join(root, "missions", "trial");
  mkdirSync(join(mission, "slices", "01-child"), { recursive: true });
  const project = { kind: "project", metadata: { id: "trial" }, lifecycle: { profile: "release", profiles: { release: { required_steps: ["plan", "finish"], workflow: {
    entry: { role: "owner" }, roles: { owner: { preferred_targets: ["owner@rig"] } },
    steps: [
      { id: "plan", actor_role: "owner", depends_on: [], allowed_exits: ["handoff"], objective: "Choose" },
      { id: "build", actor_role: "owner", depends_on: ["plan"], allowed_exits: ["handoff"], objective: "Build" },
      { id: "finish", actor_role: "owner", depends_on: ["build"], allowed_exits: ["done"], objective: "Judge" },
    ] } } } } };
  const plan = { kind: "mission", metadata: { name: "trial" }, composition: { slices: [{ ref: "slices/01-child/slice.yaml", order: 10 }] },
    sdlc: { catalog: { address: "before.md" } }, lifecycle: { profile: "release", mode: "extend", workflow: { steps: [] } } };
  const write = (file: string, value: unknown) => writeFileSync(file, YAML.stringify(value));
  write(join(root, "project.yaml"), project);
  write(join(mission, "mission.yaml"), plan);
  write(join(mission, "slices", "01-child", "slice.yaml"), { kind: "slice", metadata: { id: "child" }, composition: { mission: "../../mission.yaml" } });

  const db = createDb();
  dispose.push(() => db.close());
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs(id,name) VALUES('r','rig')").run();
  const bus = new EventBus(db);
  const queue = new QueueRepository(db, bus, { loadHumanRegistry: () => ({ ok: true, entities: [] }), validateRig: () => true, transport: { send: async () => ({ ok: true, verified: true }) } } as never);
  queue.attachOutbox(new OutboxHandler(db));
  const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
  async function run(key: string) {
    const started = await runtime.instantiateLifecycle({ missionPath: mission, operationKey: key, rootObjective: "Private review", createdBySession: "owner@rig" });
    await runtime.project({ instanceId: started.instance.instanceId, currentPacketId: started.entryQitemId, actorSession: "owner@rig", exit: "handoff", closureEvidence: { evidence_ref: "plan.md" } });
    return runtime.instanceStore.getByIdOrThrow(started.instance.instanceId);
  }
  const a = await run("fictional-entry-A");
  const b = await run("fictional-entry-B");
  plan.sdlc.catalog.address = "after.md";
  write(join(mission, "mission.yaml"), plan);
  const av = runtime.inspectGraph(a.instanceId);
  const bv = runtime.inspectGraph(b.instanceId);
  expect(isWorkflowReconciliation(av) && isWorkflowReconciliation(bv)).toBe(true);
  expect(av.status).toBe("source-only");
  expect([av.expectedVersion, av.proposedDigest]).toEqual([bv.expectedVersion, bv.proposedDigest]);
  expect(av.operationKey).not.toBe(bv.operationKey);

  const app = new Hono();
  app.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime as never); await next(); });
  app.route("/api/workflow", workflowRoutes());
  const posts: Post[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if ((await postBehaviour(posts.length)) === "lose") throw new TypeError("fictional lost transport before delivery");
    }
    return app.request(url, { method: init?.method, headers: init?.headers, body: init?.body });
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  dispose.push(() => client.clear());
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  function Page() {
    const { instanceId } = useParams({ from: "/workflow/instance/$instanceId" });
    return <div data-testid="page" data-instance={instanceId}><WorkflowRevisionPanel instanceId={instanceId} /></div>;
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/workflow/instance/$instanceId", component: Page })]),
    history: createMemoryHistory({ initialEntries: [`/workflow/instance/${a.instanceId}`] }),
  });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  const go = async (id: string) => {
    await act(() => router.navigate({ to: "/workflow/instance/$instanceId", params: { instanceId: id } }));
    await waitFor(() => expect(screen.getByTestId("page").getAttribute("data-instance")).toBe(id));
  };
  const postsTo = (id: string) => posts.filter((p) => p.url === `/api/workflow/${id}/revision`).length;
  return { runtime, a, b, av, bv, posts, postsTo, go };
}

async function applyOnA() {
  fireEvent.click(await screen.findByTestId("workflow-revision-inspect"));
  fireEvent.change(screen.getByTestId("workflow-revision-reason"), { target: { value: "Exact A decision\nquoted bytes" } });
  fireEvent.click(screen.getByTestId("workflow-revision-apply"));
}

it("positive control: an uncertain revision on A is checked and resubmitted to A with identical bytes", async () => {
  const f = await fixture((n) => (n === 1 ? "lose" : "deliver"));
  await applyOnA();
  const unknown = await screen.findByTestId("workflow-revision-unknown");
  expect(unknown.getAttribute("data-target")).toBe(f.a.instanceId);
  fireEvent.click(screen.getByTestId("workflow-revision-check"));
  fireEvent.click(await screen.findByTestId("workflow-revision-resubmit"));
  await screen.findByTestId("workflow-revision-succeeded");
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]).toEqual(f.posts[0]);
  expect(f.posts[0]!.url).toBe(`/api/workflow/${f.a.instanceId}/revision`);
  expect(f.runtime.recoverOperation(f.av.operationKey!)?.instance.instanceId).toBe(f.a.instanceId);
  expect(f.runtime.inspectGraph(f.b.instanceId).status).toBe("source-only");
});

it("navigating to B never retargets A's retained attempt; returning to A keeps it and resubmits only to A", async () => {
  const f = await fixture((n) => (n === 1 ? "lose" : "deliver"));
  await applyOnA();
  await screen.findByTestId("workflow-revision-unknown");

  await f.go(f.b.instanceId);
  // B shows only a pointer back to A: no unknown block, no check/resubmit, no A bytes as B's attempt.
  const pointer = await screen.findByTestId("workflow-revision-other");
  expect(within(pointer).getByTestId(`workflow-revision-other-open-${f.a.instanceId}`)).toBeTruthy();
  await screen.findByTestId("workflow-revision-inspect");
  expect(screen.queryByTestId("workflow-revision-unknown")).toBeNull();
  expect(screen.queryByTestId("workflow-revision-resubmit")).toBeNull();
  expect(screen.queryByTestId("workflow-revision-form")).toBeNull();
  expect(f.postsTo(f.b.instanceId)).toBe(0);
  expect(f.runtime.inspectGraph(f.b.instanceId).status).toBe("source-only");

  // The pointer is an actual route link back to the exact original instance.
  fireEvent.click(within(pointer).getByTestId(`workflow-revision-other-open-${f.a.instanceId}`));
  await waitFor(() => expect(screen.getByTestId("page").getAttribute("data-instance")).toBe(f.a.instanceId));
  const unknown = await screen.findByTestId("workflow-revision-unknown");
  expect(unknown.textContent).toContain(f.av.operationKey!);
  expect(unknown.textContent).toContain("Exact A decision");
  fireEvent.click(screen.getByTestId("workflow-revision-check"));
  fireEvent.click(await screen.findByTestId("workflow-revision-resubmit"));
  await screen.findByTestId("workflow-revision-succeeded");

  expect({
    postsToB: f.postsTo(f.b.instanceId),
    receiptRetargetedToB: f.runtime.recoverOperation(f.av.operationKey!)?.instance.instanceId === f.b.instanceId,
    bStatus: f.runtime.inspectGraph(f.b.instanceId).status,
  }).toEqual({ postsToB: 0, receiptRetargetedToB: false, bStatus: "source-only" });
  expect(f.posts.map((p) => p.url)).toEqual([`/api/workflow/${f.a.instanceId}/revision`, `/api/workflow/${f.a.instanceId}/revision`]);
  expect(f.posts[1]!.body).toEqual(f.posts[0]!.body);
});

it("a response that settles after navigating away is filed under A, never shown as B's outcome", async () => {
  let release!: (v: "lose") => void;
  const held = new Promise<"lose">((resolve) => { release = resolve; });
  const f = await fixture((n) => (n === 1 ? held : "deliver"));
  await applyOnA();
  await screen.findByTestId("workflow-revision-pending");

  await f.go(f.b.instanceId);
  await screen.findByTestId("workflow-revision-other");
  await act(async () => { release("lose"); await held; });
  await waitFor(() => expect(screen.getByTestId("workflow-revision-other").textContent).toContain(f.a.instanceId));
  expect(screen.queryByTestId("workflow-revision-unknown")).toBeNull();
  expect(screen.queryByTestId("workflow-revision-pending")).toBeNull();

  await f.go(f.a.instanceId);
  expect((await screen.findByTestId("workflow-revision-unknown")).getAttribute("data-target")).toBe(f.a.instanceId);
  expect(f.postsTo(f.b.instanceId)).toBe(0);
});

it("a fresh decision on B uses B's own served key and bytes while A stays retained", async () => {
  const f = await fixture((n) => (n === 1 ? "lose" : "deliver"));
  await applyOnA();
  await screen.findByTestId("workflow-revision-unknown");
  await f.go(f.b.instanceId);
  fireEvent.click(await screen.findByTestId("workflow-revision-inspect"));
  expect(screen.getByTestId("workflow-revision-form").textContent).toContain(f.bv.operationKey!);
  expect((screen.getByTestId("workflow-revision-reason") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByTestId("workflow-revision-reason"), { target: { value: "B decision" } });
  fireEvent.click(screen.getByTestId("workflow-revision-apply"));
  await screen.findByTestId("workflow-revision-succeeded");
  expect(f.posts[1]).toMatchObject({ url: `/api/workflow/${f.b.instanceId}/revision`, body: { operationKey: f.bv.operationKey, reason: "B decision" } });
  expect(f.runtime.recoverOperation(f.av.operationKey!)).toBeFalsy();
  expect(screen.getByTestId("workflow-revision-other").textContent).toContain(f.a.instanceId);
});
