// Sequential-failure Resume. A serial workflow (no depends_on) records its
// failure on the instance itself, not as a failure occurrence, so there is no
// occurrence to choose. The operator reviews the exact served version, failed
// packet and step; the POST carries those bytes as `expectedFailure` and the
// daemon refuses it if that failure is no longer current. If the read changes
// while reviewing, the review is void and must be repeated. One POST per
// confirmation; an uncertain outcome locks this instance's sequential resume
// until it is read back, and nothing is retried automatically.

import { useMemo } from "react";
import type { WorkflowFailureOccurrence, WorkflowInstanceWithDeadline } from "../../lib/workflow-contracts.js";
import { workflowSequentialFailure } from "../../lib/workflow-contracts.js";
import { isText, LOCAL_OPERATOR_INSTANCE, type OperatorInstanceScope, type OperatorReadError } from "../../lib/operator-read.js";
import { useWorkflowSequentialResume, type WorkflowMutationError, type WorkflowResumeResult, type WorkflowSequentialFailure,
  type WorkflowSequentialResumeInput } from "../../hooks/useWorkflowMutations.js";
import { Field, Fields, Panel, Tag, Timestamp } from "../project/catalog/evidence-ui.js";
import { readBackSequentialResume, type SequentialResumeReadback } from "./workflow-recovery.js";
import { asMutationError, OtherInstanceAttempts, useTargetTraceReadback } from "./WorkflowControls.js";
import { recoveryTarget, recoveryTargetKey, useOtherInstanceEntries, useRecoveryEntry, useTargetState, type RecoveryTarget } from "./recovery-ledger.js";
import { SURFACE_ACTOR } from "./surface-actor.js";

export type SequentialResumeOutcome =
  | { kind: "pending"; attempt: Readonly<WorkflowSequentialResumeInput> }
  | { kind: "succeeded"; attempt: Readonly<WorkflowSequentialResumeInput>; result: WorkflowResumeResult }
  | { kind: "rejected"; attempt: Readonly<WorkflowSequentialResumeInput>; error: WorkflowMutationError }
  | { kind: "unknown"; attempt: Readonly<WorkflowSequentialResumeInput>; error: WorkflowMutationError; readback: SequentialResumeReadback | null; readAt: string | null; readError: OperatorReadError | null; reading: boolean };

const retained = (o: SequentialResumeOutcome) => o.kind === "pending" || (o.kind === "unknown" && (o.readback === null || o.readback.kind === "missing"));
const sameFailure = (a: WorkflowSequentialFailure, b: WorkflowSequentialFailure) =>
  a.version === b.version && a.failedPacketId === b.failedPacketId && a.stepId === b.stepId;

function AttemptBytes({ instanceId, attempt }: { instanceId: string; attempt: Readonly<WorkflowSequentialResumeInput> }) {
  return (
    <Fields testId="workflow-sequential-attempt">
      <Field label="Sent to"><span className="font-mono text-[11px]">{instanceId}</span></Field>
      <Field label="Expected step">{attempt.expectedFailure.stepId}</Field>
      <Field label="Expected packet"><span className="font-mono text-[11px]">{attempt.expectedFailure.failedPacketId}</span></Field>
      <Field label="Expected version">{attempt.expectedFailure.version}</Field>
      <Field label="Actor"><span className="font-mono text-[11px]">{attempt.actorSession}</span></Field>
      <Field label="Decision"><span className="whitespace-pre-wrap font-mono text-[11px]">{attempt.decision === undefined ? "none sent" : JSON.stringify(attempt.decision)}</span></Field>
    </Fields>
  );
}

export function SequentialFailurePanel({ instance, failures, scope = LOCAL_OPERATOR_INSTANCE }: {
  instance: WorkflowInstanceWithDeadline;
  failures: WorkflowFailureOccurrence[] | undefined;
  scope?: OperatorInstanceScope;
}) {
  const target = useMemo(() => recoveryTarget(scope, instance.instanceId, "resume-sequential"), [scope, instance.instanceId]);
  const targetKey = recoveryTargetKey(target);
  const resume = useWorkflowSequentialResume(instance.instanceId, scope);
  const readTrace = useTargetTraceReadback();
  const { entry, write, writerFor } = useRecoveryEntry<SequentialResumeOutcome>(target);
  const others = useOtherInstanceEntries<SequentialResumeOutcome>(target, retained);
  const [actor, setActor] = useTargetState(targetKey, SURFACE_ACTOR);
  const [decision, setDecision] = useTargetState(targetKey, "");
  const [reviewed, setReviewed] = useTargetState<WorkflowSequentialFailure | null>(targetKey, null);
  const outcome = entry?.outcome;

  const current = workflowSequentialFailure(instance, failures);
  const selection = current.state === "eligible" ? current.selection : null;
  if (!selection && !outcome && !others.length) return null;

  // A review is valid only for the exact failure it was opened against.
  const reviewCurrent = reviewed !== null && selection !== null && sameFailure(reviewed, selection);
  const locked = outcome !== undefined && retained(outcome);
  const canSubmit = reviewCurrent && actor.trim() !== "" && !locked && resume.scopeSupported;
  const lcd = instance.lastContinuationDecision;

  const submit = () => {
    if (!canSubmit) return;
    const attempt: Readonly<WorkflowSequentialResumeInput> = Object.freeze({
      expectedFailure: Object.freeze({ ...reviewed! }), actorSession: actor, ...(decision !== "" ? { decision } : {}) });
    const record = writerFor<SequentialResumeOutcome>(target);
    setReviewed(null);
    record({ kind: "pending", attempt });
    resume.mutateAsync(attempt).then(
      (result) => record({ kind: "succeeded", attempt, result }),
      (raw: unknown) => {
        const error = asMutationError(raw);
        record(error.code === "outcome_unknown"
          ? { kind: "unknown", attempt, error, readback: null, readAt: null, readError: null, reading: false }
          : { kind: "rejected", attempt, error });
      });
  };

  /** Reads exactly the instance the attempt was sent to. */
  const inspect = (current: Extract<SequentialResumeOutcome, { kind: "unknown" }>, to: RecoveryTarget) => {
    const record = writerFor<SequentialResumeOutcome>(to);
    record({ ...current, reading: true });
    readTrace(to).then(
      (trace) => record({ ...current, reading: false, readError: null, readAt: new Date().toISOString(),
        readback: readBackSequentialResume(to.instanceId, current.attempt, trace.instance) }),
      (error: OperatorReadError) => record({ ...current, reading: false, readError: error, readAt: new Date().toISOString(), readback: { kind: "missing" } }));
  };

  return (
    <Panel title="Sequential failure" testId="workflow-sequential-failure"
      note="This workflow runs steps in sequence and records its failure on the instance, not as a failure occurrence. Resume is bound to the exact version, failed packet and step shown here."
      right={<Tag tone={selection ? "bad" : "muted"} testId="workflow-sequential-state">{selection ? "failed" : instance.status}</Tag>}>
      <OtherInstanceAttempts entries={others} what="sequential resume" testId="workflow-sequential-other" />
      {selection ? (
        <Fields testId="workflow-sequential-source">
          <Field label="Failed step" testId="workflow-sequential-step">{selection.stepId}</Field>
          <Field label="Failed packet" testId="workflow-sequential-packet"><span className="font-mono text-[11px]">{selection.failedPacketId}</span></Field>
          <Field label="Instance version" testId="workflow-sequential-version">{selection.version}</Field>
          {isText(lcd?.resultNote) ? <Field label="Recorded note"><span className="whitespace-pre-wrap">{lcd.resultNote}</span></Field> : null}
          {isText(lcd?.actorSession) ? <Field label="Closed by"><span className="font-mono text-[11px]">{lcd.actorSession}</span></Field> : null}
          {instance.completedAt ? <Field label="Failed at"><Timestamp iso={instance.completedAt} /></Field> : null}
        </Fields>
      ) : null}

      {reviewed !== null && !reviewCurrent ? (
        <p role="status" data-testid="workflow-sequential-review-stale" className="mt-2 border-l-2 border-warning pl-2 text-sm">
          The recorded failure changed after you reviewed step <b>{reviewed.stepId}</b> (packet <span className="font-mono">{reviewed.failedPacketId}</span>, version {reviewed.version}).
          Nothing was sent. {selection ? "Review the current failure below." : "No sequential failure is current."}
        </p>
      ) : null}

      {selection ? (
        <fieldset disabled={locked} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <legend className="sr-only">Resume the sequential failure</legend>
          <label className="block text-xs">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Actor recorded on the redrive</span>
            <input data-testid="workflow-sequential-actor" value={actor} onChange={(e) => setActor(e.target.value)}
              className="mt-0.5 w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface" />
          </label>
          <label className="block text-xs sm:row-span-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Decision (optional, sent exactly as typed)</span>
            <textarea data-testid="workflow-sequential-decision" value={decision} onChange={(e) => setDecision(e.target.value)} rows={3}
              className="mt-0.5 w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface" />
            <span className="text-on-surface-variant">Leave empty to send no decision.</span>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            {!reviewCurrent ? (
              <button type="button" data-testid="workflow-sequential-review" disabled={locked || !resume.scopeSupported} onClick={() => setReviewed(selection)}
                className="border border-on-surface px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-low disabled:cursor-not-allowed disabled:opacity-50">
                Resume {selection.stepId}…
              </button>
            ) : (
              <div data-testid="workflow-sequential-confirm" role="group" aria-label="Confirm sequential resume" className="w-full border border-on-surface px-3 py-2 text-sm">
                Redrive step <b>{reviewed!.stepId}</b> from failed packet <span className="font-mono">{reviewed!.failedPacketId}</span> (instance version {reviewed!.version}) as <span className="font-mono">{actor}</span>
                {decision !== "" ? <> with decision <span className="font-mono">{JSON.stringify(decision)}</span></> : " with no decision"}?
                The daemon refuses it if this is no longer the current failure.
                <div className="mt-2 flex gap-2">
                  <button type="button" data-testid="workflow-sequential-confirm-send" onClick={submit} disabled={!canSubmit}
                    className="border border-on-surface bg-inverse-surface px-3 py-1 font-mono text-[11px] uppercase text-background disabled:opacity-50">Confirm resume</button>
                  <button type="button" onClick={() => setReviewed(null)} className="border border-outline-variant px-3 py-1 font-mono text-[11px] uppercase">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </fieldset>
      ) : null}
      {outcome?.kind === "pending" ? (
        <p role="status" data-testid="workflow-sequential-pending" className="mt-2 animate-pulse font-mono text-[11px]">Resuming step {outcome.attempt.expectedFailure.stepId}…</p>
      ) : null}

      {!resume.scopeSupported ? <p role="alert" className="mt-2 text-sm text-tertiary">{resume.scopeError?.message}</p> : null}

      {outcome?.kind === "succeeded" ? (
        <div role="status" data-testid="workflow-sequential-succeeded" className="mt-3 border border-outline-variant px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em]">Resume recorded</span>
          <p className="mt-1">Step {outcome.result.stepId} redriven from failed packet <span className="font-mono">{outcome.attempt.expectedFailure.failedPacketId}</span> as packet <span className="font-mono">{outcome.result.newPacketId}</span>, owned by <span className="font-mono">{outcome.result.ownerSession}</span>. Resume count {outcome.result.resumeCount}; {outcome.result.exceptionItemsClosed} exception item(s) closed.</p>
          <p className="mt-1 text-xs text-on-surface-variant">A new work packet is not an accepted outcome.</p>
          <button type="button" onClick={() => write(undefined)} className="mt-2 border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low">Dismiss</button>
        </div>
      ) : null}
      {outcome?.kind === "rejected" ? (
        <div role="alert" data-testid="workflow-sequential-rejected" className="mt-3 border border-tertiary px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-tertiary">Resume refused · {outcome.error.serverCode ?? outcome.error.code}{outcome.error.status ? ` · HTTP ${outcome.error.status}` : ""}</span>
          <p className="mt-1">{outcome.error.message}</p>
          <AttemptBytes instanceId={entry!.target.instanceId} attempt={outcome.attempt} />
          <p className="mt-1 text-xs text-on-surface-variant">
            {outcome.error.serverCode === "resume_failure_changed"
              ? "The failure you reviewed is no longer current. The instance was re-read; review what is shown now before deciding again."
              : "The daemon refused this request before committing. The instance was re-read; decide again deliberately."}
          </p>
          <button type="button" onClick={() => write(undefined)} className="mt-2 border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low">Dismiss</button>
        </div>
      ) : null}
      {outcome?.kind === "unknown" ? (
        <div role="alert" data-testid="workflow-sequential-unknown" className="mt-3 border border-warning px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-warning">Outcome unknown{outcome.error.status ? ` · HTTP ${outcome.error.status}` : ""}{outcome.error.serverCode ? ` · ${outcome.error.serverCode}` : ""}</span>
          <p className="mt-1">{outcome.error.message}</p>
          <AttemptBytes instanceId={entry!.target.instanceId} attempt={outcome.attempt} />
          {outcome.readback === null ? <p className="mt-1">Resume is locked until this instance is read back. Nothing is retried automatically.</p> : null}
          {outcome.readback?.kind === "same-failure" ? (
            <p data-testid="workflow-sequential-readback-same" className="mt-1">Read back <Timestamp iso={outcome.readAt} />: still failed at version {outcome.readback.instance.version} with the same failed packet and step. The request had not committed as of this read; if it still lands, it can only resume this exact failure. Resume is unlocked; submitting again is a deliberate new decision.</p>
          ) : null}
          {outcome.readback?.kind === "changed" ? (
            <p data-testid="workflow-sequential-readback-changed" className="mt-1">Read back <Timestamp iso={outcome.readAt} />: the instance is now {outcome.readback.instance.status} at version {outcome.readback.instance.version} (resume count {outcome.readback.instance.resumeCount}). This read cannot show whether this request or another resume committed; the outcome remains unknown. Do not resubmit it. A later failure is a new one and needs its own review.</p>
          ) : null}
          {outcome.readback?.kind === "missing" ? (
            <p data-testid="workflow-sequential-readback-missing" className="mt-1">Read back <Timestamp iso={outcome.readAt} />: {outcome.readError ? `the instance could not be read (${outcome.readError.message})` : "the instance was not served"}. The outcome remains unknown.</p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <button type="button" data-testid="workflow-sequential-inspect" onClick={() => inspect(outcome, entry!.target)} disabled={outcome.reading}
              className="border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low disabled:opacity-50">
              {outcome.reading ? "Reading…" : `Inspect instance ${entry!.target.instanceId}`}
            </button>
            {outcome.readback && outcome.readback.kind !== "missing" ? (
              <button type="button" onClick={() => write(undefined)} className="border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low">Dismiss</button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
