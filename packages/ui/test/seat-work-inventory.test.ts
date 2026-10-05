import { afterEach, describe, expect, it, vi } from "vitest";
import { isNodeInventoryEntry, NodeInventoryPartialReadError, readNodeInventory } from "../src/lib/fleet-inventory-reads.js";
const rigId = "rig/exact%one";
const row = { rigId, rigName: "fixture", logicalId: "pod.owner", podId: "pod", canonicalSessionName: "raw%seat/1",
  nodeKind: "agent", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "none",
  tmuxAttachCommand: null, resumeCommand: null, latestError: null };
const activityState = { activity: "working", display: "needs-input", needsInput: { count: 2, reason: "permission prompt" },
  decidedBy: "lifecycle-hooks", seq: 42, lastSwap: { generation: "exact%generation", at: "2026-10-05T01:00:00Z" } };
afterEach(() => { vi.unstubAllGlobals(); });
describe("already-served seat activity and work facts", () => {
  it("retains exact original/additive fields, zero counts and the server-arbitrated independent needs-input facts", async () => {
    const valid = { ...row, activityState, assignedWorkCount: 104, pendingWorkCount: 100, inProgressWorkCount: 0, blockedWorkCount: 4, futureFact: "exact" };
    const rows = [valid]; vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
    expect(isNodeInventoryEntry(valid)).toBe(true);
    expect(await readNodeInventory(rigId, "local")).toBe(rows);
    expect(rows[0]!.activityState).toBe(activityState);
    expect(rows[0]!.inProgressWorkCount).toBe(0);
  });
  it("retains future textual vocabulary and explicit zero/nullable facts without client arbitration", async () => {
    const valid = { ...row, assignedWorkCount: 0, inProgressWorkCount: 0, blockedWorkCount: 0,
      activityState: { activity: "future-axis", display: "future-display", needsInput: { count: 0, reason: null },
        decidedBy: null, seq: 0, lastSwap: null, futureEvidence: "exact" } };
    const rows = [valid]; vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows })));
    expect(await readNodeInventory(rigId, "local")).toBe(rows);
    expect(valid.activityState.activity).toBe("future-axis");
  });
  it.each([{}, { activityState: null }])("keeps omitted/null oracle and omitted counters unknown (%j)", fields => {
    expect(isNodeInventoryEntry({ ...row, ...fields })).toBe(true);
    expect({ ...row, ...fields }).not.toHaveProperty("assignedWorkCount");
  });
  it.each([
    { assignedWorkCount: -1 }, { assignedWorkCount: null }, { assignedWorkCount: 1.2 },
    { inProgressWorkCount: "0" }, { blockedWorkCount: Number.NaN }, { pendingWorkCount: -1 },
    { activityState: {} }, { activityState: { ...activityState, activity: 42 } },
    { activityState: { ...activityState, display: false } },
    { activityState: { ...activityState, needsInput: { count: -1, reason: null } } },
    { activityState: { ...activityState, needsInput: { count: 0, reason: 7 } } },
    { activityState: { ...activityState, seq: 0.5 } },
    { activityState: { ...activityState, lastSwap: { generation: 8, at: "now" } } },
  ])("rejects invalid served fact %j without losing verified siblings", async invalid => {
    const bad = { ...row, logicalId: "bad", ...invalid };
    expect(isNodeInventoryEntry(bad)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [row, bad] })));
    const error = await readNodeInventory(rigId, "local").catch(error => error);
    expect(error).toBeInstanceOf(NodeInventoryPartialReadError);
    expect(error.partial.rows).toEqual([row]); expect(error.partial.rows[0]).toBe(row);
    expect(error.partial.rejectedCount).toBe(1);
  });
});
