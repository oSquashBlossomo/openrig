import { describe, expect, it } from "vitest";
import { buildModel, curvePoint, histogram, messageOf, rigAnchors } from "../src/graph/model.js";
import { fitView, signals } from "../src/graph/render.js";
import type { PsEntry, SeatNode } from "../src/api.js";

const seat = (session: string, rigId: string): SeatNode => ({
  nodeId: `n-${session}`, rigId, rigName: rigId, logicalId: session.split("@")[0]!, podNamespace: null,
  canonicalSessionName: session, nodeKind: "agent", runtime: null, model: null, effort: null, cwd: null,
  sessionStatus: "running", startupStatus: "ready", lifecycleState: "running", intentionallyStopped: false,
  needsAttention: false, hasAssignedWork: false, assignedWorkCount: 0, lastActivityAt: null, latestError: null,
  recoveryGuidance: null, tmuxAttachCommand: null, resumeCommand: null, activityState: null, contextUsage: null, identityVerdict: null,
});
const rig = (rigId: string, n: number): PsEntry => ({ rigId, name: rigId, nodeCount: n, runningCount: n, activeCount: 0, hasWorkCount: 0, status: "running", lifecycleState: "running", uptime: null, latestSnapshot: null, isArchived: false, attentionCount: 0 });

describe("buildModel", () => {
  it("places seats near their rig anchor, keeps old positions, and links by session", () => {
    const a = seat("x@a", "a"), b = seat("y@a", "a"), c = seat("z@b", "b");
    const byRig = new Map([["a", [a, b]], ["b", [c]]]);
    const graphs = [{ nodes: [{ id: a.nodeId, type: "rigNode", data: { contextUsedPercentage: 42, agentActivity: { state: "running", reason: null, evidence: "thinking", sampledAt: null } } }], edges: [{ id: "e", source: a.nodeId, target: b.nodeId, label: "delegates_to" }] }, undefined];
    const m = buildModel([rig("a", 2), rig("b", 1)], byRig, graphs, [], new Map(), 0);
    expect(m.nodes.map((n) => n.id).sort()).toEqual(["x@a", "y@a", "z@b"]);
    expect(m.links).toEqual([{ source: "x@a", target: "y@a", kind: "delegates_to" }]);
    const x = m.nodes.find((n) => n.id === "x@a")!;
    expect(x.ctx).toBe(42); expect(x.working).toBe(true); expect(x.activity).toBe("thinking");
    const prev = new Map(m.nodes.map((n) => [n.id, { ...n, x: 123, y: 456 }]));
    const m2 = buildModel([rig("a", 2), rig("b", 1)], byRig, graphs, [], prev, 0);
    expect(m2.nodes.find((n) => n.id === "x@a")!.x).toBe(123);
    expect(rigAnchors([3, 1, 1]).length).toBe(3);
    const wide = rigAnchors([3, 1, 1], 2.25), square = rigAnchors([3, 1, 1], 1);
    expect(Math.abs(wide[1]!.x)).toBeGreaterThan(Math.abs(square[1]!.x));
    expect(Math.abs(wide[1]!.y)).toBeLessThan(Math.abs(square[1]!.y));
  });
});

describe("messageOf and histogram", () => {
  it("reads both queue shapes on both clocks and buckets them", () => {
    const ev = { seq: 1, type: "queue.created", seenAt: 1_000_000, createdAt: "2026-10-27 01:00:00", sourceSession: "a@r", destinationSession: "b@r" };
    expect(messageOf(ev, "seen")).toMatchObject({ from: "a@r", to: "b@r", kind: "new work", at: 1_000_000 });
    expect(messageOf(ev, "logged")?.at).toBe(Date.parse("2026-10-27T01:00:00Z"));
    expect(messageOf({ seq: 2, type: "queue.handed_off", seenAt: 5, fromSession: "a@r", toSession: "b@r" })?.kind).toBe("handoff");
    expect(messageOf({ seq: 3, type: "queue.created", seenAt: 5, sourceSession: "a@r", destinationSession: "a@r" })).toBeNull();
    const now = 10 * 60_000;
    const bars = histogram([{ from: "a", to: "b", kind: "handoff", at: now - 15_000, seq: 1 }, { from: "a", to: "b", kind: "handoff", at: now - 20 * 60_000, seq: 2 }], now, 30);
    expect(bars.length).toBe(60); expect(bars[59]).toBe(1); expect(bars[20]).toBe(1);
  });
});

describe("signals and fitView", () => {
  it("turns fresh messages into pulses and recent ones into traffic", () => {
    const a = { ...seat("a@r", "r") }, b = { ...seat("b@r", "r") };
    const model = buildModel([rig("r", 2)], new Map([["r", [a, b]]]), [undefined], [], new Map(), 0);
    const now = 100_000;
    const s = signals(model, [{ from: "a@r", to: "b@r", kind: "new work", at: now - 500, seq: 1 }, { from: "a@r", to: "b@r", kind: "handoff", at: now - 50_000, seq: 2 }], now);
    expect(s.pulses.length).toBe(1); expect(s.traffic.length).toBe(1); expect(s.traffic[0]!.count).toBe(2);
    const v = fitView([{ x: -100, y: 0 }, { x: 100, y: 0 }], 800, 600);
    expect(v.k).toBeGreaterThan(0.2); expect(v.k).toBeLessThanOrEqual(1.6);
    const p = curvePoint({ x: 0, y: 0 }, { x: 10, y: 0 }, 1);
    expect(p.x).toBeCloseTo(10); expect(p.y).toBeCloseTo(0);
  });
});
