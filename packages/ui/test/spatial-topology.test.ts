// Spatial topology model — pure parsing / scoping / status / layout tests.
// Real data shapes: the daemon projectRigToGraph payload (pod group nodes
// `pod-<podId>`, agents with parentId), plus deliberately malformed entries.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_SPATIAL_RIGS,
  agentMatchesQuery,
  buildSpatialModel,
  deriveSeatStatus,
  fitDistance,
  layoutSpatialModel,
  SPATIAL_LAYOUT,
  normalizeSpatialQuery,
  parseSpatialRig,
  scopeRigToPod,
  spatialKey,
  spatialScopeKey,
  tallySeatStatuses,
  type SpatialAgent,
} from "../src/lib/spatial-topology.js";
import { FIGURE_SIZE } from "../src/components/topology/spatial/spatial-mascots.js";
import { getTimeInState } from "../src/lib/activity-visuals.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

function daemonGraph() {
  return {
    nodes: [
      { id: "pod-p1", type: "podGroup", position: { x: 0, y: 0 }, data: { podId: "p1", podNamespace: "lead", podLabel: "Lead", logicalId: "lead" } },
      { id: "pod-p2", type: "podGroup", position: { x: 0, y: 0 }, data: { podId: "p2", podNamespace: "builders", podLabel: "builders" } },
      {
        id: "n1", type: "rigNode", parentId: "pod-p1", position: { x: 0, y: 0 },
        data: { logicalId: "lead.coordinator", podId: "p1", podNamespace: "lead", runtime: "claude-code", model: "opus", status: "running", startupStatus: "ready", canonicalSessionName: "coordinator@acme", terminalActive: true, pendingWorkCount: 2, hasAssignedWork: true },
      },
      {
        id: "n2", type: "rigNode", parentId: "pod-p2", position: { x: 0, y: 0 },
        data: { logicalId: "builders.builder1", podId: "p2", podNamespace: "builders", runtime: "codex", status: "running", startupStatus: "ready", terminalActive: false },
      },
      {
        id: "n3", type: "rigNode", position: { x: 0, y: 0 },
        data: { logicalId: "ops", runtime: "terminal", status: "running", startupStatus: "ready" },
      },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", label: "delegates_to" },
      { id: "e2", source: "n2", target: "n1", data: { kind: "reports_to" } },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseSpatialRig — daemon payload", () => {
  it("groups agents by parentId into pods identified by namespace, with host+rig scoped keys", () => {
    const rig = parseSpatialRig("local", { rigId: "rig_a", rigName: "acme", summaryNodeCount: 3, graph: daemonGraph() });
    expect(rig.pods.map((p) => [p.namespace, p.label, p.agentKeys.length])).toEqual([
      ["lead", "Lead", 1],
      ["builders", "builders", 1],
    ]);
    expect(rig.looseAgentKeys).toHaveLength(1);
    const coordinator = rig.agents.find((a) => a.logicalId === "lead.coordinator")!;
    expect(coordinator.key).toBe(spatialKey("local", "rig_a", "agent", "n1"));
    expect(coordinator.podNamespace).toBe("lead");
    expect(coordinator.displayName).toBe("coordinator");
    expect(rig.agents.find((a) => a.logicalId === "ops")?.nodeKind).toBe("infrastructure");
    expect(rig.issues).toEqual([]);
  });

  it("reads edge kind from data.kind or the daemon label, and flags cross-pod links", () => {
    const rig = parseSpatialRig("local", { rigId: "rig_a", rigName: "acme", graph: daemonGraph() });
    expect(rig.edges.map((e) => [e.kind, e.crossPod])).toEqual([
      ["delegates_to", true],
      ["reports_to", true],
    ]);
  });

  it("keeps identical node ids in different rigs and hosts distinct", () => {
    const a = parseSpatialRig("local", { rigId: "rig_a", rigName: "a", graph: daemonGraph() });
    const b = parseSpatialRig("local", { rigId: "rig_b", rigName: "b", graph: daemonGraph() });
    const remote = parseSpatialRig("hostB", { rigId: "rig_a", rigName: "a", graph: daemonGraph() });
    const model = buildSpatialModel("local", [a, b]);
    expect(model.counts.agents).toBe(6);
    expect(model.counts.pods).toBe(4);
    expect(new Set([...a.agents, ...remote.agents].map((x) => x.key)).size).toBe(6);
  });

  it("never infers pod membership from names: a node without parentId or pod id stays loose", () => {
    const graph = daemonGraph();
    graph.nodes.push({ id: "n4", type: "rigNode", position: { x: 0, y: 0 }, data: { logicalId: "lead.reviewer", status: "running" } } as never);
    const rig = parseSpatialRig("local", { rigId: "r", rigName: "r", graph });
    const reviewer = rig.agents.find((a) => a.logicalId === "lead.reviewer")!;
    expect(reviewer.podKey).toBeNull();
    expect(rig.looseAgentKeys).toContain(reviewer.key);
  });

  it("falls back to an explicit daemon pod id (not a name) when parentId is absent", () => {
    const graph = daemonGraph();
    graph.nodes.push({ id: "n5", type: "rigNode", position: { x: 0, y: 0 }, data: { logicalId: "x.y", podId: "p2" } } as never);
    const rig = parseSpatialRig("local", { rigId: "r", rigName: "r", graph });
    expect(rig.agents.find((a) => a.nodeId === "n5")?.podNamespace).toBe("builders");
  });
});

describe("parseSpatialRig — malformed and partial data", () => {
  it("survives a non-object / missing payload with an issue and an empty rig", () => {
    for (const graph of [null, undefined, "nope", 42, { edges: [] }, { nodes: "x" }]) {
      const rig = parseSpatialRig("local", { rigId: "r", rigName: "r", graph });
      expect(rig.agents).toEqual([]);
      expect(rig.issues.map((i) => i.kind)).toContain("malformed-graph");
    }
  });

  it("skips malformed and duplicate nodes, orphaned parents become loose seats", () => {
    const graph = {
      nodes: [
        null,
        "string-node",
        { type: "rigNode", data: {} },
        { id: 7, type: "rigNode" },
        { id: "a", type: "rigNode", data: { logicalId: "a" } },
        { id: "a", type: "rigNode", data: { logicalId: "a-dup" } },
        { id: "b", type: "rigNode", parentId: "pod-missing", data: "not-an-object" },
      ],
      edges: [],
    };
    const rig = parseSpatialRig("local", { rigId: "r", rigName: "r", graph });
    expect(rig.agents.map((a) => a.nodeId)).toEqual(["a", "b"]);
    expect(rig.agents[1]!.logicalId).toBeNull();
    expect(rig.agents[1]!.displayName).toBe("b");
    expect(rig.looseAgentKeys).toHaveLength(2);
    expect(rig.issues.map((i) => i.kind).sort()).toEqual([
      "duplicate-node", "malformed-node", "malformed-node", "malformed-node", "malformed-node", "orphan-parent",
    ].sort());
  });

  it("filters relationships to valid agent endpoints within the rig", () => {
    const graph = daemonGraph();
    graph.edges.push(
      { id: "e3", source: "n1", target: "ghost", label: "x" } as never,
      { id: "e4", source: "n1", target: "pod-p1", label: "contains" } as never,
      { id: "e5", source: "n1", target: "n1", label: "self" } as never,
      { id: "e1", source: "n1", target: "n3", label: "dup-id" } as never,
      { source: "n2" } as never,
      "junk" as never,
    );
    const rig = parseSpatialRig("local", { rigId: "r", rigName: "r", graph });
    expect(rig.edges.map((e) => e.key)).toEqual([
      spatialKey("local", "r", "edge", "e1"),
      spatialKey("local", "r", "edge", "e2"),
    ]);
    expect(rig.issues.map((i) => i.kind).sort()).toEqual(
      ["dangling-edge", "dangling-edge", "duplicate-edge", "malformed-edge", "malformed-edge", "self-edge"].sort(),
    );
  });

  it("rejects invalid enum / numeric values instead of passing them through", () => {
    const rig = parseSpatialRig("local", {
      rigId: "r",
      rigName: "r",
      graph: {
        nodes: [{
          id: "a", type: "rigNode",
          data: {
            startupStatus: "exploded", agentActivity: { state: "dancing" }, identityVerdict: { verdict: "maybe" },
            pendingWorkCount: Number.NaN, contextUsedPercentage: Number.POSITIVE_INFINITY, currentQitems: [{ nope: 1 }, { qitemId: "q1" }],
          },
        }],
        edges: [],
      },
    });
    const a = rig.agents[0]!;
    expect(a.startupStatus).toBeNull();
    expect(a.agentActivity).toBeNull();
    expect(a.identityVerdict).toBeNull();
    expect(a.pendingWorkCount).toBe(0);
    expect(a.contextUsedPercentage).toBeNull();
    expect(a.currentQitems).toEqual([{ qitemId: "q1", bodyExcerpt: "", tier: null }]);
  });
});

describe("scopeRigToPod", () => {
  it("narrows to the namespace match and drops relationships leaving the pod", () => {
    const rig = parseSpatialRig("local", { rigId: "r", rigName: "r", graph: daemonGraph() });
    const scoped = scopeRigToPod(rig, "lead")!;
    expect(scoped.agents.map((a) => a.logicalId)).toEqual(["lead.coordinator"]);
    expect(scoped.looseAgentKeys).toEqual([]);
    expect(scoped.edges).toEqual([]);
  });

  it("accepts the daemon pod id and reports a missing pod as null", () => {
    const rig = parseSpatialRig("local", { rigId: "r", rigName: "r", graph: daemonGraph() });
    expect(scopeRigToPod(rig, "p2")?.pods[0]?.namespace).toBe("builders");
    expect(scopeRigToPod(rig, "nope")).toBeNull();
  });
});

function agentWith(data: Record<string, unknown>): SpatialAgent {
  const rig = parseSpatialRig("local", {
    rigId: "r",
    rigName: "r",
    graph: { nodes: [{ id: "a", type: "rigNode", data: { logicalId: "pod.seat", status: "running", ...data } }], edges: [] },
  });
  return rig.agents[0]!;
}

describe("deriveSeatStatus — reuses the shared activity semantics truthfully", () => {
  it("sample age measures sampledAt independently of time in state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const agent = agentWith({ agentActivity: {
      state: "running", evidenceSource: "runtime_hook", reason: "tool",
      sampledAt: new Date(NOW - 5_000).toISOString(), eventAt: new Date(NOW - 10 * 60_000).toISOString(),
    } });
    expect(getTimeInState(agent.agentActivity)?.label).toBe("10m");
    expect(deriveSeatStatus(agent)).toMatchObject({ sampleAge: "5s", live: true, stale: false, evidence: "runtime hook" });
  });

  it.each([true, false])("terminal fallback (%s) does not borrow an unrelated old hook timestamp", terminalActive => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const status = deriveSeatStatus(agentWith({ terminalActive, agentActivity: {
      state: "running", evidenceSource: "runtime_hook", reason: "old tool", stale: true,
      sampledAt: new Date(NOW - 10 * 60_000).toISOString(), eventAt: new Date(NOW - 60 * 60_000).toISOString(),
    } }));
    expect(status).toMatchObject({ sampleAge: null, live: true, stale: false, evidence: "terminal output poll", label: terminalActive ? "running" : "idle" });
  });

  it("pane evidence uses its own sample age rather than an earlier runtime event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(deriveSeatStatus(agentWith({ terminalActive: true, agentActivity: {
      state: "needs_input", evidenceSource: "pane_heuristic", reason: "prompt", fallback: true,
      sampledAt: new Date(NOW - 2_000).toISOString(), eventAt: new Date(NOW - 60_000).toISOString(),
    } }))).toMatchObject({ evidence: "pane heuristic", sampleAge: "2s", live: true });
  });

  it("fresh runtime hook → live running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const s = deriveSeatStatus(agentWith({
      agentActivity: { state: "running", reason: "tool", evidenceSource: "runtime_hook", sampledAt: new Date(NOW - 5_000).toISOString() },
    }));
    expect(s).toMatchObject({ tone: "active", label: "running", evidence: "runtime hook", live: true, stale: false });
  });

  it("terminal poll drives running/idle and stays live", () => {
    expect(deriveSeatStatus(agentWith({ terminalActive: true }))).toMatchObject({ tone: "active", live: true, evidence: "terminal output poll" });
    expect(deriveSeatStatus(agentWith({ terminalActive: false }))).toMatchObject({ tone: "idle", live: true });
  });

  it("a stale hook sample is never labeled current", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const s = deriveSeatStatus(agentWith({
      agentActivity: { state: "running", reason: "tool", evidenceSource: "runtime_hook", sampledAt: new Date(NOW - 10 * 60_000).toISOString(), stale: true },
    }));
    expect(s.live).toBe(false);
    expect(s.stale).toBe(true);
    expect(s.label).toBe("last sampled running");
    expect(s.sampleAge).toBe("10m");
  });

  it("an old (unflagged) hook sample is marked stale by age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const s = deriveSeatStatus(agentWith({
      agentActivity: { state: "idle", reason: "x", evidenceSource: "runtime_hook", sampledAt: new Date(NOW - 5 * 60_000).toISOString() },
    }));
    expect(s).toMatchObject({ stale: true, live: false, label: "last sampled idle" });
  });

  it("identity mismatch overrides terminal activity (no false green) and surfaces the problem", () => {
    const s = deriveSeatStatus(agentWith({
      terminalActive: true,
      startupStatus: "attention_required",
      identityVerdict: { verdict: "mismatch", reason: "pid 42 is zsh" },
    }));
    expect(s.tone).toBe("needs_input");
    expect(s.label).toBe("identity mismatch");
    expect(s.live).toBe(false);
    expect(s.problems).toHaveLength(1);
    expect(s.problems[0]).toMatch(/Identity mismatch.*pid 42 is zsh/);
  });

  it("startup failure is blocked and listed first", () => {
    const s = deriveSeatStatus(agentWith({ startupStatus: "failed", terminalActive: true }));
    expect(s).toMatchObject({ tone: "blocked", label: "startup failed", problems: ["Startup failed"] });
  });

  it("startup attention keeps activity but flags the problem", () => {
    const s = deriveSeatStatus(agentWith({ startupStatus: "attention_required", terminalActive: false }));
    expect(s.tone).toBe("needs_input");
    expect(s.problems).toEqual(["Startup needs attention"]);
  });

  it("a stopped session reads offline even if an old sample said running", () => {
    const s = deriveSeatStatus(agentWith({ status: "stopped", terminalActive: true }));
    expect(s).toMatchObject({ tone: "offline", label: "stopped", live: false });
  });

  it("no signal at all is unknown, not idle", () => {
    expect(deriveSeatStatus(agentWith({}))).toMatchObject({ tone: "unknown", label: "no activity signal", live: false });
  });

  it("tallies tones, stale samples and problems", () => {
    const t = tallySeatStatuses([
      agentWith({ terminalActive: true }),
      agentWith({ startupStatus: "failed" }),
      agentWith({}),
    ]);
    expect(t).toMatchObject({ active: 1, blocked: 1, unknown: 1, problems: 1 });
  });
});

describe("search", () => {
  it("requires every token to match some seat field", () => {
    const rig = parseSpatialRig("local", { rigId: "r", rigName: "acme", graph: daemonGraph() });
    const coordinator = rig.agents[0]!;
    expect(agentMatchesQuery(coordinator, normalizeSpatialQuery("  LEAD  opus "))).toBe(true);
    expect(agentMatchesQuery(coordinator, normalizeSpatialQuery("lead codex"))).toBe(false);
    expect(agentMatchesQuery(coordinator, normalizeSpatialQuery("acme"))).toBe(true);
    expect(agentMatchesQuery(coordinator, [])).toBe(true);
  });
});

describe("layoutSpatialModel — deterministic, finite geometry", () => {
  function allNumbers(layout: ReturnType<typeof layoutSpatialModel>): number[] {
    return [
      ...layout.rigs.flatMap((r) => [r.x, r.z, r.w, r.d]),
      ...layout.pods.flatMap((p) => [p.x, p.z, p.w, p.d, p.top]),
      ...layout.agents.flatMap((a) => [...a.position]),
      ...layout.edges.flatMap((e) => [...e.from, ...e.control, ...e.to]),
      ...layout.bounds.min, ...layout.bounds.max, ...layout.bounds.center, layout.bounds.radius,
    ];
  }

  it("places pods above their rig deck and seats on their platform (height = containment)", () => {
    const rig = parseSpatialRig("local", { rigId: "r", rigName: "r", graph: daemonGraph() });
    const model = buildSpatialModel("local", [rig]);
    const layout = layoutSpatialModel(model);
    const rect = layout.rigs[0]!;
    for (const pod of layout.pods) {
      expect(pod.top).toBeGreaterThan(0);
      expect(pod.x).toBeGreaterThanOrEqual(rect.x);
      expect(pod.x + pod.w).toBeLessThanOrEqual(rect.x + rect.w + 1e-9);
      expect(pod.z + pod.d).toBeLessThanOrEqual(rect.z + rect.d + 1e-9);
    }
    const byKey = new Map(layout.agents.map((a) => [a.key, a.position]));
    const podded = rig.agents.find((a) => a.podKey)!;
    const loose = rig.agents.find((a) => !a.podKey)!;
    expect(byKey.get(podded.key)![1]).toBeGreaterThan(byKey.get(loose.key)![1]);
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges[0]!.control[1]).toBeGreaterThan(layout.edges[0]!.from[1]);
    expect(allNumbers(layout).every(Number.isFinite)).toBe(true);
  });

  it("is stable for identical input", () => {
    const build = () => layoutSpatialModel(buildSpatialModel("local", [
      parseSpatialRig("local", { rigId: "r", rigName: "r", graph: daemonGraph() }),
    ]));
    expect(build()).toEqual(build());
  });

  it("empty, partial and large inputs never produce NaN/Infinity", () => {
    const empty = layoutSpatialModel(buildSpatialModel("local", []));
    expect(allNumbers(empty).every(Number.isFinite)).toBe(true);
    expect(empty.bounds.radius).toBeGreaterThan(0);

    const emptyRig = layoutSpatialModel(buildSpatialModel("local", [parseSpatialRig("local", { rigId: "e", rigName: "e", graph: null })]));
    expect(emptyRig.rigs).toHaveLength(1);
    expect(allNumbers(emptyRig).every(Number.isFinite)).toBe(true);

    const nodes = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, type: "rigNode", parentId: i % 2 ? "pod-x" : undefined, data: { logicalId: `x.s${i}` } }));
    const bigGraph = { nodes: [{ id: "pod-x", type: "podGroup", data: { podNamespace: "x" } }, ...nodes], edges: [{ id: "e", source: "n0", target: "n399" }] };
    const rigs = Array.from({ length: MAX_SPATIAL_RIGS }, (_, i) => parseSpatialRig("local", { rigId: `r${i}`, rigName: `r${i}`, graph: i === 0 ? bigGraph : daemonGraph() }));
    const big = layoutSpatialModel(buildSpatialModel("local", rigs));
    expect(big.agents).toHaveLength(400 + (MAX_SPATIAL_RIGS - 1) * 3);
    expect(allNumbers(big).every(Number.isFinite)).toBe(true);
    // Rig territories never overlap.
    for (let i = 0; i < big.rigs.length; i++) {
      for (let j = i + 1; j < big.rigs.length; j++) {
        const a = big.rigs[i]!;
        const b = big.rigs[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe("camera + scope helpers", () => {
  it("fitDistance grows with radius, shrinks with wider aspect, and is finite on bad input", () => {
    const base = fitDistance(10, 38, 1.5);
    expect(fitDistance(20, 38, 1.5)).toBeCloseTo(base * 2, 6);
    expect(fitDistance(10, 38, 0.5)).toBeGreaterThan(base);
    for (const value of [fitDistance(Number.NaN, 38, 1), fitDistance(10, 38, 0), fitDistance(-1, Number.NaN, Number.POSITIVE_INFINITY)]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("scope keys are distinct and encode ids", () => {
    expect(spatialScopeKey({ kind: "host" })).toBe("host");
    expect(spatialScopeKey({ kind: "rig", rigId: "a/b" })).toBe("rig/a%2Fb");
    expect(spatialScopeKey({ kind: "pod", rigId: "a", podName: "p" })).not.toBe(spatialScopeKey({ kind: "rig", rigId: "a" }));
  });
});

describe("layoutSpatialModel — seat spacing", () => {
  it("leaves breathing room between seats in one pod, without spreading pods apart", () => {
    const nodes: Array<Record<string, unknown>> = [{ id: "pod-g", type: "podGroup", data: { podNamespace: "gua" } }];
    for (let i = 0; i < 6; i++) nodes.push({ id: `g${i}`, type: "rigNode", parentId: "pod-g", data: { logicalId: `gua.s${i}`, runtime: "claude-code" } });
    const layout = layoutSpatialModel(buildSpatialModel("local", [parseSpatialRig("local", { rigId: "gua", rigName: "gua", graph: { nodes, edges: [] } })]));
    const xs = [...new Set(layout.agents.map((a) => a.position[0]))].sort((a, b) => a - b);
    const zs = [...new Set(layout.agents.map((a) => a.position[2]))].sort((a, b) => a - b);
    expect(xs).toHaveLength(3);
    expect(zs).toHaveLength(2);
    // Clawd's arm span is the widest figure; neighbours keep >= 1.5 units clear.
    expect(xs[1]! - xs[0]! - FIGURE_SIZE.clawdWidth).toBeGreaterThanOrEqual(1.5);
    expect(zs[1]! - zs[0]! - FIGURE_SIZE.clawdWidth).toBeGreaterThanOrEqual(1.5);
    // Pods stay farther apart than seats within a pod (containment reads).
    const L = SPATIAL_LAYOUT;
    expect(L.podPadding * 2 + L.blockGap).toBeGreaterThan(L.agentSpacing - FIGURE_SIZE.clawdWidth);
  });
});
