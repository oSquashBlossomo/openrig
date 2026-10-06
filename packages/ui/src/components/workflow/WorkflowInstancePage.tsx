// OPR.0.4.6.WF4 (C4) — the instance detail page (the FR-2 reference shape).
//
// ZOOM-ADDRESSED, not nav chrome (the /agents precedent): reached from instance
// rows (Library band / the /workflows altitude), from NEEDS-YOU workflow rows
// (deep-linked with the FR-3 `?step=` anchor) and from mission lifecycle cards.
//
// One source of truth, two projections (FR-4): everything here is the SAME read
// `rig workflow trace` projects — GET /api/workflow/:id/trace (instance + trail,
// frontier packets, failure occurrences, boundary obligations, reconciliation,
// deadline verdict) — plus the workflow SHAPE from the connected instance's own
// Library review for the exact served entry matching the instance's name and
// version bytes, composed client-side (no UI-side recomputation, BR-4). Every
// read describes the connected instance only, whatever host topology views.
//
// Mutations are the daemon's actual operations, each an explicit decision:
// occurrence-specific Resume (the operator chooses the failure occurrence,
// actor and decision bytes), plan revision (inspected version/digest/key) and
// abort (actor + reason). Each attempt stays bound to this exact instance;
// none is ever replayed automatically. ROUTE-FROM-WEB remains DEFERRED (pm
// ruling): no re-route affordance renders.

import type { ReactNode } from "react";
import { DisplayTime, DisplayZoneNote } from "../time/DisplayTime.js";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { cn } from "../../lib/utils.js";
import { LOCAL_OPERATOR_INSTANCE, type OperatorReadError } from "../../lib/operator-read.js";
import { WorkspacePage } from "../WorkspacePage.js";
import { WorkflowHeader, WorkflowSummaryCard, WorkflowSummaryGrid } from "../WorkflowScaffold.js";
import {
  useWorkflowTrace,
  workflowFailureChoices,
  type WorkflowInstanceWithDeadline,
  type WorkflowStepTrailEntry,
} from "../../hooks/useWorkflow.js";
import { ConnectedInstanceNote, displayValue, ReadError, ReadStatus, Timestamp, type ReadLike } from "../project/catalog/evidence-ui.js";
import { WorkflowTopologyGraph } from "./WorkflowTopologyGraph.js";
import { InstanceTrailTimeline } from "./InstanceTrailTimeline.js";
import { FailureOccurrenceChooser } from "./FailureOccurrenceChooser.js";
import { SequentialFailurePanel } from "./SequentialFailurePanel.js";
import { WorkflowAbortPanel, WorkflowRevisionPanel } from "./WorkflowControls.js";
import { WorkflowBindingPanel, WorkflowFrontierPanel, WorkflowObligationsPanel } from "./WorkflowFrontier.js";
import { useConnectedWorkflowSpec, useOpenLibraryEntry, type ConnectedWorkflowSpec, type SpecReadFreshness } from "./workflow-spec-identity.js";

/** The served terminal timestamp described by the instance's CURRENT status.
 * Older rows can keep a failure stamp after a resume (the backend clear in
 * 45cb57f1 is not backfilled), so an active/waiting stamp is earlier terminal
 * evidence, never a completion. The exact raw instant is kept; a missing one
 * stays unknown. */
export function terminalStamp(instance: Pick<WorkflowInstanceWithDeadline, "status" | "completedAt">):
  { kind: "completed" | "failed" | "aborted" | "retained"; label: string; at: string | null } | null {
  const at = instance.completedAt ?? null;
  switch (instance.status) {
    case "completed": return { kind: "completed", label: "completed", at };
    case "failed": return { kind: "failed", label: "failed", at };
    case "aborted": return { kind: "aborted", label: "aborted", at };
    default: return at ? { kind: "retained", label: `earlier terminal stamp (now ${instance.status}; not a completion)`, at } : null;
  }
}

function TerminalStamp({ instance }: { instance: WorkflowInstanceWithDeadline }) {
  const stamp = terminalStamp(instance);
  if (!stamp) return null;
  return (
    <span data-testid="wf-inst-terminal-stamp" data-kind={stamp.kind}
      title={stamp.kind === "retained" ? "Recorded by an earlier failure or close. Failure occurrences and the routing history keep each episode." : undefined}>
      {stamp.label}{stamp.at ? <> <DisplayTime iso={stamp.at} className="" /></> : " · time not recorded"}
    </span>
  );
}

/** Position history from the recorded trail: visited steps + the taken
 *  consecutive step→step edges (+ the hop into the live current step).
 *  Derivation only — pairs with no matching shape edge style nothing. */
function takenFromTrail(
  trail: WorkflowStepTrailEntry[],
  currentStepId: string | null,
): { visited: string[]; edgeKeys: string[] } {
  const seq = trail.map((t) => t.stepId);
  if (currentStepId) seq.push(currentStepId);
  const edgeKeys: string[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    if (seq[i] !== seq[i + 1]) edgeKeys.push(`${seq[i]}→${seq[i + 1]}`);
  }
  return { visited: trail.map((t) => t.stepId), edgeKeys };
}

function positionLabel(instance: WorkflowInstanceWithDeadline): string {
  if (instance.currentStepId) return instance.currentStepId;
  if (instance.status === "completed") return "closed";
  if (instance.status === "aborted") return "aborted";
  if (instance.status === "failed") return "felled";
  return "no current step";
}

/** Exception evidence. Remediation lives in its own panels below: a failed
 *  instance is resumed by choosing an exact failure occurrence there. */
export function ExceptionBanner({ instance, unresolvedFailures }: { instance: WorkflowInstanceWithDeadline; unresolvedFailures?: number }) {
  const gated = instance.status === "waiting" && instance.currentStepId != null;
  const overdue = instance.deadline.state !== "healthy" && instance.deadline.evidence;
  const failed = instance.status === "failed";
  const aborted = instance.status === "aborted";
  if (!gated && !overdue && !failed && !aborted) return null;

  const decision = instance.lastContinuationDecision;
  const tone = failed || overdue ? "border-red-700/60 bg-red-700/5" : aborted ? "border-outline bg-surface-low" : "border-amber-700/60 bg-amber-700/5";
  return (
    <div data-testid="workflow-exception-banner" className={cn("space-y-2 border px-3 py-2", tone)}>
      {failed ? (
        <p className="font-mono text-[11px] text-red-700">
          ▲ FAILED — no remediation branch mapped for the failing exit
          {instance.resumeCount > 0 ? ` · resumed ${instance.resumeCount}× already` : ""}
        </p>
      ) : null}
      {aborted ? (
        <p data-testid="workflow-aborted" className="font-mono text-[11px] text-on-surface">
          ✕ ABORTED{decision ? ` by ${displayValue(decision.actorSession)} — ${displayValue(decision.reason)}` : ""}
          {instance.completedAt ? <> · <DisplayTime iso={instance.completedAt} className="" /></> : ""}. Aborting is not an outcome judgment.
        </p>
      ) : null}
      {overdue ? (
        <p className="font-mono text-[11px] text-red-700">
          ▲ {instance.deadline.state.toUpperCase()} — step {instance.deadline.evidence!.stepId ?? "(unbound)"} packet{" "}
          {instance.deadline.evidence!.packetId} held by {instance.deadline.evidence!.ownerSession},{" "}
          {Math.floor(instance.deadline.evidence!.overdueBySeconds / 60)}m past its{" "}
          {instance.deadline.evidence!.anchor} anchor
        </p>
      ) : null}
      {gated && !overdue && !failed ? (
        <p className="font-mono text-[11px] text-amber-800">
          ◐ WAITING at {instance.currentStepId} — the gate packet is parked pending sign-off; resolving the
          NEEDS-YOU item resumes the deterministic flow
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {failed ? (
          <a href="#workflow-failures" data-testid="workflow-exception-failures-link"
            className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant">
            {unresolvedFailures === undefined ? "Failure occurrences ↓" : `${unresolvedFailures} unresolved failure occurrence${unresolvedFailures === 1 ? "" : "s"} ↓`}
          </a>
        ) : null}
        {/* ROUTE-FROM-WEB DEFERRED (pm ruling) — the twin's RE-ROUTE affordance
            is intentionally OMITTED; the disclosed twin-vs-build delta. */}
        <span className="font-mono text-[10px] text-on-surface-variant">
          CLI: rig workflow trace {instance.instanceId}
        </span>
      </div>
    </div>
  );
}

/** A failed library refresh beside retained facts: they stay visible as the
 * last successful read, with that read's own time, never as current. */
function SpecStaleNotice({ spec }: { spec: ConnectedWorkflowSpec | null }) {
  if (!spec?.freshness.stale) return null;
  const { catalog, review } = spec.freshness;
  const failed: Array<{ what: string; read: SpecReadFreshness }> = [];
  if (catalog.retained && catalog.error) failed.push({ what: "catalog", read: catalog });
  if (review?.retained && review.error) failed.push({ what: "review", read: review });
  const fetching = catalog.fetching || (review?.fetching ?? false);
  return (
    <div role="alert" data-testid="workflow-spec-stale" data-failed={failed.map((f) => f.what).join(",")}
      className="border border-warning bg-surface-lowest px-3 py-2 text-sm">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-warning">Library refresh failed · showing the last successful read</span>
      <ul className="mt-1 space-y-0.5 text-xs">
        {failed.map(({ what, read }) => (
          <li key={what} data-testid={`workflow-spec-stale-${what}`}>
            The connected instance&apos;s library {what} could not be refreshed: {read.error?.message ?? "no response"}. Last successful {what} read <Timestamp iso={read.readAt} />.
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-on-surface-variant">The shape below may no longer match the library. No other host&apos;s library is used instead.</p>
      <button type="button" data-testid="workflow-spec-stale-retry" disabled={fetching} onClick={spec.freshness.refresh}
        className="mt-1 border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] hover:bg-surface-low disabled:opacity-50">
        {fetching ? "Refreshing…" : "Retry library read"}
      </button>
    </div>
  );
}

/** Why no cached shape is drawn: never a silent gap, never another entry. */
function WorkflowSpecState({ spec, name, version }: { spec: ConnectedWorkflowSpec | null; name: string; version: string }) {
  const tuple = <span className="text-on-surface">{name} v{version}</span>;
  let body: ReactNode = <>Reading the connected instance&apos;s workflow library for {tuple}…</>;
  let retry: (() => void) | null = null;
  if (spec?.state === "catalog" && spec.match.kind === "unavailable") {
    body = <>The connected instance&apos;s workflow library could not be read{spec.match.error ? `: ${spec.match.error.message}` : ""}. No other host&apos;s library is used instead.</>;
    retry = spec.retry;
  } else if (spec?.state === "catalog" && spec.match.kind === "absent") {
    body = <>No library entry on the connected instance matches {tuple} exactly, so its cached shape is not shown.</>;
  } else if (spec?.state === "catalog" && spec.match.kind === "ambiguous") {
    body = (
      <>{spec.match.entries.length} library entries match {tuple} exactly; none is chosen.
        <ul className="mt-1 space-y-0.5">{spec.match.entries.map((e) => <li key={e.id} className="break-all">{e.id} · {e.sourcePath}</li>)}</ul></>
    );
  } else if (spec?.state === "review-unavailable") {
    body = <>The library review for entry {spec.entry.id} could not be read{spec.error ? `: ${spec.error.message}` : ""}.</>;
    retry = spec.retry;
  } else if (spec?.state === "review-mismatch") {
    body = <>The served review ({String(spec.served.name)} v{String(spec.served.version)}, entry {String(spec.served.libraryEntryId)}) does not match {tuple}; it is not shown.</>;
  }
  return (
    <div data-testid="workflow-spec-state" data-state={spec ? (spec.state === "catalog" ? spec.match.kind : spec.state) : "pending"}
      role={spec?.state === "review-pending" || spec === null || (spec.state === "catalog" && spec.match.kind === "pending") ? "status" : "note"}
      className="border border-dashed border-outline-variant px-3 py-2 font-mono text-[10px] text-on-surface-variant">
      {body}
      {retry ? <button type="button" onClick={retry} className="ml-2 border border-outline-variant px-2 py-0.5 uppercase hover:bg-surface-low">Retry</button> : null}
    </div>
  );
}

export function WorkflowInstancePage({
  instanceId,
  anchorStepId,
}: {
  instanceId: string;
  /** The FR-3 `?step=` deep-link anchor. */
  anchorStepId?: string | null;
}) {
  const navigate = useNavigate();
  const trace = useWorkflowTrace(instanceId, LOCAL_OPERATOR_INSTANCE);
  const data = trace.data;
  // Workflow reads reject only with the shared operator read error.
  const traceError = trace.error as OperatorReadError | null;
  // The spec shape comes from the SAME connected instance as the trace, by the
  // served catalog entry whose name/version bytes equal this instance's.
  const spec = useConnectedWorkflowSpec(data ? { name: data.instance.workflowName, version: data.instance.workflowVersion } : null);
  const openLibraryEntry = useOpenLibraryEntry();

  if (!trace.scopeSupported || (data === undefined && traceError)) {
    const notFound = traceError?.status === 404;
    return (
      <WorkspacePage>
        <div data-testid="workflow-instance-error" className="space-y-4">
          <WorkflowHeader
            eyebrow="Workflow — Instance"
            title={notFound ? "Instance Not Found" : "Instance Unavailable"}
            description={notFound ? `The connected instance has no workflow ${instanceId}.` : `Workflow ${instanceId} could not be read.`}
          />
          <ReadError error={trace.scopeError ?? traceError} what="Workflow instance" testId="workflow-instance-read"
            onRetry={trace.scopeSupported ? () => void trace.refetch() : undefined} />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/workflows" })}>
            Back to Workflows
          </Button>
        </div>
      </WorkspacePage>
    );
  }
  if (data === undefined) {
    return (
      <WorkspacePage>
        <div role="status" className="font-mono text-[10px] text-on-surface-variant">Loading workflow instance {instanceId}…</div>
      </WorkspacePage>
    );
  }

  const { instance, trail } = data;
  const failures = data.failures ?? instance.failureOccurrences;
  const frontier = data.frontier ?? instance.frontierPackets;
  const obligations = data.boundaryObligations ?? instance.boundaryObligations;
  const unknowns = data.unknowns ?? instance.unknowns;
  const choices = workflowFailureChoices(instance, failures);
  const showFailures = (choices.occurrences?.length ?? 0) > 0 || instance.status === "failed";
  const { visited, edgeKeys } = takenFromTrail(trail, instance.currentStepId);
  const workflowReview = spec?.state === "verified" ? spec.review : null;
  const statusLabel = instance.deadline.state !== "healthy" ? instance.deadline.state : instance.status;

  return (
    <WorkspacePage>
      <div data-testid="workflow-instance-page" data-instance={instance.instanceId} className="space-y-6">
        <WorkflowHeader
          eyebrow={`Workflow — Instance · ${instance.workflowName} v${instance.workflowVersion}`}
          title={instance.instanceId}
          description={
            instance.currentStepId
              ? `${instance.status} at ${instance.currentStepId} · hop ${instance.hopCount}`
              : `${instance.status} · hop ${instance.hopCount}`
          }
          actions={
            <div className="flex gap-2 items-center">
              <Button
                variant="outline"
                size="sm"
                data-testid="workflow-view-spec"
                disabled={spec?.state !== "verified"}
                data-stale={spec?.freshness.stale ? "true" : "false"}
                title={spec?.state !== "verified" ? "No exact library entry is verified for this workflow"
                  : spec.freshness.stale ? `Library entry ${spec.entry.id} on the connected instance, last verified ${spec.freshness.review?.readAt ?? "at an unrecorded time"}; the latest library refresh failed`
                  : `Library entry ${spec.entry.id} on the connected instance`}
                onClick={() => { if (spec?.state === "verified") openLibraryEntry(spec.entry.id); }}
              >
                View Spec
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/workflows" })}>
                Back
              </Button>
            </div>
          }
        />

        <div className="space-y-2">
          <ConnectedInstanceNote subject="Workflow reads and actions" />
          <DisplayZoneNote testId="workflow-display-zone" />
          <ReadStatus query={trace as ReadLike} testId="workflow-instance-status" />
        </div>

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="Status" value={statusLabel} testId="wf-inst-status" />
          <WorkflowSummaryCard label="Position" value={positionLabel(instance)} testId="wf-inst-position" />
          <WorkflowSummaryCard label="Hops" value={instance.hopCount} testId="wf-inst-hops" />
          <WorkflowSummaryCard label="Resumes" value={instance.resumeCount} testId="wf-inst-resumes" />
        </WorkflowSummaryGrid>

        <p data-testid="wf-inst-provenance" className="font-mono text-[10px] text-on-surface-variant">
          created by {instance.createdBySession} · <DisplayTime iso={instance.createdAt} className="" testId="wf-inst-created-at" />
          {terminalStamp(instance) ? <> · <TerminalStamp instance={instance} /></> : null}
          {" "}· instance version {instance.version}
        </p>

        <ExceptionBanner instance={instance} unresolvedFailures={failures ? choices.choices.length : undefined} />

        {showFailures ? (
          <div id="workflow-failures" className="scroll-mt-4">
            <FailureOccurrenceChooser instance={instance} failures={failures} />
          </div>
        ) : null}
        {/* Renders only for a served serial failure, or to keep its own attempt's outcome visible. */}
        <SequentialFailurePanel instance={instance} failures={failures} />

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
          <div className="min-w-0 space-y-6">
            <WorkflowFrontierPanel packets={frontier} />
            <SpecStaleNotice spec={spec} />
            {workflowReview && spec?.state === "verified" ? (
              <div className="space-y-1">
                <WorkflowTopologyGraph
                  topology={workflowReview.topology}
                  testId="workflow-instance-graph"
                  currentStepId={instance.currentStepId}
                  visitedStepIds={visited}
                  takenEdgeKeys={edgeKeys}
                />
                <p data-testid="workflow-spec-source" data-source="local" data-entry={spec.entry.id} data-stale={spec.freshness.stale ? "true" : "false"}
                  className="font-mono text-[10px] text-on-surface-variant">
                  Shape from the connected instance&apos;s library · {workflowReview.name} v{workflowReview.version} · {spec.entry.sourcePath}
                  {" "}· review read <Timestamp iso={spec.freshness.review?.readAt} testId="workflow-spec-review-read-at" />
                  {" "}· catalog read <Timestamp iso={spec.freshness.catalog.readAt} testId="workflow-spec-catalog-read-at" />
                  {spec.freshness.stale ? " · last successful read, not current" : ""}. The running plan is compared below.
                </p>
              </div>
            ) : (
              <WorkflowSpecState spec={spec} name={instance.workflowName} version={instance.workflowVersion} />
            )}
            <InstanceTrailTimeline trail={trail} instance={instance} anchorStepId={anchorStepId} />
          </div>
          <div className="min-w-0 space-y-6">
            <WorkflowBindingPanel instance={instance} />
            <WorkflowObligationsPanel obligations={obligations} unknowns={unknowns} />
            <WorkflowRevisionPanel instanceId={instance.instanceId} />
            <WorkflowAbortPanel instance={instance} />
          </div>
        </div>
      </div>
    </WorkspacePage>
  );
}
