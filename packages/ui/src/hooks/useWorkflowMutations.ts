import { useMutation, useQueryClient } from "@tanstack/react-query";
import { hasShape, isInteger, isObject, isText, optional, isBoolean, operatorScopeKey, operatorScopeState,
  LOCAL_OPERATOR_INSTANCE, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
import { isWorkflowOperation, type WorkflowOperation } from "../lib/workflow-contracts.js";

export interface WorkflowResumeInput { occurrenceId: string; actorSession: string; decision?: string }
export interface WorkflowResumeResult extends Record<string, unknown> {
  instanceId: string; stepId: string; newPacketId: string; ownerSession: string; resumeCount: number; exceptionItemsClosed: number; absorbedReplay?: boolean;
}
export interface WorkflowRevisionInput { operationKey: string; expectedVersion: number; expectedDigest: string; actorSession: string; reason: string }
export interface WorkflowMutationAttempt { readonly instanceId: string; readonly kind: "resume" | "revision"; readonly payload: Readonly<WorkflowResumeInput | WorkflowRevisionInput> }
export type WorkflowMutationErrorCode = "unsupported_scope" | "invalid_request" | "cancelled" | "rejected" | "outcome_unknown";
export class WorkflowMutationError extends Error {
  constructor(readonly code: WorkflowMutationErrorCode, message: string, readonly attempt?: WorkflowMutationAttempt,
    readonly status?: number, readonly serverCode?: string, readonly details?: unknown) {
    super(message); this.name = "WorkflowMutationError";
  }
}
const nonempty = (v: unknown): v is string => isText(v) && !!v.trim();
function validateTarget(scope: OperatorInstanceScope, instanceId: string) {
  const error = operatorScopeState(scope).scopeError;
  if (error) throw new WorkflowMutationError("unsupported_scope", error.message);
  if (!nonempty(instanceId)) throw new WorkflowMutationError("invalid_request", "Workflow mutations require an exact instance ID.");
}

// Expected pre-commit conflicts from workflow resume/revision, with the route's
// exact status mapping. An unknown/new error cannot prove that nothing committed.
const knownRejectionStatus: Readonly<Record<string, number>> = {
  instance_not_found: 404, instance_version_conflict: 409, lifecycle_revision_conflict: 409,
  failure_occurrence_required: 409, failure_occurrence_not_unresolved: 409,
  failure_occurrence_replay_conflict: 409, failure_occurrence_replay_indeterminate: 409,
  instance_not_failed: 409, instance_not_resumable: 409, spec_not_cached: 409,
  resume_step_unrecoverable: 409, resume_step_missing_from_spec: 409,
  next_owner_unresolved: 400, harness_pin_unsatisfied: 409, bound_rig_not_found: 409,
  "actorSession is required": 400,
};

/** Exactly one POST. A lost/invalid success has unknown outcome, with immutable
 * submitted bytes retained. Resume has no operation-key API: inspect its exact
 * occurrence/redrive receipt; revisions recover their existing operation key. */
async function postWorkflow<T>(attempt: WorkflowMutationAttempt, validate: (v: unknown) => v is T, options: OperatorReadOptions): Promise<T> {
  if (options.signal?.aborted) throw new WorkflowMutationError("cancelled", "Workflow mutation cancelled before submission.", attempt);
  const route = `/api/workflow/${encodeURIComponent(attempt.instanceId)}/${attempt.kind}`;
  const controller = new AbortController();
  let response: Response | undefined;
  const unknown = (reason: string, serverCode?: string, details?: unknown) => new WorkflowMutationError("outcome_unknown",
    `${reason} The mutation may have committed. Inspect ${attempt.kind === "revision" ? "the retained operation key" : "the exact failure occurrence and redrive receipt"} before deciding another action.`, attempt, response?.status, serverCode, details);
  let rejectAbort!: (error: WorkflowMutationError) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (reason: string) => { rejectAbort(unknown(reason)); controller.abort(); void response?.body?.cancel().catch(() => {}); };
  const onAbort = () => abort("Workflow response cancelled after submission.");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort("Workflow response timed out after 5 seconds."), 5_000);
  const request = (async () => {
    try {
      response = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(attempt.payload), signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw unknown("Workflow response was interrupted."); }
      let value: unknown;
      try { value = await response.json(); } catch {
        throw unknown(`Workflow HTTP ${response.status} response was not valid JSON.`);
      }
      if (!response.ok) {
        const serverCode = isObject(value) && isText(value.error) ? value.error : undefined;
        const message = isObject(value) && isText(value.message) ? value.message : serverCode ?? `HTTP ${response.status}`;
        if (serverCode && Object.hasOwn(knownRejectionStatus, serverCode) && knownRejectionStatus[serverCode] === response.status)
          throw new WorkflowMutationError("rejected", message, attempt, response.status, serverCode, value);
        // A wake/notification can fail after the transaction commits. HTTP 500
        // (or a proxy's error) alone says nothing about the durable outcome.
        throw unknown(`Workflow returned HTTP ${response.status}: ${message}.`, serverCode, value);
      }
      if (!validate(value)) throw unknown("Workflow success response did not match the submitted identity/contract.");
      return value;
    } catch (error) {
      if (error instanceof WorkflowMutationError) throw error;
      throw unknown("Workflow response could not be read.");
    }
  })();
  try { return await Promise.race([request, aborted]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}

export async function resumeWorkflowOccurrence(scope: OperatorInstanceScope, instanceId: string, input: WorkflowResumeInput, options: OperatorReadOptions = {}): Promise<WorkflowResumeResult> {
  validateTarget(scope, instanceId);
  if (!input || !nonempty(input.occurrenceId) || !nonempty(input.actorSession) || (input.decision !== undefined && !isText(input.decision)))
    throw new WorkflowMutationError("invalid_request", "Resume requires an explicitly selected occurrence ID and actor; decision bytes must be a string.");
  const payload = Object.freeze({ occurrenceId: input.occurrenceId, actorSession: input.actorSession, ...(input.decision !== undefined ? { decision: input.decision } : {}) });
  const attempt = Object.freeze({ instanceId, kind: "resume" as const, payload });
  return postWorkflow(attempt, (v): v is WorkflowResumeResult => hasShape(v, { instanceId: x => x === instanceId, stepId: nonempty,
    newPacketId: nonempty, ownerSession: nonempty, resumeCount: isInteger, exceptionItemsClosed: isInteger, absorbedReplay: optional(isBoolean) }), options);
}
export async function reviseWorkflow(scope: OperatorInstanceScope, instanceId: string, input: WorkflowRevisionInput, options: OperatorReadOptions = {}): Promise<WorkflowOperation> {
  validateTarget(scope, instanceId);
  if (!input || !nonempty(input.operationKey) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !nonempty(input.expectedDigest)
    || !nonempty(input.actorSession) || !nonempty(input.reason))
    throw new WorkflowMutationError("invalid_request", "Revision requires the inspected version/digest, a retained operation key, actor and reason.");
  const payload = Object.freeze({ operationKey: input.operationKey, expectedVersion: input.expectedVersion, expectedDigest: input.expectedDigest, actorSession: input.actorSession, reason: input.reason });
  const attempt = Object.freeze({ instanceId, kind: "revision" as const, payload });
  return postWorkflow(attempt, (v): v is WorkflowOperation => isWorkflowOperation(v) && v.kind === "revision" && v.instance.instanceId === instanceId
    && v.receipt.operationKey === payload.operationKey && v.receipt.expectedVersion === payload.expectedVersion
    && v.receipt.compiledInputDigest === payload.expectedDigest && v.receipt.actorSession === payload.actorSession && v.receipt.reason === payload.reason, options);
}

export function useWorkflowResume(instanceId: string | null, scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const queryClient = useQueryClient();
  const mutation = useMutation<WorkflowResumeResult, WorkflowMutationError, WorkflowResumeInput>({
    mutationKey: ["workflow", ...operatorScopeKey(scope), "resume", instanceId], retry: false,
    mutationFn: input => resumeWorkflowOccurrence(scope, instanceId ?? "", input),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["workflow", ...operatorScopeKey(scope)] }); },
  });
  return { ...mutation, ...operatorScopeState(scope) };
}
export function useWorkflowRevise(instanceId: string | null, scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const queryClient = useQueryClient();
  const mutation = useMutation<WorkflowOperation, WorkflowMutationError, WorkflowRevisionInput>({
    mutationKey: ["workflow", ...operatorScopeKey(scope), "revision", instanceId], retry: false,
    mutationFn: input => reviseWorkflow(scope, instanceId ?? "", input),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["workflow", ...operatorScopeKey(scope)] }); },
  });
  return { ...mutation, ...operatorScopeState(scope) };
}
