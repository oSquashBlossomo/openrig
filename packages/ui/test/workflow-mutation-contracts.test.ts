import { afterEach, describe, expect, it, vi } from "vitest";
import * as workflow from "../src/hooks/useWorkflowMutations.js";
const local = { kind: "local-instance" } as const;
const remote = { kind: "remote-instance", hostId: "elsewhere" } as const;
const input = { occurrenceId: "failed/attempt-2", actorSession: "human@host", decision: " keep exact \n'decision' bytes " };
const success = { instanceId: "wf/exact", stepId: "review", newPacketId: "packet/redrive-3", ownerSession: "reviewer@rig", resumeCount: 3, exceptionItemsClosed: 2 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("occurrence-targeted workflow mutation contract", () => {
  it("sends the chosen occurrence and unmodified decision and returns the daemon redrive identity", async () => {
    const fetch = vi.fn(async () => response(success)); vi.stubGlobal("fetch", fetch);
    const result = await workflow.resumeWorkflowOccurrence(local, "wf/exact", input);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/workflow/wf%2Fexact/resume");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
    expect(result).toEqual(success);
  });
  it("rejects an omitted occurrence rather than choosing the first failure", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", { actorSession: "human@host" } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses unsupported remote scope before performing any write", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(remote, "wf/exact", input)).rejects.toMatchObject({ code: "unsupported_scope" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves failure candidates and exact replay conflict details", async () => {
    const details = { error: "failure_occurrence_replay_conflict", message: "different decision bytes", occurrenceId: input.occurrenceId, expectedDecision: "original", attemptedDecision: input.decision };
    const fetch = vi.fn(async () => response(details, 409)); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", input)).rejects.toMatchObject({ code: "rejected", status: 409, serverCode: details.error, details, attempt: { instanceId: "wf/exact", kind: "resume", payload: input } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([500, 502, 503])("retains an immutable uncertain attempt for HTTP %i even with a structured error", async (status) => {
    const details = { error: "internal_error", message: "wake failed after commit" };
    const fetch = vi.fn(async () => response(details, status)); vi.stubGlobal("fetch", fetch);
    const mutable = { ...input };
    const error = await workflow.resumeWorkflowOccurrence(local, "wf/exact", mutable).catch(error => error);
    mutable.occurrenceId = "later selection";
    expect(error).toMatchObject({ code: "outcome_unknown", status, serverCode: "internal_error", details,
      attempt: { instanceId: "wf/exact", kind: "resume", payload: input }, message: expect.stringContaining("Inspect") });
    expect(Object.isFrozen(error.attempt)).toBe(true);
    expect(Object.isFrozen(error.attempt.payload)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([400, 500])("does not infer rejection from an unreadable HTTP %i response", async (status) => {
    const fetch = vi.fn(async () => new Response("gateway response", { status })); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", input)).rejects.toMatchObject({ code: "outcome_unknown", status, attempt: { payload: input } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not classify an unrecognized structured conflict as a known rejection", async () => {
    const details = { error: "unrecognized_gateway_error", message: "proxy lost origin response" };
    const fetch = vi.fn(async () => response(details, 409)); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", input)).rejects.toMatchObject({ code: "outcome_unknown", status: 409, serverCode: details.error, details });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires the documented status as well as a known rejection code", async () => {
    const details = { error: "failure_occurrence_not_unresolved", message: "unexpected server failure" };
    const fetch = vi.fn(async () => response(details, 500)); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", input)).rejects.toMatchObject({ code: "outcome_unknown", status: 500, serverCode: details.error, details });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains the exact attempt and reports unknown outcome after a lost response without replay", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("response lost"); }); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", input)).rejects.toMatchObject({ code: "outcome_unknown", attempt: { instanceId: "wf/exact", payload: input }, message: expect.stringContaining("Inspect") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled successful body while preserving the submitted occurrence", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })); vi.stubGlobal("fetch", fetch);
    const result = workflow.resumeWorkflowOccurrence(local, "wf/exact", input);
    const check = expect(result).rejects.toMatchObject({ code: "outcome_unknown", attempt: { payload: input } });
    await vi.advanceTimersByTimeAsync(5000); await check;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("treats invalid or wrong-identity success as unknown, never as safe to repeat", async () => {
    const fetch = vi.fn(async () => response({ ...success, instanceId: "other" })); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not send a pre-cancelled mutation", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController(); controller.abort();
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", input, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });
});


const revisionInput = { operationKey: "revision/key", expectedVersion: 7, expectedDigest: "inspected/digest", actorSession: "human@host", reason: " exact \nrevision decision " };
const revisionResult = { kind: "revision", receipt: { operationKey: revisionInput.operationKey, instanceId: "wf/exact", expectedVersion: 7, compiledInputDigest: "inspected/digest", actorSession: "human@host", reason: revisionInput.reason },
  instance: { instanceId: "wf/exact", workflowName: "wf", workflowVersion: "2", createdBySession: "lead@rig", createdAt: "2026-10-04T00:00:00Z", status: "waiting", currentFrontier: ["preserved/packet"], currentStepId: "review", hopCount: 4, fallbackSynthesis: null, lastContinuationDecision: null, completedAt: null, version: 8, resumeCount: 2, hopsBaseline: 3 }, replayed: false };
describe("revision operation identity", () => {
  it("preserves a known revision conflict and its inspected version details", async () => {
    const details = { error: "lifecycle_revision_conflict", message: "instance progressed", expectedVersion: 7, actualVersion: 8 };
    const fetch = vi.fn(async () => response(details, 409)); vi.stubGlobal("fetch", fetch);
    await expect(workflow.reviseWorkflow(local, "wf/exact", revisionInput)).rejects.toMatchObject({ code: "rejected", status: 409, serverCode: details.error, details, attempt: { payload: revisionInput } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains operation identity after a structured internal revision failure", async () => {
    const details = { error: "internal_error", message: "response failed after revision commit" };
    const fetch = vi.fn(async () => response(details, 500)); vi.stubGlobal("fetch", fetch);
    await expect(workflow.reviseWorkflow(local, "wf/exact", revisionInput)).rejects.toMatchObject({ code: "outcome_unknown", status: 500, details,
      attempt: { kind: "revision", payload: revisionInput }, message: expect.stringContaining("operation key") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("submits exactly the inspected version/digest and stable operation key", async () => {
    const fetch = vi.fn(async () => response(revisionResult)); vi.stubGlobal("fetch", fetch);
    expect(await workflow.reviseWorkflow(local, "wf/exact", revisionInput)).toEqual(revisionResult);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/workflow/wf%2Fexact/revision");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(revisionInput);
  });
  it("retains a lost revision's key and inspected bytes without writing again", async () => {
    const fetch = vi.fn(async () => { throw new Error("lost after commit"); }); vi.stubGlobal("fetch", fetch);
    await expect(workflow.reviseWorkflow(local, "wf/exact", revisionInput)).rejects.toMatchObject({ code: "outcome_unknown", attempt: { kind: "revision", payload: revisionInput }, message: expect.stringContaining("operation key") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not accept an unrelated operation receipt as confirmation", async () => {
    const fetch = vi.fn(async () => response({ ...revisionResult, receipt: { ...revisionResult.receipt, operationKey: "another/key" } })); vi.stubGlobal("fetch", fetch);
    await expect(workflow.reviseWorkflow(local, "wf/exact", revisionInput)).rejects.toMatchObject({ code: "outcome_unknown" });
  });
  it("requires inspection and rejects remote writes before dispatch", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(workflow.reviseWorkflow(local, "wf/exact", { ...revisionInput, expectedVersion: NaN })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(workflow.reviseWorkflow(remote, "wf/exact", revisionInput)).rejects.toMatchObject({ code: "unsupported_scope" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains immutable attempt bytes if the caller edits its selection while a response is in flight", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const mutable = { ...revisionInput };
    const request = workflow.reviseWorkflow(local, "wf/exact", mutable, { signal: controller.signal });
    mutable.operationKey = "changed/key"; mutable.reason = "edited later";
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "outcome_unknown", attempt: { payload: revisionInput } });
  });
});


describe("structured occurrence selection conflicts", () => {
  it("retains exact candidates from the daemon's multiple-failure rejection", async () => {
    const details = { error: "failure_occurrence_required", message: "instance has 2 unresolved failure occurrences", instanceId: "wf/exact", candidates: [
      { occurrenceId: "attempt/one", failedPacketId: "packet/one", stepId: "build", branchDrive: 1 },
      { occurrenceId: "attempt/two", failedPacketId: "packet/two", stepId: "review", branchDrive: 3 },
    ] };
    const fetch = vi.fn(async () => response(details, 409)); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowOccurrence(local, "wf/exact", input)).rejects.toMatchObject({ code: "rejected", serverCode: "failure_occurrence_required", details });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("sequential (non-occurrence) resume contract", () => {
  const expectedFailure = { version: 3, failedPacketId: "packet/failed-1", stepId: "review" };
  const seq = { actorSession: "human@host", decision: " exact \n bytes ", expectedFailure };
  it("sends the exact guard with no occurrence ID and validates the selected step on success", async () => {
    const fetch = vi.fn(async () => response(success)); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowSequential(local, "wf/exact", { ...seq, occurrenceId: "smuggled" } as never)).resolves.toEqual(success);
    expect(fetch.mock.calls[0][0]).toBe("/api/workflow/wf%2Fexact/resume");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(seq);
  });
  it.each([
    ["negative version", { ...expectedFailure, version: -1 }], ["fractional version", { ...expectedFailure, version: 2.5 }],
    ["text version", { ...expectedFailure, version: "3" }], ["blank packet", { ...expectedFailure, failedPacketId: " " }],
    ["missing step", { version: 3, failedPacketId: "p" }], ["absent guard", undefined],
  ])("refuses %s before any request", async (_, guard) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(workflow.resumeWorkflowSequential(local, "wf/exact", { ...seq, expectedFailure: guard } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("treats a success for a different step as outcome unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...success, stepId: "other" })));
    await expect(workflow.resumeWorkflowSequential(local, "wf/exact", seq)).rejects.toMatchObject({ code: "outcome_unknown", message: expect.stringContaining("recorded failure") });
  });
  it.each([["resume_failure_changed", 409], ["resume_selection_invalid", 400]])("classifies %s/HTTP %i as a known pre-commit rejection", async (error, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error, message: "refused" }, status)));
    await expect(workflow.resumeWorkflowSequential(local, "wf/exact", seq)).rejects.toMatchObject({ code: "rejected", status, serverCode: error,
      attempt: { kind: "resume", payload: { expectedFailure } } });
  });
  it("does not accept resume_failure_changed with an undocumented status as a rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "resume_failure_changed" }, 500)));
    await expect(workflow.resumeWorkflowSequential(local, "wf/exact", seq)).rejects.toMatchObject({ code: "outcome_unknown" });
  });
});
