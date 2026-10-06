// Project evidence callers attribute every Files reference to the host that
// SERVED it and give inline Markdown its served source, through the existing
// Files contracts (FileLink payload, MarkdownViewer `source`). A later host
// selection never retargets a saved reference; unknown stays null; a document
// read through a route without a Files root refuses relative resolution rather
// than inventing one. Drawer payloads are captured from the shared context.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import type { DrawerSelection } from "../src/components/SharedDetailDrawer.js";
import { ScopeProofRollup } from "../src/components/project/ProofTab.js";
import { ArtifactsNavigator } from "../src/components/project/ArtifactsNavigator.js";
import { StoryGraph } from "../src/components/project/StoryGraph.js";
import { SteeringTab } from "../src/components/project/SteeringTab.js";
import { WorkspacePortfolioPanel } from "../src/components/project/WorkspacePortfolioPanel.js";
import { SliceEvidence } from "../src/components/project/catalog/SliceEvidence.js";
import { buildStoryForest } from "../src/lib/story-graph-model.js";
import { execution, sliceDetail } from "./project-contract-fixtures.js";

const at = "2026-10-04T12:00:00.000Z";
const PROOF_MD = [
  "# Proof",
  "",
  "**Verdict: PASS**",
  "",
  "See the [guard](proof/guard.md#verdict) and [method](#method).",
  "",
  "![capture](proof/shot.png)",
  "",
  "## Method",
  "",
  "Exact.",
].join("\n");
type Read = { path: string; content: string; resolvedPath?: string; truncated?: boolean };
let reads: Record<string, Read> = {};
let lists: Record<string, Array<{ name: string; type: "file" | "dir"; size: number | null; mtime: string | null }>> = {};
let extra: (url: URL) => Response | undefined = () => undefined;
const requests: string[] = [];
const clients: QueryClient[] = [];

function serve() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test.local");
    requests.push(url.pathname + url.search);
    const hit = extra(url);
    if (hit) return hit;
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "connected", selected: "local", hosts: [] });
    if (url.pathname === "/api/files/roots") return Response.json({ roots: [{ name: "work", path: "/ws" }] });
    if (url.pathname === "/api/files/list") {
      const path = url.searchParams.get("path") ?? "";
      return Response.json({ root: "work", path, entries: lists[path] ?? [] });
    }
    if (url.pathname === "/api/files/read") {
      const path = url.searchParams.get("path") ?? "";
      const r = reads[path];
      if (!r) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ root: "work", path, absolutePath: `/ws/${r.resolvedPath ?? path}`, content: r.content, mtime: at, contentHash: "h", size: r.content.length,
        ...(r.resolvedPath ? { resolvedPath: r.resolvedPath } : {}), ...(r.truncated ? { truncated: true, truncatedAtBytes: 10, totalBytes: 99 } : {}) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }));
}

let selections: DrawerSelection[] = [];
function Harness({ children }: { children: ReactNode }) {
  const [selection, setSel] = useState<DrawerSelection>(null);
  return (
    <DrawerSelectionContext.Provider value={{ selection, setSelection: (s) => { selections.push(s); setSel(s); } }}>
      {children}
    </DrawerSelectionContext.Provider>
  );
}
function mount(node: ReactNode, selected: string = "local") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(["hosts"], { ownName: "connected", selected, hosts: [] });
  render(<QueryClientProvider client={client}><Harness>{node}</Harness></QueryClientProvider>);
  return client;
}
const lastPayload = () => (selections.at(-1) as { type: "file"; data: Record<string, unknown> }).data;

afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); reads = {}; lists = {}; extra = () => undefined; requests.length = 0; selections = []; vi.unstubAllGlobals(); });

describe("ProofTab producing origin and inline PROOF.md source", () => {
  const row = { name: "16-brief", displayName: "Brief", slicePath: "/ws/missions/m/slices/16-brief" };
  const base = "missions/m/slices/16-brief";

  it("attributes listed proof files and inline sibling links to the serving connected instance", async () => {
    reads = { [`${base}/PROOF.md`]: { path: `${base}/PROOF.md`, content: PROOF_MD } };
    lists = { [`${base}/proof`]: [{ name: "guard.md", type: "file", size: 10, mtime: at }, { name: "shot.png", type: "file", size: 10, mtime: at }] };
    serve();
    mount(<ScopeProofRollup rows={[row]} />);
    const md = await screen.findByTestId("proof-md-Brief");
    fireEvent.click(await screen.findByText("proof/guard.md"));
    expect(lastPayload()).toMatchObject({ root: "work", readPath: `${base}/proof/guard.md`, originInstance: "local" });

    const links = within(md).getAllByTestId("md-inline-link");
    const sibling = links.find((l) => l.getAttribute("data-link-kind") === "file")!;
    expect(sibling.getAttribute("data-target-path")).toBe(`${base}/proof/guard.md`);
    fireEvent.click(sibling);
    expect(lastPayload()).toEqual({ path: `${base}/proof/guard.md`, root: "work", originInstance: "local", anchor: "verdict" });
    expect(links.find((l) => l.getAttribute("data-link-kind") === "anchor")).toBeTruthy();
    // The project-scoped asset contract is unchanged: under /api/files/asset beneath the slice dir.
    const img = within(md).getByTestId("md-inline-image");
    expect(img.getAttribute("src")).toContain("/api/files/asset");
    expect(decodeURIComponent(img.getAttribute("src")!)).toContain(`${base}/proof/shot.png`);
  });

  it("resolves siblings and images against the served canonical path, not the authored request path", async () => {
    reads = { [`${base}/PROOF.md`]: { path: `${base}/PROOF.md`, resolvedPath: "archive/real/PROOF.md", content: PROOF_MD } };
    serve();
    mount(<ScopeProofRollup rows={[row]} />);
    const md = await screen.findByTestId("proof-md-Brief");
    const sibling = within(md).getAllByTestId("md-inline-link").find((l) => l.getAttribute("data-link-kind") === "file")!;
    expect(sibling.getAttribute("data-target-path")).toBe("archive/real/proof/guard.md");
    expect(decodeURIComponent(within(md).getByTestId("md-inline-image").getAttribute("src")!)).toContain("archive/real/proof/shot.png");
  });

  it("a saved reference keeps its producing origin after the selection turns remote; local content is withdrawn", async () => {
    reads = { [`${base}/PROOF.md`]: { path: `${base}/PROOF.md`, content: PROOF_MD } };
    lists = { [`${base}/proof`]: [{ name: "guard.md", type: "file", size: 10, mtime: at }] };
    serve();
    const client = mount(<ScopeProofRollup rows={[row]} />);
    await screen.findByTestId("proof-md-Brief");
    fireEvent.click(await screen.findByText("proof/guard.md"));
    const saved = selections.at(-1);
    act(() => { client.setQueryData(["hosts"], { ownName: "connected", selected: "far", hosts: [] }); });
    // Files reads are local-only: the local PROOF.md and listing stop rendering.
    await waitFor(() => expect(screen.queryByTestId("proof-md-Brief")).toBeNull());
    expect(screen.queryByText("proof/guard.md")).toBeNull();
    // The reference opened earlier still names the instance that produced it.
    expect(saved).toEqual(selections.at(-1));
    expect(lastPayload()).toMatchObject({ originInstance: "local", root: "work" });
    expect(requests.some((r) => r.includes("host=far"))).toBe(false);
  });
});

describe("ArtifactsNavigator producing origin", () => {
  it("drawer payloads carry the connected instance that listed the file", async () => {
    lists = { "missions/m": [{ name: "PLAN.md", type: "file", size: 4, mtime: at }] };
    serve();
    mount(<ArtifactsNavigator scopePath="/ws/missions/m" scopeLabel="m" />);
    fireEvent.click(await screen.findByTestId("artifacts-file-open-PLAN.md"));
    expect(lastPayload()).toMatchObject({ root: "work", path: "missions/m/PLAN.md", originInstance: "local" });
  });
});

describe("StoryGraph producing origin", () => {
  const forest = buildStoryForest([{ qitemId: "q1", tsCreated: at, tsUpdated: at, sourceSession: "a@r", destinationSession: "b@r", state: "done",
    tags: [], body: "Captured /Users/x/proof.png", chainOfRecord: [] }]);
  const open = () => { fireEvent.click(screen.getByTestId("story-row-q1")); fireEvent.click(screen.getByTestId("story-artifact-/Users/x/proof.png")); };

  it("passes the origin of the queue read that produced the artifact", () => {
    serve();
    mount(<StoryGraph forest={forest} originInstance="local" />);
    open();
    expect(lastPayload()).toMatchObject({ absolutePath: "/Users/x/proof.png", originInstance: "local" });
  });
  it("keeps an unknown origin explicit (null), never the current selection", () => {
    serve();
    mount(<StoryGraph forest={forest} originInstance={null} />);
    open();
    expect(lastPayload()).toHaveProperty("originInstance", null);
  });
});

describe("SteeringTab and portfolio inline Markdown", () => {
  const brief = "# Brief\n\n## Building\n\nSee [plan](PLAN.md) and ![d](diagram.png).\n\n## Needs you\n\nReview [the plan](PLAN.md#scope).";
  function steeringRoutes(url: URL) {
    if (url.pathname === "/api/steering") return Response.json({ priorityStack: { content: "# Steering\n\nRead [notes](notes.md).", absolutePath: "/ws/STEERING.md", mtime: at, byteCount: 10 }, roadmapRail: null, laneRails: [], unavailableSources: [] });
    if (url.pathname.startsWith("/api/missions/")) return Response.json({ missionId: "m", missionPath: "/ws/missions/m", slices: [] });
    if (url.pathname === "/api/slices") return Response.json({ slices: [{ name: "s1", displayName: "S", railItem: "m", status: "active", rawStatus: "active", qitemCount: 0, hasProofPacket: false, lastActivityAt: at }], totalCount: 1, filter: "all" });
    return undefined;
  }

  it("STEERING.md text refuses relative resolution, and offers its served file with the producing origin", async () => {
    extra = steeringRoutes;
    reads = { "missions/m/MISSION_BRIEF.md": { path: "missions/m/MISSION_BRIEF.md", content: brief } };
    serve();
    mount(<SteeringTab missionId="m" />);
    const panel = await screen.findByTestId("steering-panel-content");
    const link = within(panel).getByTestId("md-inline-link");
    expect(link.getAttribute("data-link-kind")).toBe("unsupported");
    expect(link.getAttribute("title")).toMatch(/no file source/i);
    fireEvent.click(screen.getByTestId("steering-open-file"));
    expect(lastPayload()).toMatchObject({ absolutePath: "/ws/STEERING.md", originInstance: "local" });
  });

  it("brief sections resolve siblings against the served MISSION_BRIEF.md and open them in the drawer", async () => {
    extra = steeringRoutes;
    reads = { "missions/m/MISSION_BRIEF.md": { path: "missions/m/MISSION_BRIEF.md", content: brief } };
    serve();
    mount(<SteeringTab missionId="m" />);
    const building = await screen.findByTestId("brief-section-Building");
    const link = within(building).getByTestId("md-inline-link");
    expect(link.getAttribute("data-target-path")).toBe("missions/m/PLAN.md");
    fireEvent.click(link);
    expect(lastPayload()).toEqual({ path: "missions/m/PLAN.md", root: "work", originInstance: "local" });
    expect(decodeURIComponent(within(building).getByTestId("md-inline-image").getAttribute("src")!)).toContain("missions/m/diagram.png");
  });

  it("portfolio glance excerpts carry the same served source", async () => {
    extra = steeringRoutes;
    reads = { "missions/m/MISSION_BRIEF.md": { path: "missions/m/MISSION_BRIEF.md", content: brief } };
    serve();
    const root = createRootRoute({ component: () => <Outlet /> });
    const router = createRouter({ routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/project", component: () => <WorkspacePortfolioPanel /> }),
      createRoute({ getParentRoute: () => root, path: "/project/mission/$missionId", component: () => null }),
    ]), history: createMemoryHistory({ initialEntries: ["/project"] }) });
    mount(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByTestId("portfolio-toggle-m"));
    await waitFor(() => expect(screen.getAllByTestId("md-inline-link").some((l) => l.getAttribute("data-link-kind") === "file")).toBe(true));
    const link = screen.getAllByTestId("md-inline-link").find((l) => l.getAttribute("data-target-path") === "missions/m/PLAN.md")!;
    fireEvent.click(link);
    expect(lastPayload()).toMatchObject({ root: "work", path: "missions/m/PLAN.md", originInstance: "local" });
  });
});

describe("catalog SliceEvidence documents (no Files root served)", () => {
  const selection = { id: "a", root: "/books/a" };
  function catalogRoutes(content: string) {
    return (url: URL) => {
      if (url.pathname === "/api/slices/one") return Response.json(sliceDetail);
      if (url.pathname === "/api/views/execution") return Response.json(execution("a", "trial"));
      if (url.pathname === "/api/slices/one/doc/SPEC.md") return Response.json({ relPath: "SPEC.md", content });
      return undefined;
    };
  }

  it("keeps anchors and external links, refuses relative links/images with a reason, and loads no image", async () => {
    extra = catalogRoutes("# Spec\n\n[next](NEXT.md) [top](#spec) [site](https://example.test/x)\n\n![shot](proof/shot.png)");
    serve();
    mount(<SliceEvidence selection={selection} mission="trial" slice="one" scope={null} view="docs" doc="SPEC.md" onView={() => {}} onDoc={() => {}} />);
    const body = await screen.findByTestId("slice-doc-body");
    await waitFor(() => expect(within(body).getAllByTestId("md-inline-link")).toHaveLength(3));
    const kinds = within(body).getAllByTestId("md-inline-link").map((l) => l.getAttribute("data-link-kind"));
    expect(kinds).toEqual(["unsupported", "anchor", "external"]);
    expect(within(body).getByTestId("md-image-withheld").textContent).toMatch(/not loaded/);
    expect(within(body).getByTestId("slice-doc-relative-note").textContent).toMatch(/relative links and images/i);
    expect(requests.some((r) => r.includes("shot.png"))).toBe(false);
  });

  it("an empty document is content, not a failure", async () => {
    extra = catalogRoutes("");
    serve();
    mount(<SliceEvidence selection={selection} mission="trial" slice="one" scope={null} view="docs" doc="SPEC.md" onView={() => {}} onDoc={() => {}} />);
    expect((await screen.findByTestId("slice-doc-empty")).textContent).toMatch(/empty/i);
    expect(screen.queryByTestId("slice-doc-read-error")).toBeNull();
  });
});
