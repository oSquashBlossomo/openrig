// The Story rollup is built from queue items read under an explicit queue
// source (useSliceQueueSource). StoryGraph's artifact links must carry THAT
// producing origin: a known local source → "local", a known remote source →
// its exact host id (opaque bytes, even though its queue map is IDs-only), an
// unconfirmed source → explicit null. Never the open-time or clicked host.
// Exercised through the actual SliceScopePage → ScopeStoryRollup → StoryGraph.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrawerSelectionContext, type DrawerSelection } from "../src/components/AppShell.js";

const storyProps = vi.hoisted(() => ({ origins: [] as unknown[] }));
vi.mock("../src/components/project/StoryGraph.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/components/project/StoryGraph.js")>();
  // Pass-through spy: renders the REAL StoryGraph and records the caller's prop.
  function StoryGraphSpy(props: Parameters<typeof actual.StoryGraph>[0]) {
    storyProps.origins.push(Object.hasOwn(props, "originInstance") ? props.originInstance : "<absent>");
    return actual.StoryGraph(props);
  }
  return { ...actual, StoryGraph: StoryGraphSpy };
});
import { SliceScopePage } from "../src/components/project/ScopePages.js";

const REMOTE = "vps-a/é?#1";
const at = "2026-05-06T18:00:00Z";
const detail = {
  name: "idea-ledger", missionId: null, slicePath: "/ws/slices/idea-ledger", displayName: "Idea Ledger", railItem: null,
  status: "active", rawStatus: "active", qitemIds: ["qitem-A"], commitRefs: [], lastActivityAt: at,
  workflowBinding: null, story: { events: [], phaseDefinitions: null },
  acceptance: { totalItems: 0, doneItems: 0, percentage: 0, items: [], closureCallout: null, currentStep: null },
  decisions: { rows: [] }, docs: { tree: [] }, tests: { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } },
  topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
};
const queueItem = { qitemId: "qitem-A", tsCreated: at, tsUpdated: at, sourceSession: "a@r", destinationSession: "b@r", state: "done",
  priority: "routine", tier: "mode2", tags: [], body: "Captured /Users/x/proof.png" };

let hosts: () => Response;
const fetchMock = vi.fn();
const selections: DrawerSelection[] = [];
beforeEach(() => {
  storyProps.origins.length = 0;
  selections.length = 0;
  hosts = () => Response.json({ ownName: "fixture", selected: "local", hosts: [] });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/hosts") return hosts();
    if (url.startsWith("/api/slices/idea-ledger")) return Response.json(detail);
    if (url.startsWith("/api/queue/qitem-A")) return Response.json(queueItem);
    return Response.json([]);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => cleanup());

async function openStory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/project/slice/$sliceId", component: () => (
        <DrawerSelectionContext.Provider value={{ selection: null, setSelection: (s) => { selections.push(s); } }}><SliceScopePage /></DrawerSelectionContext.Provider>
      ) }),
      createRoute({ getParentRoute: () => root, path: "$", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/project/slice/idea-ledger"] }),
  });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  fireEvent.click(await screen.findByTestId("project-tab-story"));
}
const lastOrigin = () => storyProps.origins.at(-1);

describe("ScopePages Story rollup → StoryGraph producing origin", () => {
  it("known local queue source: the artifact drawer is attributed to the local instance", async () => {
    await openStory();
    fireEvent.click(await screen.findByTestId("story-row-qitem-A"));
    fireEvent.click(await screen.findByTestId("story-artifact-/Users/x/proof.png"));
    expect((selections.at(-1) as { data: Record<string, unknown> }).data).toMatchObject({ absolutePath: "/Users/x/proof.png", originInstance: "local" });
    expect(lastOrigin()).toBe("local");
  });

  it("known remote queue source: the exact opaque host id, even though its queue details are IDs-only", async () => {
    hosts = () => Response.json({ ownName: "fixture", selected: REMOTE, hosts: [{ id: REMOTE, transport: "http", url: "http://h.invalid", selected: true, status: "reachable" }] });
    await openStory();
    await screen.findByTestId("queue-source-unsupported");
    await waitFor(() => expect(lastOrigin()).toBe(REMOTE));
    expect(fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/queue"))).toEqual([]);
  });

  it("unconfirmed queue source: explicit null, never a presumed local origin", async () => {
    hosts = () => Response.json({ error: "down" }, { status: 503 });
    await openStory();
    await screen.findByTestId("queue-source-unconfirmed");
    await waitFor(() => expect(storyProps.origins.length).toBeGreaterThan(0));
    expect(lastOrigin()).toBeNull();
  });
});
