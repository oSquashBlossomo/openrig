// Occurrence-specific Resume. The operator chooses exactly which unresolved
// failure occurrence to redrive, as which actor, with which decision bytes.
// Nothing is preselected (even a single failure), one POST is sent per
// confirmation, and an uncertain outcome locks further resumes of this
// instance until the selected occurrence has been read back. A refresh never
// retargets the selection to a different failure, and a route change to
// another instance never carries the selection, attempt or readback along.

import { useMemo } from "react";
import type { WorkflowFailureOccurrence, WorkflowInstanceWithDeadline } from "../../lib/workflow-contracts.js";
import { workflowFailureChoices } from "../../lib/workflow-contracts.js";
import { LOCAL_OPERATOR_INSTANCE, type OperatorInstanceScope, type OperatorReadError } from "../../lib/operator-read.js";
import { useWorkflowResume, type WorkflowMutationError, type WorkflowResumeInput, type WorkflowResumeResult } from "../../hooks/useWorkflowMutations.js";
import { cn } from "../../lib/utils.js";
import { Disclose, displayValue, Field, Fields, Panel, Tag, Timestamp } from "../project/catalog/evidence-ui.js";
import { readBackResume, type ResumeReadback } from "./workflow-recovery.js";
import { asMutationError, OtherInstanceAttempts, useTargetTraceReadback } from "./WorkflowControls.js";
import { recoveryTarget, recoveryTargetKey, useOtherInstanceEntries, useRecoveryEntry, useTargetState, type RecoveryTarget } from "./recovery-ledger.js";
import { SURFACE_ACTOR } from "./surface-actor.js";

export { SURFACE_ACTOR };

export type ResumeOutcome =
  | { kind: "pending"; attempt: Readonly<WorkflowResumeInput> }
  | { kind: "succeeded"; attempt: Readonly<WorkflowResumeInput>; result: WorkflowResumeResult }
  | { kind: "rejected"; attempt: Readonly<WorkflowResumeInput>; error: WorkflowMutationError }
  | { kind: "unknown"; attempt: Readonly<WorkflowResumeInput>; error: WorkflowMutationError; readback: ResumeReadback | null; readAt: string | null; readError: OperatorReadError | null; reading: boolean };

/** Pending, or uncertain and not yet located by a readback. */
const resumeRetained = (o: ResumeOutcome) => o.kind === "pending" || (o.kind === "unknown" && (o.readback === null || o.readback.kind === "missing"));

function OccurrenceFacts({ occurrence }: { occurrence: WorkflowFailureOccurrence }) {
  return (
    <Fields>
      <Field label="Step">{occurrence.stepId}</Field>
      <Field label="Failed packet"><span className="font-mono text-[11px]">{occurrence.failedPacketId}</span></Field>
      <Field label="Reason">{occurrence.failureReason ?? "not recorded"}</Field>
      <Field label="Failed at"><Timestamp iso={occurrence.failedAt} /></Field>
      <Field label="Branch drive">{occurrence.branchDrive} · hop {occurrence.hopCount} (baseline {occurrence.hopsBaseline})</Field>
      {occurrence.status === "resolved" ? (
        <>
          <Field label="Resolved at"><Timestamp iso={occurrence.resolvedAt} /></Field>
          <Field label="Redrive packet"><span className="font-mono text-[11px]">{occurrence.redrivePacketId ?? "not recorded"}</span></Field>
          <Field label="Decision"><span className="whitespace-pre-wrap font-mono text-[11px]">{occurrence.resumeDecision ?? "none recorded"}</span></Field>
        </>
      ) : null}
    </Fields>
  );
}

function AttemptBytes({ instanceId, attempt }: { instanceId: string; attempt: Readonly<WorkflowResumeInput> }) {
  return (
    <Fields testId="workflow-resume-attempt">
      <Field label="Sent to"><span className="font-mono text-[11px]">{instanceId}</span></Field>
      <Field label="Occurrence"><span className="font-mono text-[11px]">{attempt.occurrenceId}</span></Field>
      <Field label="Actor"><span className="font-mono text-[11px]">{attempt.actorSession}</span></Field>
      <Field label="Decision"><span className="whitespace-pre-wrap font-mono text-[11px]">{attempt.decision === undefined ? "none sent" : JSON.stringify(attempt.decision)}</span></Field>
    </Fields>
  );
}

export function FailureOccurrenceChooser({ instance, failures, scope = LOCAL_OPERATOR_INSTANCE }: {
  instance: WorkflowInstanceWithDeadline;
  failures: WorkflowFailureOccurrence[] | undefined;
  scope?: OperatorInstanceScope;
}) {
  const target = useMemo(() => recoveryTarget(scope, instance.instanceId, "resume"), [scope, instance.instanceId]);
  const targetKey = recoveryTargetKey(target);
  const resume = useWorkflowResume(instance.instanceId, scope);
  const readTrace = useTargetTraceReadback();
  const { entry, write, writerFor } = useRecoveryEntry<ResumeOutcome>(target);
  const others = useOtherInstanceEntries<ResumeOutcome>(target, resumeRetained);
  const choices = workflowFailureChoices(instance, failures);
  const [selectedId, setSelectedId] = useTargetState<string | null>(targetKey, null);
  const [actor, setActor] = useTargetState(targetKey, SURFACE_ACTOR);
  const [decision, setDecision] = useTargetState(targetKey, "");
  const [confirming, setConfirming] = useTargetState(targetKey, false);
  const outcome = entry?.outcome;

  const occurrences = choices.occurrences ?? [];
  const ordered = [...occurrences].sort((a, b) => Number(a.status === "resolved") - Number(b.status === "resolved") || a.failedAt.localeCompare(b.failedAt));
  const selected = selectedId ? occurrences.find((o) => o.occurrenceId === selectedId) ?? null : null;
  const selectedActionable = selected !== null && choices.choices.some((c) => c.occurrenceId === selected.occurrenceId);
  // Only a pending or uninspected (or unlocatable) uncertain attempt locks resuming.
  const locked = outcome !== undefined && resumeRetained(outcome);
  const canSubmit = selectedActionable && actor.trim() !== "" && !locked && choices.state !== "terminal" && resume.scopeSupported;

  const submit = () => {
    if (!canSubmit) return;
    const attempt: Readonly<WorkflowResumeInput> = Object.freeze({ occurrenceId: selected!.occurrenceId, actorSession: actor, ...(decision !== "" ? { decision } : {}) });
    const record = writerFor<ResumeOutcome>(target);
    setConfirming(false);
    record({ kind: "pending", attempt });
    resume.mutateAsync(attempt).then(
      (result) => record({ kind: "succeeded", attempt, result }),
      (raw: unknown) => {
        const error = asMutationError(raw);
        record(error.code === "outcome_unknown"
          ? { kind: "unknown", attempt: (error.attempt?.payload as WorkflowResumeInput | undefined) ?? attempt, error, readback: null, readAt: null, readError: null, reading: false }
          : { kind: "rejected", attempt, error });
      });
  };

  /** Reads exactly the instance the attempt was sent to. */
  const inspect = (current: Extract<ResumeOutcome, { kind: "unknown" }>, to: RecoveryTarget) => {
    const record = writerFor<ResumeOutcome>(to);
    record({ ...current, reading: true });
    readTrace(to).then(
      (trace) => record({ ...current, reading: false, readError: null, readAt: new Date().toISOString(),
        readback: readBackResume(to.instanceId, current.attempt, trace.failures ?? trace.instance.failureOccurrences) }),
      (error: OperatorReadError) => record({ ...current, reading: false, readError: error, readAt: new Date().toISOString(), readback: { kind: "missing" } }));
  };

  const stateNote = {
    unavailable: "Failure occurrences are not served for this instance, so no occurrence can be chosen.",
    none: "No unresolved failure occurrence is open.",
    single: "One unresolved failure occurrence is open. Choose it explicitly to resume.",
    multiple: `${choices.choices.length} unresolved failure occurrences are open. Choose exactly one; others stay unresolved.`,
    terminal: `This workflow is ${instance.status}; no failure can be resumed.`,
  }[choices.state];

  return (
    <Panel title="Failure occurrences" testId="workflow-failures" note={stateNote}
      right={<Tag tone={choices.choices.length ? "bad" : "muted"} testId="workflow-failures-state">{choices.state}</Tag>}>
      <OtherInstanceAttempts entries={others} what="resume" testId="workflow-resume-other" />
      {ordered.length ? (
        <fieldset disabled={locked} className="space-y-2">
          <legend className="sr-only">Failure occurrence to resume</legend>
          {ordered.map((o) => {
            const actionable = choices.choices.some((c) => c.occurrenceId === o.occurrenceId);
            return (
              <div key={o.occurrenceId} data-testid={`workflow-occurrence-${o.occurrenceId}`} data-status={o.status}
                className={cn("border px-3 py-2", o.occurrenceId === selectedId ? "border-on-surface bg-surface-low" : "border-outline-variant bg-surface-lowest")}>
                <label className={cn("flex items-start gap-2", actionable ? "cursor-pointer" : "cursor-default")}>
                  {actionable ? (
                    <input type="radio" name={`occurrence-${instance.instanceId}`} value={o.occurrenceId} checked={o.occurrenceId === selectedId}
                      data-testid={`workflow-occurrence-choose-${o.occurrenceId}`}
                      onChange={() => { setSelectedId(o.occurrenceId); setConfirming(false); }} className="mt-1" />
                  ) : <span aria-hidden className="mt-0.5 w-[13px] text-center text-on-surface-variant">·</span>}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Tag tone={o.status === "unresolved" ? "bad" : "muted"}>{o.status}</Tag>
                      <span className="text-sm">{o.stepId}</span>
                      <span className="font-mono text-[11px] text-on-surface-variant">{o.occurrenceId}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-on-surface-variant">{o.failureReason ?? "reason not recorded"}</span>
                  </span>
                </label>
                <Disclose summary="Occurrence record" testId={`workflow-occurrence-${o.occurrenceId}-record`} defaultOpen={o.occurrenceId === selectedId}>
                  <OccurrenceFacts occurrence={o} />
                </Disclose>
              </div>
            );
          })}
        </fieldset>
      ) : null}

      {selected && !selectedActionable ? (
        <p role="status" data-testid="workflow-selected-not-actionable" className="mt-2 border-l-2 border-warning pl-2 text-sm">
          The selected occurrence <span className="font-mono">{selected.occurrenceId}</span> is now {selected.status}
          {selected.redrivePacketId ? <> (redrive <span className="font-mono">{selected.redrivePacketId}</span>)</> : null}. It cannot be resumed again, and no other occurrence was selected for you.
        </p>
      ) : null}
      {selectedId && !selected ? (
        <p role="status" data-testid="workflow-selected-missing" className="mt-2 border-l-2 border-warning pl-2 text-sm">
          The selected occurrence is no longer served for this instance. Choose again; nothing was retargeted.
        </p>
      ) : null}

      {choices.state !== "terminal" && choices.state !== "unavailable" && choices.choices.length ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Actor recorded on the redrive</span>
            <input data-testid="workflow-resume-actor" value={actor} onChange={(e) => setActor(e.target.value)} disabled={locked}
              className="mt-0.5 w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface" />
          </label>
          <label className="block text-xs sm:row-span-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Decision (optional, sent exactly as typed)</span>
            <textarea data-testid="workflow-resume-decision" value={decision} onChange={(e) => setDecision(e.target.value)} disabled={locked} rows={3}
              className="mt-0.5 w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface" />
            <span className="text-on-surface-variant">Leave empty to send no decision. A later replay with different bytes is refused.</span>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            {!confirming ? (
              <button type="button" data-testid="workflow-resume" disabled={!canSubmit} onClick={() => setConfirming(true)}
                className="border border-on-surface px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-low disabled:cursor-not-allowed disabled:opacity-50">
                {selectedActionable ? `Resume ${selected!.stepId}…` : "Choose an occurrence"}
              </button>
            ) : (
              <div data-testid="workflow-resume-confirm" role="group" aria-label="Confirm resume" className="w-full border border-on-surface px-3 py-2 text-sm">
                Redrive step <b>{selected!.stepId}</b> for occurrence <span className="font-mono">{selected!.occurrenceId}</span> as <span className="font-mono">{actor}</span>
                {decision !== "" ? <> with decision <span className="font-mono">{JSON.stringify(decision)}</span></> : " with no decision"}?
                <div className="mt-2 flex gap-2">
                  <button type="button" data-testid="workflow-resume-confirm-send" onClick={submit} disabled={!canSubmit}
                    className="border border-on-surface bg-inverse-surface px-3 py-1 font-mono text-[11px] uppercase text-background disabled:opacity-50">Confirm resume</button>
                  <button type="button" onClick={() => setConfirming(false)} className="border border-outline-variant px-3 py-1 font-mono text-[11px] uppercase">Cancel</button>
                </div>
              </div>
            )}
            {outcome?.kind === "pending" ? <span role="status" data-testid="workflow-resume-pending" className="animate-pulse font-mono text-[11px]">Resuming occurrence {outcome.attempt.occurrenceId}…</span> : null}
          </div>
        </div>
      ) : null}

      {!resume.scopeSupported ? <p role="alert" className="mt-2 text-sm text-tertiary">{resume.scopeError?.message}</p> : null}

      {outcome?.kind === "succeeded" ? (
        <div role="status" data-testid="workflow-resume-succeeded" className="mt-3 border border-outline-variant px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em]">{outcome.result.absorbedReplay ? "Already resumed — replay absorbed" : "Resume recorded"}</span>
          <p className="mt-1">Occurrence <span className="font-mono">{outcome.attempt.occurrenceId}</span> redriven at step {outcome.result.stepId} as packet <span className="font-mono">{outcome.result.newPacketId}</span>, owned by <span className="font-mono">{outcome.result.ownerSession}</span>. Resume count {outcome.result.resumeCount}; {outcome.result.exceptionItemsClosed} exception item(s) closed.</p>
          <p className="mt-1 text-xs text-on-surface-variant">A new work packet is not an accepted outcome.</p>
          <button type="button" onClick={() => write(undefined)} className="mt-2 border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low">Dismiss</button>
        </div>
      ) : null}
      {outcome?.kind === "rejected" ? (
        <div role="alert" data-testid="workflow-resume-rejected" className="mt-3 border border-tertiary px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-tertiary">Resume refused · {outcome.error.serverCode ?? outcome.error.code}{outcome.error.status ? ` · HTTP ${outcome.error.status}` : ""}</span>
          <p className="mt-1">{outcome.error.message}</p>
          <AttemptBytes instanceId={entry!.target.instanceId} attempt={outcome.attempt} />
          {outcome.error.details ? <Disclose summary="Daemon detail"><pre className="whitespace-pre-wrap break-all font-mono text-[11px]">{JSON.stringify(outcome.error.details, null, 2)}</pre></Disclose> : null}
          <p className="mt-1 text-xs text-on-surface-variant">The daemon refused this request before committing. The occurrences above were re-read; choose again deliberately.</p>
        </div>
      ) : null}
      {outcome?.kind === "unknown" ? (
        <div role="alert" data-testid="workflow-resume-unknown" className="mt-3 border border-warning px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-warning">Outcome unknown{outcome.error.status ? ` · HTTP ${outcome.error.status}` : ""}{outcome.error.serverCode ? ` · ${outcome.error.serverCode}` : ""}</span>
          <p className="mt-1">{outcome.error.message}</p>
          <AttemptBytes instanceId={entry!.target.instanceId} attempt={outcome.attempt} />
          {outcome.readback === null ? <p className="mt-1">Resume is locked until this occurrence is read back.</p> : null}
          {outcome.readback?.kind === "committed" ? (
            <p data-testid="workflow-resume-readback-committed" className="mt-1">Read back <Timestamp iso={outcome.readAt} />: the occurrence is resolved with these decision bytes by redrive packet <span className="font-mono">{outcome.readback.occurrence.redrivePacketId}</span>. The resume committed; do not submit it again.</p>
          ) : null}
          {outcome.readback?.kind === "resolved-differently" ? (
            <p data-testid="workflow-resume-readback-different" className="mt-1">Read back <Timestamp iso={outcome.readAt} />: the occurrence was resolved with different decision bytes ({displayValue(outcome.readback.occurrence.resumeDecision)}). Another decision took effect; nothing further to resume.</p>
          ) : null}
          {outcome.readback?.kind === "still-unresolved" ? (
            <p data-testid="workflow-resume-readback-unresolved" className="mt-1">Read back <Timestamp iso={outcome.readAt} />: the occurrence is still unresolved. The request may have been refused or may still land. Resume is unlocked; submitting again is a deliberate new decision.</p>
          ) : null}
          {outcome.readback?.kind === "missing" ? (
            <p data-testid="workflow-resume-readback-missing" className="mt-1">Read back <Timestamp iso={outcome.readAt} />: {outcome.readError ? `the instance could not be read (${outcome.readError.message})` : "the occurrence is not in the served list for this instance"}. The outcome remains unknown.</p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <button type="button" data-testid="workflow-resume-inspect" onClick={() => inspect(outcome, entry!.target)} disabled={outcome.reading}
              className="border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low disabled:opacity-50">
              {outcome.reading ? "Reading…" : `Inspect occurrence ${outcome.attempt.occurrenceId}`}
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
