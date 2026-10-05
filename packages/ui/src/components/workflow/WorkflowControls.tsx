// Explicit, readback-verified workflow controls: graph revision and abort.
// Both are actual daemon operations. Each sends one POST after an explicit
// confirmation and never replays itself. Revision applies the INSPECTED
// version/digest with the served operation key; abort has no operation key,
// so an uncertain abort is resolved by reading the instance status.
//
// Every attempt is filed under the exact instance it was sent to (see
// recovery-ledger.ts). Navigating to another instance never carries an
// attempt, its readback or its resubmission along: that instance only sees a
// pointer back to the original one.

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkflowInstanceWithDeadline } from "../../lib/workflow-contracts.js";
import { LOCAL_OPERATOR_INSTANCE, type OperatorInstanceScope, type OperatorReadError } from "../../lib/operator-read.js";
import { readWorkflowTrace, useWorkflowOperation, useWorkflowRevision, workflowQueryKey } from "../../hooks/useWorkflow.js";
import { useWorkflowAbort, useWorkflowRevise, WorkflowMutationError, type WorkflowAbortInput, type WorkflowAbortResult, type WorkflowRevisionInput } from "../../hooks/useWorkflowMutations.js";
import type { WorkflowOperation, WorkflowTrace } from "../../lib/workflow-contracts.js";
import { Disclose, ExactText, Field, Fields, Panel, ReadGate, ReadStatus, Tag, Timestamp, type ReadLike } from "../project/catalog/evidence-ui.js";
import { SURFACE_ACTOR } from "./surface-actor.js";
import { readBackAbort, readBackRevision, revisionProposal, type AbortReadback } from "./workflow-recovery.js";
import {
  recoveryTarget, recoveryTargetKey, sameTarget, useOtherInstanceEntries, useRecoveryEntry, useTargetState,
  type LedgerEntry, type RecoveryTarget,
} from "./recovery-ledger.js";

const inputClass = "mt-0.5 w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface";
const buttonClass = "border border-on-surface px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-low disabled:cursor-not-allowed disabled:opacity-50";
const quietButtonClass = "border border-outline-variant px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-low disabled:opacity-50";

/** Mutation helpers reject with WorkflowMutationError; anything else after
 * submission cannot prove that nothing committed. */
export function asMutationError(error: unknown, attempt?: WorkflowMutationError["attempt"]): WorkflowMutationError {
  return error instanceof WorkflowMutationError ? error
    : new WorkflowMutationError("outcome_unknown", "The workflow response could not be interpreted. Inspect before deciding another action.", attempt);
}

export function ErrorBlock({ error, testId, title }: { error: WorkflowMutationError; testId: string; title: string }) {
  return (
    <div role="alert" data-testid={testId} className="mt-2 border border-tertiary px-3 py-2 text-sm">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-tertiary">{title} · {error.serverCode ?? error.code}{error.status ? ` · HTTP ${error.status}` : ""}</span>
      <p className="mt-1">{error.message}</p>
      {error.details ? <Disclose summary="Daemon detail"><pre className="whitespace-pre-wrap break-all font-mono text-[11px]">{JSON.stringify(error.details, null, 2)}</pre></Disclose> : null}
    </div>
  );
}

/** Another instance's attempt is never actionable here; point back to it. */
export function OtherInstanceAttempts<O>({ entries, what, testId }: { entries: LedgerEntry<O>[]; what: string; testId: string }) {
  if (!entries.length) return null;
  return (
    <ul data-testid={testId} className="mb-2 space-y-1">
      {entries.map((e) => (
        <li key={recoveryTargetKey(e.target)} role="note" data-instance={e.target.instanceId} className="border-l-2 border-warning pl-2 text-xs">
          An unresolved {what} for instance{" "}
          <Link to="/workflow/instance/$instanceId" params={{ instanceId: e.target.instanceId }} data-testid={`${testId}-open-${e.target.instanceId}`}
            className="font-mono underline underline-offset-2">{e.target.instanceId}</Link>{" "}
          is retained from <Timestamp iso={e.at} />. It belongs to that instance and is not applied here. Open it to inspect and decide.
        </li>
      ))}
    </ul>
  );
}

/** Exact read of the attempt's own instance. Shares the cached trace key and
 * transport; it is never the current page's observer, so a route change
 * between click and response cannot substitute another instance. */
export function useTargetTraceReadback() {
  const queryClient = useQueryClient();
  return (target: RecoveryTarget): Promise<WorkflowTrace> => queryClient.fetchQuery({
    queryKey: workflowQueryKey(target.scope, "trace", target.instanceId),
    queryFn: ({ signal }) => readWorkflowTrace(target.scope, target.instanceId, { signal }),
    staleTime: 0, retry: false,
  });
}

// ------------------------------------------------------------ revision

type Inspected = Pick<WorkflowRevisionInput, "operationKey" | "expectedVersion" | "expectedDigest">;
export type RevisionOutcome =
  | { kind: "pending"; attempt: Readonly<WorkflowRevisionInput> }
  | { kind: "succeeded"; attempt: Readonly<WorkflowRevisionInput>; result: WorkflowOperation }
  | { kind: "rejected"; attempt: Readonly<WorkflowRevisionInput>; error: WorkflowMutationError }
  | { kind: "unknown"; attempt: Readonly<WorkflowRevisionInput>; error: WorkflowMutationError; checkRequested: boolean };

const revisionRetained = (o: RevisionOutcome) => o.kind === "pending" || o.kind === "unknown";

function RevisionAttempt({ instanceId, attempt }: { instanceId: string; attempt: Readonly<WorkflowRevisionInput> }) {
  return (
    <Fields testId="workflow-revision-attempt">
      <Field label="Sent to"><span className="font-mono text-[11px]">{instanceId}</span></Field>
      <Field label="Operation key"><span className="font-mono text-[11px]">{attempt.operationKey}</span></Field>
      <Field label="Applies">version {attempt.expectedVersion} · digest <span className="font-mono text-[11px]">{attempt.expectedDigest}</span></Field>
      <Field label="Actor"><span className="font-mono text-[11px]">{attempt.actorSession}</span></Field>
      <Field label="Reason"><span className="whitespace-pre-wrap">{attempt.reason}</span></Field>
    </Fields>
  );
}

export function WorkflowRevisionPanel({ instanceId, scope = LOCAL_OPERATOR_INSTANCE }: { instanceId: string; scope?: OperatorInstanceScope }) {
  const target = useMemo(() => recoveryTarget(scope, instanceId, "revision"), [scope, instanceId]);
  const targetKey = recoveryTargetKey(target);
  const revision = useWorkflowRevision(instanceId, scope);
  const revise = useWorkflowRevise(instanceId, scope);
  const { entry, write, writerFor } = useRecoveryEntry<RevisionOutcome>(target);
  const others = useOtherInstanceEntries<RevisionOutcome>(target, revisionRetained);
  const [inspected, setInspected] = useTargetState<Inspected | null>(targetKey, null);
  const [actor, setActor] = useTargetState(targetKey, SURFACE_ACTOR);
  const [reason, setReason] = useTargetState(targetKey, "");
  const outcome = entry?.outcome;
  const checkKey = outcome?.kind === "unknown" && outcome.checkRequested ? outcome.attempt.operationKey : null;
  const operation = useWorkflowOperation(checkKey, scope);
  const readback = outcome?.kind === "unknown" && checkKey && !operation.isFetching && (operation.data || operation.error)
    ? readBackRevision(entry!.target.instanceId, outcome.attempt, operation.data, operation.error) : null;

  const proposal = revisionProposal(revision.data);
  const drifted = inspected !== null && (!proposal.applicable || proposal.operationKey !== inspected.operationKey
    || proposal.expectedVersion !== inspected.expectedVersion || proposal.expectedDigest !== inspected.expectedDigest);
  const settled = readback !== null && readback.kind !== "not-found" && readback.kind !== "unreadable";
  const locked = outcome?.kind === "pending" || (outcome?.kind === "unknown" && !settled) || !revise.scopeSupported;

  /** One POST to exactly `to`, which must be the instance this panel shows. */
  const send = (to: RecoveryTarget, attempt: Readonly<WorkflowRevisionInput>) => {
    if (!sameTarget(to, target)) return;
    const record = writerFor<RevisionOutcome>(to);
    setInspected(null);
    record({ kind: "pending", attempt });
    revise.mutateAsync(attempt).then(
      (result) => record({ kind: "succeeded", attempt, result }),
      (raw: unknown) => {
        const error = asMutationError(raw);
        record(error.code === "outcome_unknown" ? { kind: "unknown", attempt, error, checkRequested: false } : { kind: "rejected", attempt, error });
      });
  };

  return (
    <Panel title="Authored vs running plan" testId="workflow-revision"
      note="Compares the plan this workflow is running with its current authored sources. Applying a revision adopts the reviewed proposal only; completed work is never replayed.">
      <OtherInstanceAttempts entries={others} what="plan revision" testId="workflow-revision-other" />
      <ReadGate query={revision as ReadLike} what="Plan reconciliation" testId="workflow-revision-read">
        {() => {
          const view = revision.data!;
          return (
            <>
              <ReadStatus query={revision as ReadLike} testId="workflow-revision-status" />
              <div className="flex flex-wrap items-center gap-2"><Tag tone={view.status === "incompatible" ? "bad" : view.status === "current" ? "muted" : "warn"} testId="workflow-revision-state">{view.status}</Tag>
                <span className="text-sm">{view.composition.explanation}</span></div>
              {view.status === "source-only" ? <p className="mt-1 text-xs text-on-surface-variant">Only source bytes changed; executable steps and policy are unchanged.</p> : null}
              <Disclose summary="Digests, versions and changes" testId="workflow-revision-basis">
                <Fields>
                  <Field label="Running"><span className="font-mono text-[11px]">{view.boundDigest ?? "unbound"} · v{view.boundVersion}</span></Field>
                  <Field label="Authored"><span className="font-mono text-[11px]">{view.proposedDigest ?? "not compiled"}{view.proposedVersion ? ` · v${view.proposedVersion}` : ""}</span></Field>
                  <Field label="Instance version">{view.expectedVersion}</Field>
                  {view.changes.length ? <Field label="Changes"><ul className="text-xs">{view.changes.map((c, i) => <li key={i}>{c.kind} · {c.ref}{c.fields?.length ? ` (${c.fields.join(", ")})` : ""}</li>)}</ul></Field> : null}
                  {view.reasons.length ? <Field label="Reasons">{view.reasons.join("; ")}</Field> : null}
                </Fields>
                <div className="mt-2"><ExactText value={view.nextAction} copyLabel="Copy" testId="workflow-revision-next" /></div>
              </Disclose>
              {!proposal.applicable ? <p data-testid="workflow-revision-not-applicable" className="mt-2 text-sm text-on-surface-variant">{proposal.reason}</p> : null}
              {proposal.applicable && !inspected && !outcome ? (
                <button type="button" data-testid="workflow-revision-inspect" className={`${buttonClass} mt-2`} disabled={locked}
                  onClick={() => setInspected({ operationKey: proposal.operationKey, expectedVersion: proposal.expectedVersion, expectedDigest: proposal.expectedDigest })}>
                  Review this proposal…
                </button>
              ) : null}
              {inspected ? (
                <div data-testid="workflow-revision-form" className="mt-3 border border-on-surface px-3 py-2">
                  <p className="text-sm">Apply proposal <span className="font-mono">{inspected.expectedDigest}</span> to <span className="font-mono">{instanceId}</span> at version {inspected.expectedVersion} with operation key <span className="font-mono">{inspected.operationKey}</span>.</p>
                  {drifted ? (
                    <p role="alert" data-testid="workflow-revision-drifted" className="mt-1 text-sm text-warning">The served proposal changed since you reviewed it. Close this and review the current proposal.</p>
                  ) : null}
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="block text-xs"><span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Actor</span>
                      <input data-testid="workflow-revision-actor" value={actor} onChange={(e) => setActor(e.target.value)} className={inputClass} disabled={locked} /></label>
                    <label className="block text-xs"><span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Reason (required)</span>
                      <input data-testid="workflow-revision-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} disabled={locked} /></label>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button type="button" data-testid="workflow-revision-apply" className={buttonClass} disabled={locked || drifted || !actor.trim() || !reason.trim()}
                      onClick={() => send(target, Object.freeze({ ...inspected, actorSession: actor, reason }))}>Apply revision</button>
                    <button type="button" className={quietButtonClass} onClick={() => setInspected(null)}>Close</button>
                  </div>
                </div>
              ) : null}
            </>
          );
        }}
      </ReadGate>
      {!revise.scopeSupported ? <p role="alert" className="mt-2 text-sm text-tertiary">{revise.scopeError?.message}</p> : null}
      {outcome?.kind === "pending" ? (
        <div role="status" data-testid="workflow-revision-pending" className="mt-2 border border-outline-variant px-3 py-2 text-sm">
          <span className="animate-pulse font-mono text-[10px] uppercase tracking-[0.1em]">Applying revision…</span>
          <RevisionAttempt instanceId={entry!.target.instanceId} attempt={outcome.attempt} />
        </div>
      ) : null}
      {outcome?.kind === "succeeded" ? (
        <div role="status" data-testid="workflow-revision-succeeded" className="mt-2 border border-outline-variant px-3 py-2 text-sm">
          {outcome.result.replayed ? "Revision already recorded under this key (replay)." : "Revision recorded."} Operation <span className="font-mono">{outcome.result.receipt.operationKey}</span>; instance now v{outcome.result.instance.workflowVersion}. Completed work is preserved.
          <button type="button" className={`${quietButtonClass} ml-2`} onClick={() => write(undefined)}>Dismiss</button>
        </div>
      ) : null}
      {outcome?.kind === "rejected" ? (
        <>
          <ErrorBlock error={outcome.error} testId="workflow-revision-rejected" title="Revision refused" />
          <div className="mt-2 flex gap-2">
            <button type="button" data-testid="workflow-revision-reinspect" className={buttonClass}
              onClick={() => { write(undefined); void revision.refetch(); }}>
              {outcome.error.serverCode === "lifecycle_revision_conflict" ? "Re-read the proposal" : "Dismiss"}
            </button>
          </div>
        </>
      ) : null}
      {outcome?.kind === "unknown" ? (
        <div role="alert" data-testid="workflow-revision-unknown" data-target={entry!.target.instanceId} className="mt-2 border border-warning px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-warning">Outcome unknown{outcome.error.status ? ` · HTTP ${outcome.error.status}` : ""}</span>
          <p className="mt-1">{outcome.error.message}</p>
          <RevisionAttempt instanceId={entry!.target.instanceId} attempt={outcome.attempt} />
          <button type="button" data-testid="workflow-revision-check" className={`${buttonClass} mt-2`} disabled={operation.isFetching}
            onClick={() => { if (outcome.checkRequested) void operation.refetch(); else write({ ...outcome, checkRequested: true }); }}>
            {operation.isFetching ? "Checking…" : `Check operation ${outcome.attempt.operationKey}`}
          </button>
          {readback?.kind === "committed" ? (
            <p data-testid="workflow-revision-check-committed" className="mt-1">Committed: the receipt for this key names this instance and exactly these bytes (recorded <Timestamp iso={typeof readback.operation.receipt.at === "string" ? readback.operation.receipt.at : null} />). Do not apply it again.</p>
          ) : null}
          {readback?.kind === "other-instance" ? (
            <p role="alert" data-testid="workflow-revision-check-other-instance" className="mt-1 text-tertiary">This key is recorded against instance <span className="font-mono">{readback.recordedInstanceId}</span>, not this one. Do not resubmit it here.</p>
          ) : null}
          {readback?.kind === "different-bytes" ? (
            <p role="alert" data-testid="workflow-revision-check-different" className="mt-1 text-tertiary">This key is recorded for this instance with a different {readback.fields.join(", ")}. Another decision used it; review the current proposal again.</p>
          ) : null}
          {readback?.kind === "unreadable" ? (
            <p data-testid="workflow-revision-check-none" className="mt-1">The operation could not be read: {readback.error?.message ?? "no response"}. The outcome stays unknown.</p>
          ) : null}
          {readback?.kind === "not-found" ? (
            <div data-testid="workflow-revision-check-none" className="mt-1">
              No committed effect is recorded for this key yet. Submitting again to <span className="font-mono">{entry!.target.instanceId}</span> with the same key and bytes is replay-safe; it is still your explicit decision.
              <div>
                <button type="button" data-testid="workflow-revision-resubmit" className={`${buttonClass} mt-2`}
                  disabled={!sameTarget(entry!.target, target) || !revise.scopeSupported}
                  onClick={() => send(entry!.target, outcome.attempt)}>Submit again with key {outcome.attempt.operationKey}</button>
              </div>
            </div>
          ) : null}
          {settled ? <button type="button" className={`${quietButtonClass} mt-2`} onClick={() => { write(undefined); void revision.refetch(); }}>Dismiss</button> : null}
        </div>
      ) : null}
    </Panel>
  );
}

// --------------------------------------------------------------- abort

export type AbortOutcome =
  | { kind: "pending"; attempt: Readonly<WorkflowAbortInput> }
  | { kind: "succeeded"; attempt: Readonly<WorkflowAbortInput>; result: WorkflowAbortResult }
  | { kind: "rejected"; attempt: Readonly<WorkflowAbortInput>; error: WorkflowMutationError }
  | { kind: "unknown"; attempt: Readonly<WorkflowAbortInput>; error: WorkflowMutationError; readback: AbortReadback | { kind: "missing" } | null; readError: OperatorReadError | null; reading: boolean };

const abortRetained = (o: AbortOutcome) => o.kind === "pending" || (o.kind === "unknown" && (o.readback === null || o.readback.kind === "missing"));

export function WorkflowAbortPanel({ instance, scope = LOCAL_OPERATOR_INSTANCE }: { instance: WorkflowInstanceWithDeadline; scope?: OperatorInstanceScope }) {
  const target = useMemo(() => recoveryTarget(scope, instance.instanceId, "abort"), [scope, instance.instanceId]);
  const targetKey = recoveryTargetKey(target);
  const abort = useWorkflowAbort(instance.instanceId, scope);
  const readTrace = useTargetTraceReadback();
  const { entry, write, writerFor } = useRecoveryEntry<AbortOutcome>(target);
  const others = useOtherInstanceEntries<AbortOutcome>(target, abortRetained);
  const [open, setOpen] = useTargetState(targetKey, false);
  const [actor, setActor] = useTargetState(targetKey, SURFACE_ACTOR);
  const [reason, setReason] = useTargetState(targetKey, "");
  const outcome = entry?.outcome;
  const terminal = instance.status === "completed" || instance.status === "aborted";
  const locked = outcome?.kind === "pending" || (outcome !== undefined && abortRetained(outcome)) || !abort.scopeSupported;

  const submit = () => {
    const attempt = Object.freeze({ reason, actorSession: actor });
    const record = writerFor<AbortOutcome>(target);
    setOpen(false);
    record({ kind: "pending", attempt });
    abort.mutateAsync(attempt).then(
      (result) => record({ kind: "succeeded", attempt, result }),
      (raw: unknown) => {
        const error = asMutationError(raw);
        record(error.code === "outcome_unknown" ? { kind: "unknown", attempt, error, readback: null, readError: null, reading: false } : { kind: "rejected", attempt, error });
      });
  };

  const inspect = (current: Extract<AbortOutcome, { kind: "unknown" }>, to: RecoveryTarget) => {
    const record = writerFor<AbortOutcome>(to);
    record({ ...current, reading: true });
    readTrace(to).then(
      (trace) => record({ ...current, reading: false, readError: null, readback: readBackAbort(to.instanceId, current.attempt, trace.instance) }),
      (error: OperatorReadError) => record({ ...current, reading: false, readError: error, readback: { kind: "missing" } }));
  };

  if (terminal && !outcome && !others.length) return null;
  return (
    <Panel title="Abort workflow" testId="workflow-abort"
      note="Closes every current work packet and ends this workflow as aborted. It does not judge any outcome. Requires a reason; nothing happens until you confirm.">
      <OtherInstanceAttempts entries={others} what="abort" testId="workflow-abort-other" />
      {!open && !outcome && !terminal ? (
        <button type="button" data-testid="workflow-abort-open" className={buttonClass} onClick={() => setOpen(true)} disabled={!abort.scopeSupported}>Abort…</button>
      ) : null}
      {!abort.scopeSupported ? <p role="alert" className="mt-2 text-sm text-tertiary">{abort.scopeError?.message}</p> : null}
      {open && !terminal && !outcome ? (
        <div data-testid="workflow-abort-form" className="border border-tertiary px-3 py-2">
          <p className="text-sm">Abort <span className="font-mono">{instance.instanceId}</span> ({instance.workflowName} v{instance.workflowVersion}), closing {instance.currentFrontier.length} current packet(s).</p>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-xs"><span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Actor</span>
              <input data-testid="workflow-abort-actor" value={actor} onChange={(e) => setActor(e.target.value)} className={inputClass} disabled={locked} /></label>
            <label className="block text-xs"><span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Reason (required)</span>
              <input data-testid="workflow-abort-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} disabled={locked} /></label>
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" data-testid="workflow-abort-confirm" className={`${buttonClass} border-tertiary text-tertiary`} disabled={locked || !actor.trim() || !reason.trim()}
              onClick={submit}>Confirm abort</button>
            <button type="button" className={quietButtonClass} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {outcome?.kind === "pending" ? <p role="status" data-testid="workflow-abort-pending" className="mt-2 animate-pulse font-mono text-[11px]">Aborting {entry!.target.instanceId}…</p> : null}
      {outcome?.kind === "succeeded" ? (
        <p role="status" data-testid="workflow-abort-succeeded" className="mt-2 text-sm">Aborted <span className="font-mono">{outcome.result.instanceId}</span>. Closed packets: {outcome.result.closedPacketIds.join(", ") || "none"}. The page reflects the re-read instance.</p>
      ) : null}
      {outcome?.kind === "rejected" ? (
        <>
          <ErrorBlock error={outcome.error} testId="workflow-abort-rejected" title="Abort refused" />
          <button type="button" className={`${quietButtonClass} mt-2`} onClick={() => write(undefined)}>Dismiss</button>
        </>
      ) : null}
      {outcome?.kind === "unknown" ? (
        <div role="alert" data-testid="workflow-abort-unknown" data-target={entry!.target.instanceId} className="mt-2 border border-warning px-3 py-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-warning">Outcome unknown{outcome.error.status ? ` · HTTP ${outcome.error.status}` : ""}</span>
          <p className="mt-1">{outcome.error.message}</p>
          <Fields>
            <Field label="Sent to"><span className="font-mono text-[11px]">{entry!.target.instanceId}</span></Field>
            <Field label="Actor"><span className="font-mono text-[11px]">{outcome.attempt.actorSession}</span></Field>
            <Field label="Reason"><span className="whitespace-pre-wrap">{outcome.attempt.reason}</span></Field>
          </Fields>
          {outcome.readback?.kind === "committed" ? <p data-testid="workflow-abort-readback-committed" className="mt-1">Read back: the instance is aborted with this actor and reason. The abort committed.</p> : null}
          {outcome.readback && outcome.readback.kind !== "committed" && outcome.readback.kind !== "missing" ? <p data-testid="workflow-abort-readback-other" className="mt-1">Read back: instance is {outcome.readback.status}. The abort did not take effect as submitted; decide again deliberately.</p> : null}
          {outcome.readback?.kind === "missing" ? <p data-testid="workflow-abort-readback-missing" className="mt-1">The instance could not be read back{outcome.readError ? `: ${outcome.readError.message}` : ""}. The outcome remains unknown.</p> : null}
          <div className="mt-2 flex gap-2">
            <button type="button" data-testid="workflow-abort-inspect" className={buttonClass} disabled={outcome.reading} onClick={() => inspect(outcome, entry!.target)}>
              {outcome.reading ? "Reading…" : `Read status of ${entry!.target.instanceId}`}
            </button>
            {outcome.readback && outcome.readback.kind !== "missing" ? <button type="button" className={quietButtonClass} onClick={() => write(undefined)}>Dismiss</button> : null}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
