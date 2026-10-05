// 2D renderer projection: malformed graph entries must not crash RigGraph or
// HostMultiRigGraph (root's reproduction: {nodes:[null]} at node.type and
// {edges:[null]} at edge.data). Usable siblings keep their exact identities,
// the drop is disclosed, and "nothing usable" is distinct from empty.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { projectRigGraph } from "../src/components/topology/rig-graph-projection.js";

vi.mock("@tanstack/react-router", async (original) => ({ ...(await original<object>()), useNavigate: () => vi.fn() }));
import { RigGraph } from "../src/components/RigGraph.js";

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <div data-testid="crash">{this.state.error.message}</div> : this.props.children; }
}

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); vi.unstubAllGlobals(); });

const pod = { id: "pod-a", type: "podGroup", position: { x: 0, y: 0 }, data: { podId: "pa", podNamespace: "desk" } };
const seat = (id: string, logicalId: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: "rigNode", parentId: "pod-a", position: { x: 0, y: 0 }, data: { logicalId, status: "running" }, ...extra });

describe("projectRigGraph", () => {
  it("keeps valid siblings with exact identity and reports each malformed, duplicate, dangling or cyclic entry", () => {
    const projection = projectRigGraph({
      nodes: [null, 7, "x", [], pod, seat("1.0", "desk.a"), seat("1", "desk.b"), seat("1", "desk.dupe"),
        { id: "\ud800", type: "rigNode" }, { id: "nodata", type: "rigNode", data: "str" },
        { id: "loop-a", type: "rigNode", parentId: "loop-b", data: {} }, { id: "loop-b", type: "rigNode", parentId: "loop-a", data: {} },
        { id: "orphan", type: "rigNode", parentId: "missing", data: {}, position: { x: Number.NaN, y: 0 } }],
      edges: [null, { id: "e1", source: "1.0", target: "1" }, { id: "e1", source: "1", target: "1.0" },
        { id: "e2", source: "1.0", target: "ghost" }, { id: "e3", source: "1", target: "1.0", data: 5 },
        { id: "e4", source: "1", target: "1.0", label: { nested: true } }],
    });
    expect(projection.nodes.map((n) => n.id)).toEqual(["pod-a", "1.0", "1", "loop-a", "loop-b", "orphan"]);
    expect(projection.nodes.find((n) => n.id === "orphan")!.position).toEqual({ x: 0, y: 0 });
    expect(projection.nodes.find((n) => n.id === "orphan")!.parentId).toBeUndefined();
    expect(projection.nodes.filter((n) => n.id.startsWith("loop")).some((n) => n.parentId === undefined)).toBe(true);
    expect(projection.edges.map((e) => e.id)).toEqual(["e1", "e4"]);
    expect(projection.edges[1]!.label).toBeUndefined();
    const kinds = projection.issues.map((i) => i.kind);
    expect(kinds.filter((k) => k === "malformed-node")).toHaveLength(6);
    expect(kinds).toEqual(expect.arrayContaining(["duplicate-node", "orphan-parent", "parent-cycle", "malformed-edge", "duplicate-edge", "dangling-edge"]));
  });

  it("an empty graph and a missing payload are empty with no issues", () => {
    expect(projectRigGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [], issues: [] });
    expect(projectRigGraph(undefined)).toEqual({ nodes: [], edges: [], issues: [] });
  });
});

function renderGraph(payload: unknown) {
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(["hosts"], { ownName: "Private", selected: "local", hosts: [] });
  render(<QueryClientProvider client={client}><Boundary><RigGraph rigId="private-rig" showDiscovered={false} /></Boundary></QueryClientProvider>);
  return client;
}

describe("RigGraph with partial graphs (actual component + real query helper)", () => {
  it.each([
    { nodes: [null], edges: [] },
    { nodes: [], edges: [null] },
  ])("does not crash on %j and does not call it an empty topology", async (payload) => {
    const client = renderGraph(payload);
    await waitFor(() => expect(client.getQueryState(["rig", "private-rig", "graph", "local"])?.status).toBe("success"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("crash")).toBeNull();
    if (payload.nodes.length) {
      expect(screen.getByTestId("graph-unusable").textContent).toContain("none of its 1 entry was usable");
      expect(screen.queryByTestId("empty-topology")).toBeNull();
    } else {
      // Only a dangling/malformed edge and no nodes: nothing to draw, disclosed.
      expect(screen.getByTestId("graph-partial").textContent).toContain("1 entry skipped");
    }
  });

  it("renders valid siblings beside malformed entries with a partial-data disclosure", async () => {
    renderGraph({ nodes: [pod, null, seat("n-ok", "desk.ok"), seat("n-ok", "desk.dupe")], edges: [null, { id: "e", source: "n-ok", target: "ghost" }] });
    await screen.findByTestId("graph-view");
    expect(screen.queryByTestId("crash")).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-testid='rf__node-n-ok']")).not.toBeNull());
    expect(screen.getByTestId("graph-partial").textContent).toContain("4 entries skipped");
  });

  it("a genuinely empty graph still shows the empty topology ghost", async () => {
    renderGraph({ nodes: [], edges: [] });
    expect(await screen.findByTestId("empty-topology")).toBeTruthy();
    expect(screen.queryByTestId("graph-partial")).toBeNull();
  });
});
