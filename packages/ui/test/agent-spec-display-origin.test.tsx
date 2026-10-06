// AgentSpecDisplay origin adapter: file chips carry the exact host that served
// the review (not the current selection). Explicit null stays unknown; an
// omitted prop keeps the legacy payload (open-time capture in FileViewer).
// Fictional fixtures; the drawer selection is captured, Files is not read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, useParams, useRouterState } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostsResponse } from "../src/hooks/useHosts.js";
import type { AgentSpecReview } from "../src/hooks/useSpecReview.js";
import { LIBRARY_TWIN_IDS as IDS, libraryTwinBody } from "../twin/library-fixtures.js";

const selections: unknown[] = [];
vi.mock("../src/components/AppShell.js", async (original) => ({
  ...(await original<typeof import("../src/components/AppShell.js")>()),
  useDrawerSelection: () => ({ selection: null, setSelection: (value: unknown) => selections.push(value) }),
}));

const { AgentSpecDisplay } = await import("../src/components/AgentSpecDisplay.js");
const { LibraryReview } = await import("../src/components/LibraryReview.js");

afterEach(() => { cleanup(); selections.length = 0; vi.unstubAllGlobals(); });

const review: AgentSpecReview = {
  sourceState: "library_item", kind: "agent", name: "fixture", version: "1",
  profiles: [], resources: { skills: [], guidance: ["guide.md"], plugins: [], subagents: [] },
  startup: { files: [{ path: "boot.md", required: true }], actions: [] }, raw: "name: fixture\n",
};
const lastData = () => (selections.at(-1) as { type: string; data: Record<string, unknown> }).data;

function renderDisplay(props: { originInstance?: string | null }) {
  const root = createRootRoute({ component: () => <AgentSpecDisplay review={review} yaml="" testIdPrefix="t" sourcePath="/fixture/agents/fixture/agent.yaml" {...props} /> });
  render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) })} />);
}

describe("AgentSpecDisplay originInstance adapter", () => {
  it.each(["remote:1.0", "local", "%2F opaque"])("passes exact origin %s unchanged to every file chip", async (origin) => {
    renderDisplay({ originInstance: origin });
    fireEvent.click(await screen.findByTestId("t-guidance-file-trigger-guide.md"));
    expect(lastData()).toEqual({ path: "guide.md", absolutePath: "/fixture/agents/fixture/guide.md", originInstance: origin });
    fireEvent.click(screen.getByTestId("t-startup-file-trigger-boot.md"));
    expect(lastData().originInstance).toBe(origin);
  });

  it("explicit null stays unknown, never local", async () => {
    renderDisplay({ originInstance: null });
    fireEvent.click(await screen.findByTestId("t-guidance-file-trigger-guide.md"));
    expect(lastData()).toHaveProperty("originInstance", null);
  });

  it("an omitted origin keeps the legacy payload (no originInstance key)", async () => {
    renderDisplay({});
    fireEvent.click(await screen.findByTestId("t-guidance-file-trigger-guide.md"));
    expect(lastData()).toEqual({ path: "guide.md", absolutePath: "/fixture/agents/fixture/guide.md" });
  });
});

describe("Library review binds file chips to the review's origin", () => {
  const hostsFor = (selected: string): HostsResponse => ({ ownName: "Fictional", selected, hosts: [] });
  function mount(path: string, hosts: HostsResponse) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://fixture.invalid");
      const fixture = libraryTwinBody(url.pathname, url.searchParams, init?.method ?? "GET", init?.body);
      if (fixture) return new Response(JSON.stringify(fixture.body), { status: fixture.status });
      return new Response(JSON.stringify(url.pathname === "/api/hosts" ? hosts : []), { status: 200 });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["hosts"], hosts);
    const root = createRootRoute({ component: () => <QueryClientProvider client={qc}><Outlet /></QueryClientProvider> });
    const route = createRoute({ getParentRoute: () => root, path: "/specs/library/$entryId", component: () => {
      const { entryId } = useParams({ strict: false }) as { entryId: string };
      const href = useRouterState({ select: (s) => (s.location as { publicHref?: string }).publicHref ?? s.location.href });
      const search = new URLSearchParams(href.split("?")[1] ?? "");
      return <LibraryReview entryId={entryId} sourceHostId={search.has("source") ? search.get("source")! : undefined} />;
    } });
    render(<RouterProvider router={createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [path] }) })} />);
    return qc;
  }

  it("a pinned remote review keeps remote attribution after the selection becomes local", async () => {
    const qc = mount(`/specs/library/${encodeURIComponent(IDS.reviewerUser)}?source=remote`, hostsFor("remote"));
    await screen.findByTestId("library-review-agent");
    act(() => { qc.setQueryData(["hosts"], hostsFor("local")); });
    fireEvent.click(screen.getByTestId("lib-agent-guidance-file-trigger-guide.md"));
    expect(lastData().originInstance).toBe("remote");
  });

  it("a connected-instance review attributes its chips to local", async () => {
    mount(`/specs/library/${encodeURIComponent(IDS.reviewerUser)}?source=local`, hostsFor("local"));
    await screen.findByTestId("library-review-agent");
    fireEvent.click(screen.getByTestId("lib-agent-guidance-file-trigger-guide.md"));
    expect(lastData().originInstance).toBe("local");
  });
});
