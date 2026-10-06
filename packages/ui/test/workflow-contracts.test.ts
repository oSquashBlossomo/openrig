import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkflowInstance, useWorkflowInstances, useWorkflowTrace } from "../src/hooks/useWorkflow.js";

vi.mock("@tanstack/react-query", () => ({ useQuery: (options: unknown) => options, useMutation: (options: unknown) => options, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
const local = { kind: "local-instance" } as const;
const remote = { kind: "remote-instance", hostId: "other-daemon" } as const;
const instance = (over: Record<string, unknown> = {}) => ({ instanceId: "wf/exact", workflowName: "workflow", workflowVersion: "source-v1", createdBySession: "lead@rig", createdAt: "2026-10-04T00:00:00Z", status: "aborted", currentFrontier: [], currentStepId: null, hopCount: 4, fallbackSynthesis: null, lastContinuationDecision: { action: "abort", reason: "operator decision" }, completedAt: "2026-10-04T00:10:00Z", version: 7, resumeCount: 2, hopsBaseline: 3, deadline: { state: "healthy", evidence: null }, ...over });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const options = (value: unknown) => value as { queryKey: unknown[]; queryFn: (context: { signal: AbortSignal }) => Promise<unknown>; enabled?: boolean; retry?: boolean; placeholderData?: unknown };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("workflow read contracts", () => {
  it("isolates connected-instance keys and refuses unsupported remote reads", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const here = options(useWorkflowInstance("wf/exact", local));
    const there = options(useWorkflowInstance("wf/exact", remote));
    expect(here.queryKey).not.toEqual(there.queryKey);
    expect(there.enabled).toBe(false);
    await expect(there.queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "unsupported_scope" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels on selection changes even if fetch ignores its signal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const controller = new AbortController();
    const read = options(useWorkflowInstance("wf/exact")).queryFn({ signal: controller.signal });
    controller.abort();
    await expect(read).rejects.toMatchObject({ code: "cancelled" });
  }, 500);
  it("bounds stalled response bodies to five seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })));
    const read = options(useWorkflowInstances("aborted")).queryFn({ signal: new AbortController().signal });
    const check = expect(read).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000); await check;
  }, 500);
  it("preserves structured rejection code and message instead of only HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "instance_version_conflict", message: "Version changed", expectedVersion: 4, actualVersion: 7 }, 409)));
    await expect(options(useWorkflowTrace("wf/exact")).queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ status: 409, serverCode: "instance_version_conflict", message: expect.stringContaining("Version changed") });
  });
  it("rejects a wrong instance reply rather than displaying another lifecycle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(instance({ instanceId: "wf/other" }))));
    await expect(options(useWorkflowInstance("wf/exact")).queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "invalid_contract" });
  });
  it("rejects unknown lifecycle states instead of silently accepting a stale contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(instance({ status: "running" }))));
    await expect(options(useWorkflowInstance("wf/exact")).queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ code: "invalid_contract" });
  });
});

import { isWorkflowInstance, isWorkflowLifecycleExecution, isWorkflowTrace, workflowFailureChoices, readWorkflowInstance, readWorkflowOperation, readWorkflowInstances } from "../src/hooks/useWorkflow.js";
import { lifecycle, reconciliation } from "./project-contract-fixtures.js";
const failure = (id: string, over: Record<string, unknown> = {}) => ({ occurrenceId: id, instanceId: "wf/exact", failedPacketId: `packet/${id}`, stepId: "review", branchDrive: 2, hopCount: 4, hopsBaseline: 3, failureReason: "native attempt failed", status: "unresolved", redrivePacketId: null, resumeDecision: null, failedAt: "2026-10-04T00:02:00Z", resolvedAt: null, targetedAction: "resume", ...over });
const rich = () => instance({ status: "active", boundRig: "exact-rig", lifecycleOperationKey: "operation/original", compiledInputDigest: "bound-sha", lifecycleBinding: { identity: { project: "a", mission: "trial" }, sources: [{ sha256: "native-digest", path: "mission.yaml" }], graphSource: { requiredSteps: ["release-boundary"] } },
  frontierPackets: [{ packetId: "packet/parallel", stepId: "build", ownerSession: "builder@rig", queueState: "blocked", blockedOn: "packet/blocker", targetedAction: "project", dependsOn: ["review"], gate: { summary: "Keep exact gate" }, acceptance: { evidence_ref: "native-evidence" }, receiptRequired: true, deadline: { state: "healthy", evidence: null }, waiting: { obligation: "packet/parallel", owner: "builder@rig", state: "blocked", actionableSince: null, blocker: { ref: "packet/blocker", owner: "reviewer@rig", state: "pending" }, lastMeaningfulChange: { id: 42, at: "2026-10-04T00:00:00Z" }, liveness: { subject: "reviewer@rig", activity: "unknown", needsInput: { count: 0, reason: null }, confidence: "unknown" }, nextBackstop: { owner: "lead@rig", mechanism: "UNVERIFIED: no timed backstop", dueAt: null, intervalSeconds: null }, deadlineAt: null } }],
  failureOccurrences: [failure("failure/1"), failure("failure/2"), failure("failure/resolved", { status: "resolved", targetedAction: "none", redrivePacketId: "exact/redrive", resumeDecision: "previous decision", resolvedAt: "2026-10-04T00:03:00Z" })],
  boundaryObligations: lifecycle.boundary_obligations, reconciliation, unknowns: ["native liveness unavailable"], guidance: { exact: "guidance bytes" }, additionalNativeReceipt: { operation: "raw-native" } });

describe("rich workflow projection and failure chooser", () => {
  it("retains native lifecycle identity, attempts, waiting, source reconciliation and receipts verbatim", async () => {
    const value = rich(); vi.stubGlobal("fetch", vi.fn(async () => response(value)));
    expect(isWorkflowInstance(value)).toBe(true);
    const result = await readWorkflowInstance(local, "wf/exact");
    expect(result).toEqual(value);
    expect(result.boundaryObligations?.[0].receiptState).toBe("recorded");
    expect(result.reconciliation?.status).toBe("source-only");
    expect(result.failureOccurrences?.[2].resumeDecision).toBe("previous decision");
  });
  it("exposes every unresolved failure without choosing or discarding resolved attempt receipts", () => {
    const value = rich() as never;
    const chooser = workflowFailureChoices(value);
    expect(chooser.state).toBe("multiple");
    expect(chooser.choices.map(f => f.occurrenceId)).toEqual(["failure/1", "failure/2"]);
    expect(chooser.occurrences).toHaveLength(3);
    expect(chooser.requiresExplicitSelection).toBe(true);
  });
  it("keeps absent projection distinct from no failures, and never resumes aborted/completed workflows", () => {
    expect(workflowFailureChoices(instance({ status: "waiting" }) as never).state).toBe("unavailable");
    expect(workflowFailureChoices(instance({ status: "active", failureOccurrences: [] }) as never).state).toBe("none");
    for (const status of ["aborted", "completed"]) {
      const value = instance({ status, failureOccurrences: [failure("old")] });
      expect(isWorkflowInstance(value)).toBe(true);
      expect(workflowFailureChoices(value as never)).toMatchObject({ state: "terminal", choices: [] });
    }
  });
  it("does not join failures or trace receipts from another instance", () => {
    expect(isWorkflowInstance(instance({ failureOccurrences: [failure("foreign", { instanceId: "other" })] }))).toBe(false);
    expect(isWorkflowTrace({ instance: instance(), trail: [], failures: [failure("foreign", { instanceId: "other" })] })).toBe(false);
    expect(workflowFailureChoices(instance({ status: "active" }) as never, [failure("foreign", { instanceId: "other" })] as never)).toMatchObject({ state: "unavailable", choices: [] });
  });
  it("preserves execution wake/schedule and command bytes without translating camel-case packet fields", () => {
    const command = "rig workflow project --instance 'exact' --acceptance-evidence-ref 'a\nb'";
    const value = { ...lifecycle, status: "aborted", frontier_packets: [{ ...lifecycle.frontier_packets[0], targeted_action: command, wake: { ...lifecycle.frontier_packets[0].wake, phase: "fired", live: false, unconsumed: true } }] };
    expect(isWorkflowLifecycleExecution(value)).toBe(true);
    expect(value.frontier_packets[0].targeted_action).toBe(command);
    expect(isWorkflowLifecycleExecution({ ...value, frontier_packets: [{ ...value.frontier_packets[0], wake_schedule: { interval_seconds: "soon" } }] })).toBe(false);
    expect(isWorkflowLifecycleExecution({ ...value, frontier_packets: [{ packetId: "camel-case-is-a-different-contract" }] })).toBe(false);
  });
  it("recovers only the exact committed operation key and leaves a missing effect explicit", async () => {
    const value = { kind: "revision", receipt: { operationKey: "key/one", instanceId: "wf/exact", reason: "exact reason" }, instance: rich() };
    vi.stubGlobal("fetch", vi.fn(async () => response(value)));
    expect(await readWorkflowOperation(local, "key/one")).toEqual(value);
    await expect(readWorkflowOperation(local, "key/two")).rejects.toMatchObject({ code: "invalid_contract" });
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "operation_not_found", message: "No committed effect for this key. Retain it." }, 404)));
    await expect(readWorkflowOperation(local, "key/one")).rejects.toMatchObject({ status: 404, serverCode: "operation_not_found" });
  });
});


describe("workflow selector boundaries", () => {
  it("reads the exact aborted filter and isolates entity/family keys without retry or placeholder reuse", async () => {
    const fetch = vi.fn(async () => response([instance()])); vi.stubGlobal("fetch", fetch);
    expect(await readWorkflowInstances(local, "aborted")).toEqual([instance()]);
    expect(fetch.mock.calls[0][0]).toBe("/api/workflow/list?status=aborted");
    const first = options(useWorkflowInstance("wf/exact"));
    const other = options(useWorkflowInstance("wf/other"));
    const trace = options(useWorkflowTrace("wf/exact"));
    expect(first.queryKey).not.toEqual(other.queryKey);
    expect(first.queryKey).not.toEqual(trace.queryKey);
    expect(first.retry).toBe(false);
    expect(first).toHaveProperty("placeholderData", undefined);
    expect(options(useWorkflowInstance(null)).enabled).toBe(false);
  });
});
