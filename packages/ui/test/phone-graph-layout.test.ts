// Phone 2D graph layout (lib/phone-graph-layout.ts): progressive hierarchy,
// relationship re-attachment under collapse, exact identity with duplicate
// names, truthful tiles for unreadable/loading/beyond-bound rigs, and the
// readable opening viewport.

import { describe, it, expect } from "vitest";
import { deriveSeatStatus, parseSpatialRig, type SpatialRig, type SpatialSeatStatus } from "../src/lib/spatial-topology.js";
import {
  boundPhoneViewport,
  phoneTranslateExtent,
  PHONE_HOST_AUTO_EXPAND_SEATS,
  PHONE_POD_AUTO_COLLAPSE_SEATS,
  PHONE_POD_W,
  defaultPhoneCollapsedPodKeys,
  defaultPhoneExpandedRigIds,
  layoutPhoneGraph,
  pagePhoneViewport,
  PHONE_PAGE_MIN_ZOOM,
  phoneGraphColumns,
  readablePhoneViewport,
  type PhoneGraphLayoutInput,
  type PhoneRigEntry,
} from "../src/lib/phone-graph-layout.js";

const HOST = "local";

function rig(rigId: string, rigName: string, pods: Record<string, string[]>, edges: Array<[string, string, string?]> = [], loose: string[] = []): SpatialRig {
  const nodes: unknown[] = [];
  for (const [pod, seats] of Object.entries(pods)) {
    nodes.push({ id: `pod-${pod}`, type: "podGroup", data: { podNamespace: pod } });
    for (const seat of seats) nodes.push({ id: seat, type: "rigNode", parentId: `pod-${pod}`, data: { logicalId: seat, terminalActive: true } });
  }
  for (const seat of loose) nodes.push({ id: seat, type: "rigNode", data: { logicalId: seat } });
  return parseSpatialRig(HOST, {
    rigId,
    rigName,
    graph: { nodes, edges: edges.map(([s, t, kind], i) => ({ id: `e${i}`, source: s, target: t, data: { kind: kind ?? "delegates_to" } })) },
  });
}

function statuses(rigs: SpatialRig[]): Map<string, SpatialSeatStatus> {
  const m = new Map<string, SpatialSeatStatus>();
  for (const r of rigs) for (const a of r.agents) m.set(a.key, deriveSeatStatus(a));
  return m;
}

function input(entries: PhoneRigEntry[], over: Partial<PhoneGraphLayoutInput> = {}): PhoneGraphLayoutInput {
  const rigs = entries.flatMap((e) => (e.kind === "ready" ? [e.rig] : []));
  return {
    entries,
    truncatedRigCount: 0,
    statusByKey: statuses(rigs),
    expandedRigIds: new Set(rigs.map((r) => r.rigId)),
    collapsedPodKeys: new Set(),
    columns: 1,
    scopeKind: "host",
    ...over,
  };
}

describe("phoneGraphColumns", () => {
  it("is one column on a phone in either orientation's canvas, two on a portrait tablet", () => {
    expect(phoneGraphColumns(406)).toBe(1); // 430 portrait minus page gutters
    expect(phoneGraphColumns(560)).toBe(1); // 932 landscape canvas beside details
    expect(phoneGraphColumns(786)).toBe(2); // 834 portrait
    expect(phoneGraphColumns(0)).toBe(1);
    expect(phoneGraphColumns(5000)).toBe(3);
  });
});

describe("layoutPhoneGraph hierarchy", () => {
  it("lays expanded rigs as rig → pod → seat chips, every entity keyed by its exact spatial identity", () => {
    const r = rig("r1", "alpha", { core: ["core.lead", "core.worker"] }, [["core.lead", "core.worker"]]);
    const out = layoutPhoneGraph(input([{ kind: "ready", rig: r }]));
    const types = out.nodes.map((n) => n.type);
    expect(types).toEqual(["phoneRig", "phonePod", "phoneSeat", "phoneSeat"]);
    expect(out.nodes[0]!.id).toBe(r.key);
    expect(out.nodes[1]!.id).toBe(r.pods[0]!.key);
    expect(out.nodes.slice(2).map((n) => n.id)).toEqual(r.agents.map((a) => a.key));
    // Two-column seat grid inside the pod; chips sit inside the pod frame.
    const [pod, a, b] = [out.nodes[1]!, out.nodes[2]!, out.nodes[3]!];
    expect(a.position.y).toBe(b.position.y);
    expect(b.position.x).toBeGreaterThan(a.position.x);
    expect(b.position.x + b.width).toBeLessThanOrEqual(pod.position.x + pod.width);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ source: r.agents[0]!.key, target: r.agents[1]!.key, sourceHandle: "s-right", targetHandle: "t-left" });
    expect(out.edges[0]!.data.merged).toBe(false);
  });

  it("collapsed rig is one tile carrying tallies; its relationships stay internal (no dangling edges)", () => {
    const r = rig("r1", "alpha", { core: ["core.a", "core.b"] }, [["core.a", "core.b"]]);
    const out = layoutPhoneGraph(input([{ kind: "ready", rig: r }], { expandedRigIds: new Set() }));
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]!.data).toMatchObject({ kind: "rig", expanded: false, seatCount: 2, podCount: 1 });
    expect((out.nodes[0]!.data as { tally: Record<string, number> }).tally.active).toBe(2);
    expect(out.edges).toEqual([]);
    expect(out.representativeOf.get(r.agents[0]!.key)).toBe(r.key);
  });

  it("collapsing a pod re-attaches cross-pod relationships to the pod tile and merges them with a count", () => {
    const r = rig("r1", "alpha", { core: ["core.lead"], work: ["work.a", "work.b"] }, [
      ["core.lead", "work.a"],
      ["core.lead", "work.b", "spawned_by"],
      ["work.a", "work.b"],
    ]);
    const workPod = r.pods.find((p) => p.namespace === "work")!;
    const out = layoutPhoneGraph(input([{ kind: "ready", rig: r }], { collapsedPodKeys: new Set([workPod.key]) }));
    expect(out.nodes.some((n) => n.type === "phoneSeat" && n.id.includes("work.a"))).toBe(false);
    expect(out.edges).toHaveLength(1);
    const e = out.edges[0]!;
    expect(e.source).toBe(r.agents.find((a) => a.logicalId === "core.lead")!.key);
    expect(e.target).toBe(workPod.key);
    expect(e.data).toMatchObject({ count: 2, merged: true, kinds: ["delegates_to", "spawned_by"] });
    expect(e.id.startsWith("merged:")).toBe(true);
  });

  it("keeps loose (pod-less) seats in a non-navigable group", () => {
    const r = rig("r1", "alpha", {}, [], ["solo"]);
    const out = layoutPhoneGraph(input([{ kind: "ready", rig: r }]));
    const group = out.nodes.find((n) => n.type === "phonePod")!;
    expect(group.data).toMatchObject({ loose: true, label: "No pod", expanded: true });
    expect(out.nodes.filter((n) => n.type === "phoneSeat")).toHaveLength(1);
  });
});

describe("duplicate names and truthful tiles", () => {
  it("qualifies same-named rigs by exact id and same-named seats by logical id, never merging them", () => {
    const a = rig("rig-a", "fleet", { x: ["x.worker"] });
    const b = rig("rig-b", "fleet", { y: ["y.worker", "y2.worker"] });
    const out = layoutPhoneGraph(input([{ kind: "ready", rig: a }, { kind: "ready", rig: b }]));
    const rigs = out.nodes.filter((n) => n.type === "phoneRig").map((n) => n.data);
    expect(rigs).toEqual([
      expect.objectContaining({ rigId: "rig-a", rigName: "fleet", qualifier: "rig-a" }),
      expect.objectContaining({ rigId: "rig-b", rigName: "fleet", qualifier: "rig-b" }),
    ]);
    const seats = out.nodes.filter((n) => n.type === "phoneSeat").map((n) => n.data as { label: string; qualifier: string | null; rigId: string });
    // Same display name in different rigs: context (the rig frame) disambiguates.
    expect(seats.find((s) => s.rigId === "rig-a")).toMatchObject({ label: "worker", qualifier: null });
    // Same display name inside one rig: the exact logical id disambiguates.
    expect(seats.filter((s) => s.rigId === "rig-b").map((s) => s.qualifier).sort()).toEqual(["y.worker", "y2.worker"]);
    expect(new Set(out.nodes.map((n) => n.id)).size).toBe(out.nodes.length);
  });

  it("marks pods sharing a namespace ambiguous (no exact pod route)", () => {
    const r = parseSpatialRig(HOST, { rigId: "r", rigName: "r", graph: { nodes: [
      { id: "p1", type: "podGroup", data: { podNamespace: "dup" } },
      { id: "p2", type: "podGroup", data: { podNamespace: "dup" } },
      { id: "s1", type: "rigNode", parentId: "p1", data: { logicalId: "dup.a" } },
      { id: "s2", type: "rigNode", parentId: "p2", data: { logicalId: "dup.b" } },
    ], edges: [] } });
    const out = layoutPhoneGraph(input([{ kind: "ready", rig: r }]));
    const pods = out.nodes.filter((n) => n.type === "phonePod").map((n) => n.data as { ambiguous: boolean });
    expect(pods.map((p) => p.ambiguous)).toEqual([true, true]);
  });

  it("draws unreadable, loading and beyond-the-bound rigs as their own tiles", () => {
    const r = rig("ok", "ok", { p: ["p.s"] });
    const out = layoutPhoneGraph(input([
      { kind: "ready", rig: r },
      { kind: "error", rigId: "bad", rigName: "bad", message: "HTTP 500" },
      { kind: "loading", rigId: "slow", rigName: "slow" },
    ], { truncatedRigCount: 3 }));
    const tiles = out.nodes.filter((n) => n.type === "phoneRig").map((n) => n.data as { rigId: string; state: string; message: string | null; collapsible: boolean });
    expect(tiles.map((t) => [t.rigId, t.state])).toEqual([["ok", "ready"], ["bad", "error"], ["slow", "loading"]]);
    expect(tiles[1]).toMatchObject({ message: "HTTP 500", collapsible: false });
    expect(out.nodes.find((n) => n.type === "phoneTruncated")?.data).toMatchObject({ count: 3 });
  });
});

describe("progressive defaults", () => {
  it("opens a small fleet fully and a dense fleet as tiles; the selected seat's rig always opens unless explicitly collapsed", () => {
    const small = [rig("a", "a", { p: ["p.1", "p.2"] }), rig("b", "b", { q: ["q.1"] })].map((r) => ({ kind: "ready", rig: r }) as PhoneRigEntry);
    expect([...defaultPhoneExpandedRigIds(small, new Map(), null)].sort()).toEqual(["a", "b"]);

    const seats = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}.s${i}`);
    const dense = [rig("a", "a", { p: seats("p", PHONE_HOST_AUTO_EXPAND_SEATS) }), rig("b", "b", { q: seats("q", 2) })]
      .map((r) => ({ kind: "ready", rig: r }) as PhoneRigEntry);
    expect([...defaultPhoneExpandedRigIds(dense, new Map(), null)]).toEqual([]);
    expect([...defaultPhoneExpandedRigIds(dense, new Map(), "b")]).toEqual(["b"]);
    expect([...defaultPhoneExpandedRigIds(dense, new Map([["a", true]]), null)]).toEqual(["a"]);
    expect([...defaultPhoneExpandedRigIds(dense, new Map([["b", false]]), "b")]).toEqual([]);
  });

  it("collapses the pods of a dense rig except the pod holding the selection", () => {
    const seats = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}.s${i}`);
    const r = rig("r", "r", { a: seats("a", PHONE_POD_AUTO_COLLAPSE_SEATS), b: seats("b", 2) });
    const podA = r.pods.find((p) => p.namespace === "a")!.key;
    const podB = r.pods.find((p) => p.namespace === "b")!.key;
    expect([...defaultPhoneCollapsedPodKeys([r], null)].sort()).toEqual([podA, podB].sort());
    expect([...defaultPhoneCollapsedPodKeys([r], podB)]).toEqual([podA]);
    expect([...defaultPhoneCollapsedPodKeys([rig("s", "s", { a: ["a.1"] })], null)]).toEqual([]);
  });

  it("spreads a single scoped rig's pods across columns on a wide narrow-layout canvas", () => {
    const r = rig("r", "r", { a: ["a.1"], b: ["b.1"] });
    const one = layoutPhoneGraph(input([{ kind: "ready", rig: r }], { scopeKind: "rig", columns: 1 }));
    const two = layoutPhoneGraph(input([{ kind: "ready", rig: r }], { scopeKind: "rig", columns: 2 }));
    expect(one.bounds.width).toBeLessThan(two.bounds.width);
    const pods = two.nodes.filter((n) => n.type === "phonePod");
    expect(pods[0]!.position.y).toBe(pods[1]!.position.y);
    expect(pods[1]!.position.x - pods[0]!.position.x).toBeGreaterThanOrEqual(PHONE_POD_W);
    // Rig scope: the rig is the scope itself — never a collapsible tile.
    expect(two.nodes[0]!.data).toMatchObject({ collapsible: false, expanded: true });
  });

  it("keeps the layout signature stable across a status-only refresh", () => {
    const r1 = rig("r", "r", { a: ["a.1", "a.2"] });
    const r2 = parseSpatialRig(HOST, { rigId: "r", rigName: "r", graph: { nodes: [
      { id: "pod-a", type: "podGroup", data: { podNamespace: "a" } },
      { id: "a.1", type: "rigNode", parentId: "pod-a", data: { logicalId: "a.1", terminalActive: false } },
      { id: "a.2", type: "rigNode", parentId: "pod-a", data: { logicalId: "a.2", terminalActive: true } },
    ], edges: [] } });
    const s1 = layoutPhoneGraph(input([{ kind: "ready", rig: r1 }])).signature;
    const s2 = layoutPhoneGraph(input([{ kind: "ready", rig: r2 }])).signature;
    expect(s2).toBe(s1);
  });
});

describe("readablePhoneViewport", () => {
  it("fits a small graph whole and centred", () => {
    const v = readablePhoneViewport({ x: 0, y: 0, width: 336, height: 200 }, { width: 406, height: 540 })!;
    expect(v.zoom).toBeGreaterThan(1);
    expect(v.zoom).toBeLessThanOrEqual(1.25);
    expect(v.x).toBeCloseTo((406 - 336 * v.zoom) / 2);
  });

  it("fits the width and starts at the top when fitting everything would be unreadable", () => {
    const v = readablePhoneViewport({ x: 0, y: 0, width: 336, height: 3000 }, { width: 406, height: 540 })!;
    expect(v.zoom).toBeCloseTo((406 - 24) / 336);
    expect(v.y).toBe(12);
  });

  it("never shrinks below the readable zoom for very wide content; pans from the left edge", () => {
    const v = readablePhoneViewport({ x: 0, y: 0, width: 2000, height: 3000 }, { width: 406, height: 540 })!;
    expect(v.zoom).toBeCloseTo(0.72);
    expect(v.x).toBe(12);
  });

  it("returns null until the canvas has a size", () => {
    expect(readablePhoneViewport({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("vertical-only drag extent", () => {
  const bounds = { x: 0, y: 0, width: 360, height: 1200 };
  const extent = phoneTranslateExtent(bounds);
  const surface = { width: 430, height: 500 };

  it("a graph that fits the width stays centred on x whatever x is asked for; y is bounded to the graph", () => {
    const centredX = (430 - 360) / 2; // x extent is the graph itself
    for (const x of [-300, 0, 37, 900]) expect(boundPhoneViewport({ x, y: -200, zoom: 1 }, extent, surface).x).toBeCloseTo(centredX);
    // y keeps the operator's scroll inside the graph, never past its ends.
    expect(boundPhoneViewport({ x: 0, y: -200, zoom: 1 }, extent, surface).y).toBe(-200);
    expect(boundPhoneViewport({ x: 0, y: 400, zoom: 1 }, extent, surface).y).toBe(24);
    expect(boundPhoneViewport({ x: 0, y: -5000, zoom: 1 }, extent, surface).y).toBe(500 - 1224);
  });

  it("a tall graph opened at its readable fit-width zoom cannot drift sideways (no margin overflow)", () => {
    const tall = { x: 0, y: 0, width: 344, height: 1200 };
    const narrow = { width: 404, height: 480 };
    const readable = readablePhoneViewport(tall, narrow)!;
    expect(readable.zoom).toBeCloseTo(1.104651, 5);
    expect(readable.x).toBeCloseTo(12, 5); // 380px graph centred in 404px
    const tallExtent = phoneTranslateExtent(tall);
    const opened = boundPhoneViewport(readable, tallExtent, narrow);
    expect(opened.x).toBeCloseTo(readable.x, 9);
    expect(opened.y).toBeCloseTo(readable.y, 9);
    for (const x of [-60, -2.5, 0, 26.5, 90]) {
      expect(boundPhoneViewport({ ...readable, x }, tallExtent, narrow).x).toBeCloseTo(12, 5);
    }
    // Vertical scroll keeps its margin past both ends.
    expect(boundPhoneViewport({ ...readable, y: 500 }, tallExtent, narrow).y).toBeCloseTo(24 * readable.zoom, 5);
  });

  it("zoomed in past the width, x is bounded to the graph instead of drifting off it", () => {
    const vp = boundPhoneViewport({ x: 200, y: 0, zoom: 2 }, extent, surface);
    expect(vp.x).toBe(0); // the graph's left edge at the surface edge
    expect(boundPhoneViewport({ x: -5000, y: 0, zoom: 2 }, extent, surface).x).toBe(430 - 360 * 2);
    expect(boundPhoneViewport({ x: -100, y: 0, zoom: 2 }, extent, surface).x).toBe(-100);
  });
});

describe("pagePhoneViewport (tablet page flow)", () => {
  const bounds = { x: 0, y: 0, width: 688, height: 3000 };
  it("reads full width, capped, and sizes the surface to the drawn graph", () => {
    const v = pagePhoneViewport(bounds, 794, null)!;
    expect(v.viewport.zoom).toBeCloseTo((794 - 24) / 688, 6);
    expect(v.viewport.x).toBeCloseTo(12, 6);
    expect(v.viewport.y).toBe(12);
    expect(v.height).toBe(Math.ceil(3000 * v.viewport.zoom + 24));
    expect(pagePhoneViewport(bounds, 1400, null)!.viewport.zoom).toBe(1.25);
  });
  it("clamps an explicit zoom to [floor, width] and stays centred", () => {
    const tiny = pagePhoneViewport(bounds, 794, 0.15)!;
    expect(tiny.viewport.zoom).toBe(PHONE_PAGE_MIN_ZOOM);
    expect(tiny.viewport.x).toBeCloseTo((794 - 688 * PHONE_PAGE_MIN_ZOOM) / 2, 6);
    expect(pagePhoneViewport(bounds, 794, 3)!.viewport.zoom).toBe(tiny.readableZoom);
    expect(pagePhoneViewport(bounds, 0, null)).toBeNull();
  });
});
