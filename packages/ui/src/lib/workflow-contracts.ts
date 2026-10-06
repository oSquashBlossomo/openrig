// Browser-only mirrors of the served workflow contracts. Camel-case workflow
// routes and snake-case execution lifecycle projections are deliberately distinct.
import { arrayOf, hasShape, isBoolean, isInteger, isNumber, isObject, isText, nullable, oneOf, optional, type Check } from "./operator-read.js";

export type WorkflowInstanceStatus = "active" | "waiting" | "completed" | "failed" | "aborted";
export type WorkflowExitKind = "handoff" | "waiting" | "done" | "failed";
export interface WorkflowStepDeadlineEvidence {
  instanceId: string; stepId: string | null; packetId: string; ownerSession: string; packetState: string;
  anchor: "closure_required_at" | "claimed_at" | "created_at"; anchorAt: string; overdueBySeconds: number; ageSeconds: number; claimedAt: string | null;
}
export interface WorkflowDeadlineVerdict { state: "healthy" | "overdue-claimed" | "overdue-unclaimed"; evidence: WorkflowStepDeadlineEvidence | null }
export interface WorkflowBackstop extends Record<string, unknown> {
  owner: string; mechanism: string; dueAt: string | null; intervalSeconds: number | null; suspendedUntil?: string;
  recovery?: { qitemId: string; state: string }; note?: string;
}
export interface WorkflowWaitingView extends Record<string, unknown> {
  obligation: string; owner: string; state: string; actionableSince: string | null;
  blocker: { ref: string; owner: string | null; state: string | null } | null;
  lastMeaningfulChange: { id: number; at: string } | null;
  liveness: { subject: string; activity: string; needsInput: { count: number; reason: string | null }; confidence: "oracle" | "unknown" };
  nextBackstop: WorkflowBackstop; laterBackstop?: WorkflowBackstop; deadlineAt: string | null;
}
export interface WorkflowFrontierPacket extends Record<string, unknown> {
  packetId: string; stepId: string | null; ownerSession: string | null; queueState: string | null; blockedOn: string | null;
  targetedAction: "project" | "route" | "indeterminate"; dependsOn: string[]; gate: Record<string, unknown> | null;
  acceptance: Record<string, unknown> | null; receiptRequired: boolean; deadline: WorkflowDeadlineVerdict; waiting: WorkflowWaitingView | null;
}
export interface WorkflowFailureOccurrence extends Record<string, unknown> {
  occurrenceId: string; instanceId: string; failedPacketId: string; stepId: string; branchDrive: number; hopCount: number; hopsBaseline: number;
  failureReason: string | null; status: "unresolved" | "resolved"; redrivePacketId: string | null; resumeDecision: string | null;
  failedAt: string; resolvedAt: string | null; targetedAction: "resume" | "none";
}
export interface WorkflowBoundaryObligation extends Record<string, unknown> {
  stepId: string; required: boolean; state: string; receiptState: "recorded" | "missing" | "not-required";
  receipt: { evidenceRef: string; actorSession: string; closedAt: string } | null;
}
export interface WorkflowReconciliation extends Record<string, unknown> {
  status: "current" | "source-only" | "compatible" | "incompatible" | "unavailable" | "unbound";
  adopted: boolean | null; boundDigest: string | null; proposedDigest: string | null; boundVersion: string; proposedVersion: string | null;
  compatible: boolean; changes: Array<{ kind: string; ref: string; fields?: string[] }>; reasons: string[];
  composition: { mode: string; explanation: string; boundSlices: string[]; executableSteps: Array<{ id: string; dependsOn: string[] }> };
  nextAction: string; applyCommand?: string; operationKey?: string; expectedVersion: number;
}
export interface WorkflowInstanceWithDeadline {
  instanceId: string; workflowName: string; workflowVersion: string; createdBySession: string; createdAt: string; status: WorkflowInstanceStatus;
  currentFrontier: string[]; currentStepId: string | null; hopCount: number; fallbackSynthesis: string | null;
  lastContinuationDecision: Record<string, unknown> | null; completedAt: string | null; version: number; resumeCount: number; hopsBaseline: number;
  deadline: WorkflowDeadlineVerdict;
  // Additive to preserve old consumers/fixtures. Missing enrichment is unavailable,
  // not an invented empty frontier or a successfully completed lifecycle.
  boundRig?: string | null; lifecycleOperationKey?: string | null; compiledInputDigest?: string | null; lifecycleBinding?: Record<string, unknown> | null;
  frontierPackets?: WorkflowFrontierPacket[]; failureOccurrences?: WorkflowFailureOccurrence[];
  boundaryObligations?: WorkflowBoundaryObligation[]; unknowns?: string[]; reconciliation?: WorkflowReconciliation;
  guidance?: Record<string, unknown>; exceptionReadiness?: unknown; exceptionObligations?: unknown;
}
export interface WorkflowStepTrailEntry {
  trailId: string; instanceId: string; stepId: string; stepRole: string; closedAt: string; closureReason: WorkflowExitKind;
  closureEvidence: Record<string, unknown> | null; actorSession: string; nextQitemId: string | null; priorQitemId: string;
}
export interface WorkflowSpecSummary {
  name: string; version: string; purpose: string | null; targetRig: string | null;
  coordinationTerminalTurnRule: string; sourcePath: string; cachedAt: string; isBuiltIn: boolean;
}
export interface WorkflowTrace {
  instance: WorkflowInstanceWithDeadline; trail: WorkflowStepTrailEntry[];
  frontier?: WorkflowFrontierPacket[]; failures?: WorkflowFailureOccurrence[]; boundaryObligations?: WorkflowBoundaryObligation[];
  unknowns?: string[]; guidance?: Record<string, unknown>; reconciliation?: WorkflowReconciliation;
}
export interface WorkflowOperation extends Record<string, unknown> {
  kind: string; receipt: Record<string, unknown> & { operationKey: string; instanceId: string }; instance: Omit<WorkflowInstanceWithDeadline, "deadline">; replayed?: boolean;
}

// These are served /api/views/execution lifecycle fields, NOT aliases for the
// workflow-route packets. Commands and source/receipt bytes pass through intact.
export interface WorkflowLifecyclePacket extends Record<string, unknown> {
  packet_id: string; step_id: string; owner: string; queue_state: string; blocked_on: string | null;
  blocker: Record<string, unknown> | null; summary: string | null; evidence_ref: string | null; objective: string | null;
  latest_transition: { ts: string; state: string; transition_note: string | null; actor_session: string } | null;
  wake: { kind: "watchdog" | "timer" | "blocker"; ref: string; phase: "armed" | "fired"; live: boolean; deliveryStatus: string | null; unconsumed: boolean; expiresAt?: string; recoveryOwner?: string } | null;
  wake_schedule: { policy: string; interval_seconds: number; last_evaluation_at: string | null } | null;
  depends_on: string[]; gate: Record<string, unknown> | null; acceptance: Record<string, unknown> | null; targeted_action: string;
}
export interface WorkflowLifecycleExecution extends Record<string, unknown> {
  instance_id: string; workflow_name: string; workflow_version: string; description: string | null; status: WorkflowInstanceStatus;
  operation_key: string | null; compiled_input_digest: string | null; identity: Record<string, unknown>;
  sources: Array<Record<string, unknown>>; dependencies: Array<Record<string, unknown>>; graph_source: Record<string, unknown> | null;
  steps: Array<{ id: string; objective: string | null; next_hop: unknown }>;
  reconciliation: WorkflowReconciliation; boundary_obligations: WorkflowBoundaryObligation[]; frontier_packets: WorkflowLifecyclePacket[];
  failure_occurrences: Array<{ occurrence_id: string; step_id: string; status: "unresolved" | "resolved"; failure_reason: string | null;
    redrive_packet_id: string | null; failed_at: string; resolved_at: string | null; targeted_action: string | null }>;
  unknowns: string[];
}

const textOrNull = nullable(isText);
const objectOrNull = nullable(isObject);
const status = oneOf("active", "waiting", "completed", "failed", "aborted");
const deadline: Check = v => hasShape(v, { state: oneOf("healthy", "overdue-claimed", "overdue-unclaimed"), evidence: nullable(x => hasShape(x, {
  instanceId: isText, stepId: textOrNull, packetId: isText, ownerSession: isText, packetState: isText,
  anchor: oneOf("closure_required_at", "claimed_at", "created_at"), anchorAt: isText, overdueBySeconds: isInteger, ageSeconds: isInteger, claimedAt: textOrNull,
})) });
const backstop: Check = v => hasShape(v, { owner: isText, mechanism: isText, dueAt: textOrNull, intervalSeconds: nullable(isNumber),
  suspendedUntil: optional(isText), recovery: optional(x => hasShape(x, { qitemId: isText, state: isText })), note: optional(isText) });
const waiting: Check = v => hasShape(v, { obligation: isText, owner: isText, state: isText, actionableSince: textOrNull,
  blocker: nullable(x => hasShape(x, { ref: isText, owner: textOrNull, state: textOrNull })),
  lastMeaningfulChange: nullable(x => hasShape(x, { id: isInteger, at: isText })), liveness: x => hasShape(x, {
    subject: isText, activity: isText, needsInput: x => hasShape(x, { count: isInteger, reason: textOrNull }), confidence: oneOf("oracle", "unknown"),
  }), nextBackstop: backstop, laterBackstop: optional(backstop), deadlineAt: textOrNull });
export const isWorkflowFrontierPacket: Check = v => hasShape(v, { packetId: isText, stepId: textOrNull, ownerSession: textOrNull, queueState: textOrNull,
  blockedOn: textOrNull, targetedAction: oneOf("project", "route", "indeterminate"), dependsOn: arrayOf(isText), gate: objectOrNull, acceptance: objectOrNull,
  receiptRequired: isBoolean, deadline, waiting: nullable(waiting) });
export const isWorkflowFailureOccurrence: Check = v => hasShape(v, { occurrenceId: isText, instanceId: isText, failedPacketId: isText, stepId: isText,
  branchDrive: isInteger, hopCount: isInteger, hopsBaseline: isInteger, failureReason: textOrNull, status: oneOf("unresolved", "resolved"), redrivePacketId: textOrNull,
  resumeDecision: textOrNull, failedAt: isText, resolvedAt: textOrNull, targetedAction: oneOf("resume", "none") });
export const isWorkflowBoundaryObligation: Check = v => hasShape(v, { stepId: isText, required: isBoolean, state: isText, receiptState: oneOf("recorded", "missing", "not-required"),
  receipt: nullable(x => hasShape(x, { evidenceRef: isText, actorSession: isText, closedAt: isText })) });
export function isWorkflowReconciliation(v: unknown): v is WorkflowReconciliation {
  return hasShape(v, { status: oneOf("current", "source-only", "compatible", "incompatible", "unavailable", "unbound"), adopted: nullable(isBoolean),
    boundDigest: textOrNull, proposedDigest: textOrNull, boundVersion: isText, proposedVersion: textOrNull, compatible: isBoolean,
    changes: arrayOf(x => hasShape(x, { kind: isText, ref: isText, fields: optional(arrayOf(isText)) })), reasons: arrayOf(isText),
    composition: x => hasShape(x, { mode: isText, explanation: isText, boundSlices: arrayOf(isText), executableSteps: arrayOf(x => hasShape(x, { id: isText, dependsOn: arrayOf(isText) })) }),
    nextAction: isText, applyCommand: optional(isText), operationKey: optional(isText), expectedVersion: isInteger });
}
function workflowInstanceShape(v: unknown, withDeadline: boolean): v is Record<string, unknown> {
  return hasShape(v, { instanceId: isText, workflowName: isText, workflowVersion: isText, createdBySession: isText, createdAt: isText, status,
    currentFrontier: arrayOf(isText), currentStepId: textOrNull, hopCount: isInteger, fallbackSynthesis: textOrNull,
    lastContinuationDecision: objectOrNull, completedAt: textOrNull, version: isInteger, resumeCount: isInteger, hopsBaseline: isInteger,
    deadline: withDeadline ? deadline : optional(deadline), boundRig: optional(textOrNull), lifecycleOperationKey: optional(textOrNull), compiledInputDigest: optional(textOrNull),
    lifecycleBinding: optional(objectOrNull), frontierPackets: optional(arrayOf(isWorkflowFrontierPacket)), failureOccurrences: optional(arrayOf(isWorkflowFailureOccurrence)),
    boundaryObligations: optional(arrayOf(isWorkflowBoundaryObligation)), unknowns: optional(arrayOf(isText)), reconciliation: optional(isWorkflowReconciliation), guidance: optional(isObject),
  }) && (!Array.isArray(v.failureOccurrences) || v.failureOccurrences.every(f => isObject(f) && f.instanceId === v.instanceId));
}
export function isWorkflowInstance(v: unknown): v is WorkflowInstanceWithDeadline {
  return workflowInstanceShape(v, true);
}
export function isWorkflowTrace(v: unknown): v is WorkflowTrace {
  return hasShape(v, { instance: isWorkflowInstance, trail: arrayOf(x => hasShape(x, { trailId: isText, instanceId: isText, stepId: isText, stepRole: isText,
    closedAt: isText, closureReason: oneOf("handoff", "waiting", "done", "failed"), closureEvidence: objectOrNull, actorSession: isText, nextQitemId: textOrNull, priorQitemId: isText })),
    frontier: optional(arrayOf(isWorkflowFrontierPacket)), failures: optional(arrayOf(isWorkflowFailureOccurrence)), boundaryObligations: optional(arrayOf(isWorkflowBoundaryObligation)),
    unknowns: optional(arrayOf(isText)), guidance: optional(isObject), reconciliation: optional(isWorkflowReconciliation),
  }) && isObject(v.instance) && (v.trail as Record<string, unknown>[]).every(t => t.instanceId === (v.instance as Record<string, unknown>).instanceId)
    && (!Array.isArray(v.failures) || v.failures.every(f => isObject(f) && f.instanceId === (v.instance as Record<string, unknown>).instanceId));
}
export function isWorkflowOperation(v: unknown): v is WorkflowOperation {
  return hasShape(v, { kind: isText, receipt: x => hasShape(x, { operationKey: isText, instanceId: isText }), instance: x => workflowInstanceShape(x, false), replayed: optional(isBoolean) })
    && isObject(v.receipt) && isObject(v.instance) && v.receipt.instanceId === v.instance.instanceId;
}
export function isWorkflowLifecycleExecution(v: unknown): v is WorkflowLifecycleExecution {
  return hasShape(v, { instance_id: isText, workflow_name: isText, workflow_version: isText, description: textOrNull, status,
    operation_key: textOrNull, compiled_input_digest: textOrNull, identity: isObject, sources: arrayOf(isObject), dependencies: arrayOf(isObject), graph_source: objectOrNull,
    steps: arrayOf(x => hasShape(x, { id: isText, objective: textOrNull, next_hop: () => true })), reconciliation: isWorkflowReconciliation,
    boundary_obligations: arrayOf(isWorkflowBoundaryObligation), frontier_packets: arrayOf(x => hasShape(x, { packet_id: isText, step_id: isText, owner: isText, queue_state: isText,
      blocked_on: textOrNull, blocker: objectOrNull, summary: textOrNull, evidence_ref: textOrNull, objective: textOrNull, latest_transition: nullable(x => hasShape(x, { ts: isText, state: isText, transition_note: textOrNull, actor_session: isText })),
      wake: nullable(x => hasShape(x, { kind: oneOf("watchdog", "timer", "blocker"), ref: isText, phase: oneOf("armed", "fired"), live: isBoolean, deliveryStatus: textOrNull, unconsumed: isBoolean, expiresAt: optional(isText), recoveryOwner: optional(isText) })),
      wake_schedule: nullable(x => hasShape(x, { policy: isText, interval_seconds: isNumber, last_evaluation_at: textOrNull })), depends_on: arrayOf(isText), gate: objectOrNull, acceptance: objectOrNull, targeted_action: isText })),
    failure_occurrences: arrayOf(x => hasShape(x, { occurrence_id: isText, step_id: isText, status: oneOf("unresolved", "resolved"), failure_reason: textOrNull,
      redrive_packet_id: textOrNull, failed_at: isText, resolved_at: textOrNull, targeted_action: textOrNull })), unknowns: arrayOf(isText) });
}

/** No implicit choice: callers explicitly choose an occurrence, even when one
 * exists. Preserve resolved attempts for inspection/replay readback. */
export function workflowFailureChoices(instance: WorkflowInstanceWithDeadline, failures = instance.failureOccurrences) {
  const sameInstance = failures?.every(f => f.instanceId === instance.instanceId) ?? false;
  const choices = sameInstance ? failures!.filter(f => f.status === "unresolved" && f.targetedAction === "resume") : [];
  const state = instance.status === "completed" || instance.status === "aborted" ? "terminal"
    : !sameInstance ? "unavailable" : choices.length === 0 ? "none" : choices.length === 1 ? "single" : "multiple";
  return { state, choices: state === "terminal" ? [] : choices, occurrences: failures, requiresExplicitSelection: true as const };
}

export type WorkflowSequentialFailureState =
  | { state: "eligible"; selection: { version: number; failedPacketId: string; stepId: string } }
  | { state: "ineligible"; reason: "terminal" | "not-failed" | "occurrences-unavailable" | "occurrence-backed" | "failure-unrecorded" };

/** A serial executor's failure has no occurrence row; its identity is the
 * instance's served version plus the recorded failed packet and step. Only a
 * failed instance whose every served occurrence projection is an EMPTY array
 * qualifies. Absent projections or any occurrence row never fall into this
 * path, and nothing is inferred from display text. */
export function workflowSequentialFailure(instance: WorkflowInstanceWithDeadline, failures = instance.failureOccurrences): WorkflowSequentialFailureState {
  if (instance.status === "completed" || instance.status === "aborted") return { state: "ineligible", reason: "terminal" };
  if (instance.status !== "failed") return { state: "ineligible", reason: "not-failed" };
  const served = [failures, instance.failureOccurrences].filter((f) => f !== undefined);
  if (!served.length || !served.every(Array.isArray)) return { state: "ineligible", reason: "occurrences-unavailable" };
  if (served.some((f) => f!.length > 0)) return { state: "ineligible", reason: "occurrence-backed" };
  const decision = instance.lastContinuationDecision;
  const failedPacketId = isObject(decision) ? decision.closedPacket : undefined;
  const stepId = isObject(decision) ? decision.currentStep : undefined;
  if (!Number.isSafeInteger(instance.version) || instance.version < 0 || !isText(failedPacketId) || !failedPacketId.trim() || !isText(stepId) || !stepId.trim())
    return { state: "ineligible", reason: "failure-unrecorded" };
  return { state: "eligible", selection: { version: instance.version, failedPacketId, stepId } };
}
