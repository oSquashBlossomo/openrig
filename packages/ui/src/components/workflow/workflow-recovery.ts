// Pure recovery decisions for workflow mutations. An uncertain POST is never
// replayed automatically; the exact retained target is read back first.

import type { WorkflowFailureOccurrence, WorkflowInstanceWithDeadline, WorkflowOperation, WorkflowReconciliation } from "../../lib/workflow-contracts.js";
import type { WorkflowAbortInput, WorkflowResumeInput, WorkflowRevisionInput } from "../../hooks/useWorkflowMutations.js";
import type { OperatorReadError } from "../../lib/operator-read.js";

export type ResumeReadback =
  /** The selected occurrence is resolved by exactly the submitted decision bytes. */
  | { kind: "committed"; occurrence: WorkflowFailureOccurrence }
  /** Resolved, but with different decision bytes: another decision won. */
  | { kind: "resolved-differently"; occurrence: WorkflowFailureOccurrence }
  /** Still unresolved as of this read. The request may have been refused or may still land. */
  | { kind: "still-unresolved"; occurrence: WorkflowFailureOccurrence }
  /** The read does not include the occurrence; the outcome stays unknown. */
  | { kind: "missing" };

/** `instanceId` is the instance the attempt was SENT to; an occurrence served
 * for any other instance is not evidence about this attempt. */
export function readBackResume(instanceId: string, attempt: Readonly<WorkflowResumeInput>, occurrences: readonly WorkflowFailureOccurrence[] | undefined): ResumeReadback {
  const occurrence = occurrences?.find((o) => o.occurrenceId === attempt.occurrenceId && o.instanceId === instanceId);
  if (!occurrence) return { kind: "missing" };
  if (occurrence.status === "unresolved") return { kind: "still-unresolved", occurrence };
  return occurrence.resumeDecision === (attempt.decision ?? null) && occurrence.redrivePacketId !== null
    ? { kind: "committed", occurrence }
    : { kind: "resolved-differently", occurrence };
}

export type AbortReadback = { kind: "committed" } | { kind: "terminal-other"; status: string } | { kind: "not-aborted"; status: string };

export function readBackAbort(instanceId: string, attempt: Readonly<WorkflowAbortInput>, instance: WorkflowInstanceWithDeadline | undefined): AbortReadback | { kind: "missing" } {
  if (!instance || instance.instanceId !== instanceId) return { kind: "missing" };
  if (instance.status !== "aborted") return instance.status === "completed" ? { kind: "terminal-other", status: instance.status } : { kind: "not-aborted", status: instance.status };
  const decision = instance.lastContinuationDecision;
  return decision && decision.action === "abort" && decision.actorSession === attempt.actorSession && decision.reason === attempt.reason
    ? { kind: "committed" } : { kind: "terminal-other", status: "aborted by a different decision" };
}

export type RevisionReadback =
  /** The key's receipt names this instance and exactly the submitted bytes. */
  | { kind: "committed"; operation: WorkflowOperation }
  /** The key is recorded against another instance: never resubmit it here. */
  | { kind: "other-instance"; operation: WorkflowOperation; recordedInstanceId: string }
  /** Recorded for this instance, but with different version/digest/actor/reason bytes. */
  | { kind: "different-bytes"; operation: WorkflowOperation; fields: string[] }
  /** No effect is recorded under this key yet. Resubmitting the same bytes is replay-safe. */
  | { kind: "not-found" }
  | { kind: "unreadable"; error: OperatorReadError | null };

export function readBackRevision(instanceId: string, attempt: Readonly<WorkflowRevisionInput>, operation: WorkflowOperation | undefined, error: OperatorReadError | null): RevisionReadback {
  if (!operation) return error?.serverCode === "operation_not_found" ? { kind: "not-found" } : { kind: "unreadable", error };
  const receipt = operation.receipt;
  const recorded = typeof receipt.instanceId === "string" ? receipt.instanceId : operation.instance.instanceId;
  if (recorded !== instanceId) return { kind: "other-instance", operation, recordedInstanceId: recorded };
  const fields = ([
    ["expected version", receipt.expectedVersion, attempt.expectedVersion],
    ["digest", receipt.compiledInputDigest, attempt.expectedDigest],
    ["actor", receipt.actorSession, attempt.actorSession],
    ["reason", receipt.reason, attempt.reason],
  ] as const).filter(([, served, sent]) => served !== sent).map(([name]) => name);
  return fields.length ? { kind: "different-bytes", operation, fields } : { kind: "committed", operation };
}

/** A revision may be applied only when the served proposal is compatible,
 * not yet adopted, and carries its digest and stable operation key. */
export function revisionProposal(view: WorkflowReconciliation | undefined): { applicable: true; operationKey: string; expectedVersion: number; expectedDigest: string } | { applicable: false; reason: string } {
  if (!view) return { applicable: false, reason: "No reconciliation is served for this instance." };
  if (view.status === "current") return { applicable: false, reason: "The running plan already matches the authored sources." };
  if (view.status === "unbound" || view.status === "unavailable") return { applicable: false, reason: `Reconciliation is ${view.status}.` };
  if (!view.compatible) return { applicable: false, reason: "The authored change is not compatible with work already done; existing work is preserved." };
  if (view.adopted) return { applicable: false, reason: "This proposal is already adopted." };
  if (!view.proposedDigest || !view.operationKey) return { applicable: false, reason: "The proposal carries no digest or operation key to apply." };
  return { applicable: true, operationKey: view.operationKey, expectedVersion: view.expectedVersion, expectedDigest: view.proposedDigest };
}
