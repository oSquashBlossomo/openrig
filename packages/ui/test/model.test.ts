import { describe, expect, it } from "vitest";
import { contextPercent, resolveIds, seatStatusLabel, seatTone, sortAttention, timeAgo } from "../src/model.js";
import { mapXtermInput } from "../src/terminal-input.js";
import type { SeatNode } from "../src/api.js";

const base = {
  nodeId: "n", rigId: "r", rigName: "rig", logicalId: "dev.owner", podNamespace: "dev",
  canonicalSessionName: "dev-owner@rig", nodeKind: "agent", runtime: "codex", model: null, effort: null,
  cwd: null, sessionStatus: "running", startupStatus: "ready", lifecycleState: "running", intentionallyStopped: false,
  needsAttention: false, hasAssignedWork: false, assignedWorkCount: 0, lastActivityAt: null, latestError: null,
  recoveryGuidance: null, tmuxAttachCommand: null, resumeCommand: null,
  activityState: { activity: "idle-at-prompt", display: "idle", needsInput: { count: 0, reason: null } },
  contextUsage: null, identityVerdict: null,
} satisfies SeatNode;

describe("seatTone", () => {
  it("ranks input requests above plain attention and idle", () => {
    expect(seatTone(base)).toBe("ok");
    expect(seatTone({ ...base, needsAttention: true })).toBe("warn");
    expect(seatTone({ ...base, activityState: { ...base.activityState, needsInput: { count: 1, reason: "approval" } } })).toBe("warn");
    expect(seatTone({ ...base, activityState: { ...base.activityState, display: "active" } })).toBe("busy");
    expect(seatTone({ ...base, sessionStatus: "stopped", intentionallyStopped: true })).toBe("off");
    expect(seatTone({ ...base, sessionStatus: "stopped" })).toBe("bad");
  });
});

describe("contextPercent", () => {
  it("only trusts known samples", () => {
    expect(contextPercent(base)).toBeNull();
    expect(contextPercent({ ...base, contextUsage: { availability: "known", usedPercentage: 55.4, contextWindowSize: 1, sampledAt: null } })).toBe(55);
    expect(contextPercent({ ...base, contextUsage: { availability: "unknown", usedPercentage: 55.4, contextWindowSize: 1, sampledAt: null } })).toBeNull();
  });
});

describe("sortAttention", () => {
  it("puts critical first, then newest", () => {
    const items = [
      { id: "a", kind: "k", summary: "", urgency: "warning", at: "2026-10-27T00:00:00Z", scope: null, unblocks: null, source: null },
      { id: "b", kind: "k", summary: "", urgency: "critical", at: "2026-10-26T00:00:00Z", scope: null, unblocks: null, source: null },
      { id: "c", kind: "k", summary: "", urgency: "warning", at: "2026-10-27T01:00:00Z", scope: null, unblocks: null, source: null },
    ];
    expect(sortAttention(items).map((i) => i.id)).toEqual(["b", "c", "a"]);
  });
});

describe("timeAgo", () => {
  it("reads the daemon's two timestamp styles", () => {
    const now = Date.parse("2026-10-27T01:00:00Z");
    expect(timeAgo("2026-10-27T00:59:30Z", now)).toBe("30s");
    expect(timeAgo("2026-10-27 00:30:00", now)).toBe("30m");
    expect(timeAgo(null, now)).toBe("");
  });
});

describe("mapXtermInput", () => {
  it("splits text from tmux key names", () => {
    expect(mapXtermInput("ls\r")).toEqual([{ type: "text", text: "ls" }, { type: "keys", keys: ["Enter"] }]);
    expect(mapXtermInput("\x1b[A\x03")).toEqual([{ type: "keys", keys: ["Up"] }, { type: "keys", keys: ["C-c"] }]);
    expect(mapXtermInput("a\x7fb")).toEqual([{ type: "text", text: "a" }, { type: "keys", keys: ["BSpace"] }, { type: "text", text: "b" }]);
  });
});

describe("labels", () => {
  it("humanizes daemon states and swaps ids for names", () => {
    expect(seatStatusLabel({ ...base, lifecycleState: "attention_required" })).toBe("needs attention");
    expect(seatStatusLabel({ ...base, sessionStatus: "not_started" })).toBe("not started");
    expect(resolveIds("seat / r / n", [base])).toBe("seat / rig / dev-owner@rig");
  });
});
