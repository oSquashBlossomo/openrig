import { describe, expect, it } from "vitest";
import { curve, layoutFleet, messageOf, workingSession } from "../src/graph.js";
import type { SeatNode } from "../src/api.js";

const seat = (session: string): SeatNode => ({
  nodeId: `n-${session}`, rigId: "r", rigName: "rig", logicalId: session.split("@")[0]!, podNamespace: null,
  canonicalSessionName: session, nodeKind: "agent", runtime: null, model: null, effort: null, cwd: null,
  sessionStatus: "running", startupStatus: "ready", lifecycleState: "running", intentionallyStopped: false,
  needsAttention: false, hasAssignedWork: false, assignedWorkCount: 0, lastActivityAt: null, latestError: null,
  recoveryGuidance: null, tmuxAttachCommand: null, resumeCommand: null, activityState: null, contextUsage: null, identityVerdict: null,
});

describe("layoutFleet", () => {
  it("keeps every seat inside its rig box and boxes apart, wrapping at the width", () => {
    const rigs = [
      { rigId: "a", name: "a", seats: ["x@a", "y@a", "z@a"].map(seat) },
      { rigId: "b", name: "b", seats: ["p@b"].map(seat) },
      { rigId: "c", name: "c", seats: Array.from({ length: 10 }, (_, i) => seat(`s${i}@c`)) },
    ];
    const l = layoutFleet(rigs, 400);
    expect(l.nodes.size).toBe(14);
    for (const [session, n] of l.nodes) {
      const c = l.clusters.find((k) => k.rigId === n.seat.rigId || session.endsWith(`@${k.name}`))!;
      expect(n.x).toBeGreaterThan(c.x); expect(n.x).toBeLessThan(c.x + c.w);
      expect(n.y).toBeGreaterThan(c.y); expect(n.y).toBeLessThan(c.y + c.h);
    }
    for (const c of l.clusters) expect(c.x === 0 || c.x + c.w <= 400).toBe(true);
    expect(new Set(l.clusters.map((c) => c.y)).size).toBeGreaterThan(1);
    expect(l.height).toBeGreaterThan(0);
  });
});

describe("messageOf", () => {
  it("reads both queue event shapes and ignores self-sends", () => {
    expect(messageOf({ seq: 1, type: "queue.created", seenAt: 0, sourceSession: "a@r", destinationSession: "b@r" })).toEqual({ from: "a@r", to: "b@r", kind: "new work" });
    expect(messageOf({ seq: 2, type: "queue.handed_off", seenAt: 0, fromSession: "a@r", toSession: "b@r" })?.kind).toBe("handoff");
    expect(messageOf({ seq: 3, type: "queue.created", seenAt: 0, sourceSession: "a@r", destinationSession: "a@r" })).toBeNull();
    expect(messageOf({ seq: 4, type: "snapshot.created", seenAt: 0 })).toBeNull();
    expect(workingSession({ seq: 5, type: "agent.activity", seenAt: 0, sessionName: "a@r", activity: { state: "running" } })).toBe("a@r");
    expect(workingSession({ seq: 6, type: "agent.activity", seenAt: 0, sessionName: "a@r", activity: { state: "idle" } })).toBeNull();
  });
});

describe("curve", () => {
  it("starts and ends at the given points", () => {
    expect(curve({ x: 0, y: 0 }, { x: 10, y: 0 })).toMatch(/^M 0 0 Q .* 10 0$/);
  });
});
