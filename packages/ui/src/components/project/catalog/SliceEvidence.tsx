// One exact slice of one exact mission of one exact catalog project.
// The six-tab payload loads once when the slice opens; a document body loads
// only when that document is chosen. Every read carries project ID + root.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { CanonicalSliceScope, ProjectSelection, ProjectSliceDetail } from "../../../lib/project-read.js";
import { projectSliceProofAssetUrl } from "../../../lib/project-read.js";
import { LOCAL_OPERATOR_INSTANCE } from "../../../lib/operator-read.js";
import { useProjectSliceDetail, useProjectSliceDocument } from "../../../hooks/useCanonicalScopes.js";
import { useExecutionView } from "../../../hooks/useExecutionView.js";
import { MarkdownViewer } from "../../markdown/MarkdownViewer.js";
import type { FileProjectIdentity } from "../../files/file-source.js";
import { operatorScopeOrigin, useDetachedMarkdownSource } from "../project-file-source.js";
import { cn } from "../../../lib/utils.js";
import {
  Disclose, displayValue, Field, Fields, listKeyboard, Panel, ReadGate, ReadStatus, TabBar, Tag, Timestamp, type ReadLike,
} from "./evidence-ui.js";
import { declaredStatus, nextText, owners, plannedOwners, problemText, sliceRows, sliceState, sliceStateTone, type SliceRow } from "./execution-model.js";
import { LegacyLadder, NativeOutcomes, ProofContract } from "./OutcomeEvidence.js";
import { isSliceView, type SliceView } from "./project-location.js";

const SLICE_TABS: Array<{ id: SliceView; label: string }> = [
  { id: "outcomes", label: "Outcomes" }, { id: "proof", label: "Proof" }, { id: "work", label: "Work & ladder" },
  { id: "story", label: "Story" }, { id: "docs", label: "Docs" }, { id: "workflow", label: "Workflow" },
];

/** Text served by a project route that names no Files root: anchors and
 * external links work; relative links/images are refused with a reason; the
 * producing origin and exact project identity travel with the source. */
function ProjectMarkdown({ content, path, project, hideRawToggle }: { content: string; path: string; project: FileProjectIdentity; hideRawToggle?: boolean }) {
  const source = useDetachedMarkdownSource(operatorScopeOrigin(LOCAL_OPERATOR_INSTANCE), path, project);
  return <MarkdownViewer content={content} source={source} hideRawToggle={hideRawToggle} />;
}

const projectIdentity = (selection: ProjectSelection): FileProjectIdentity => ({ projectId: selection.id, projectRoot: selection.root });

function ProofImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <p data-testid="proof-image-unavailable" className="border border-dashed border-outline-variant p-2 text-xs text-on-surface-variant">{alt}: not served for this project (the selected project has no proof-packet source; no default workspace image is substituted).</p>;
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="max-h-64 border border-outline-variant object-contain" />;
}

function ProofPackets({ detail, selection, mission, slice }: { detail: ProjectSliceDetail; selection: ProjectSelection; mission: string; slice: string }) {
  const packets = detail.tests.proofPackets;
  return (
    <Panel title="Proof packets" testId="slice-proof-packets"
      note="Packet files matched to this slice. Their PASS/FAIL wording is the artifact's own verdict, not an outcome judgment.">
      {packets.length === 0 ? (
        <p data-testid="slice-proof-packets-none" className="text-sm text-on-surface-variant">No proof packet is served for this slice. Catalog projects currently have no proof-packet source; requirement drops appear in the proof contract above.</p>
      ) : (
        <ul className="space-y-3">
          {packets.map((p) => (
            <li key={p.dirName} className="border border-outline-variant px-3 py-2">
              <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[11px]">{p.dirName}</span><Tag tone="muted">artifact says {p.passFailBadge}</Tag></div>
              {p.primaryMarkdown ? <Disclose summary={p.primaryMarkdown.relPath}><ProjectMarkdown content={p.primaryMarkdown.content} path={p.primaryMarkdown.relPath} project={projectIdentity(selection)} hideRawToggle /></Disclose> : null}
              {p.screenshots.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {p.screenshots.map((shot) => <ProofImage key={shot} alt={shot} src={projectSliceProofAssetUrl(LOCAL_OPERATOR_INSTANCE, selection, mission, slice, shot)} />)}
                </div>
              ) : null}
              {p.videos.length || p.traces.length ? <p className="mt-1 text-xs text-on-surface-variant">Also: {[...p.videos, ...p.traces].join(", ")}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function WorkFacts({ row, scope }: { row: SliceRow | null; scope: CanonicalSliceScope | null }) {
  return (
    <div className="space-y-4">
      <Panel title="Identity and declared state" testId="slice-identity" note="Authored declarations. They are not outcome judgments.">
        <Fields>
          <Field label="Declared">{row ? declaredStatus(row) : scope?.status ?? "no declared status"}{scope?.stage ? ` · stage ${scope.stage}` : ""}</Field>
          <Field label="Spec lock">{scope?.locks.spec ? <>by {scope.locks.spec.by} · <Timestamp iso={scope.locks.spec.at} /></> : "not locked"}</Field>
          <Field label="Delivery lock">{scope?.locks.delivery ? <>by {scope.locks.delivery.by} · <Timestamp iso={scope.locks.delivery.at} /></> : "not locked"}</Field>
          <Field label="Spec SHA"><span className="font-mono text-[11px]">{scope?.specShaShort ?? "not recorded"}</span></Field>
          <Field label="PRD">{scope ? (scope.prdExists ? "present" : "absent") : "not served"}</Field>
          <Field label="Source"><span className="font-mono text-[11px]">{scope?.sourcePath ?? "not served"}</span></Field>
          {scope?.error ? <Field label="Read error"><span className="text-tertiary">{scope.error}</span></Field> : null}
        </Fields>
        {scope?.intent ? <p className="mt-2 text-sm">{scope.intent}</p> : null}
        {scope?.miniRequirements.length ? (
          <Disclose summary={`Mini requirements (${scope.miniRequirements.length})`} defaultOpen testId="slice-mini-requirements">
            <ol className="list-decimal space-y-0.5 pl-5 text-sm">{scope.miniRequirements.map((r, i) => <li key={i}>{r}</li>)}</ol>
          </Disclose>
        ) : null}
      </Panel>
      <Panel title="Current work and sequencing" testId="slice-work">
        {!row ? <p className="text-sm text-on-surface-variant">The execution view did not serve this slice.</p> : (
          <Fields>
            <Field label="State"><Tag tone={sliceStateTone(sliceState(row))}>{sliceState(row)}</Tag>{problemText(row) ? <span className="ml-2 text-warning">{problemText(row)}</span> : null}</Field>
            <Field label="Owners">{owners(row).join(", ") || `none · planned ${plannedOwners(row).join(", ") || "unknown"}`}</Field>
            <Field label="Depends on">{row.sequencing ? (row.sequencing.depends_on === "INDETERMINATE" ? "unknown" : row.sequencing.depends_on.join(", ") || "none declared") : "not sequenced"}</Field>
            <Field label="Next">{nextText(row) ?? row.sequencing?.next_up_basis ?? "not determined"}</Field>
            <Field label="Wave / care">{row.care ? `${row.care.build_wave} · review ${row.care.review_model} · dial ${row.care.planning_dial}` : "not declared"}</Field>
            {row.sequencing?.work_rows.length ? (
              <Field label="Work rows">
                <ul className="space-y-0.5 text-xs">
                  {row.sequencing.work_rows.map((w) => <li key={w.qitem_id}><span className="font-mono">{w.qitem_id}</span> · {w.seat} · {w.state}{w.summary ? ` · ${w.summary}` : ""}{w.blocked_on ? ` · blocked on ${w.blocked_on}` : ""}</li>)}
                </ul>
              </Field>
            ) : null}
          </Fields>
        )}
      </Panel>
      <LegacyLadder ladder={row?.ladder ?? null} />
    </div>
  );
}

function DocsTab({ detail, selection, mission, slice, doc, onDoc }: { detail: ProjectSliceDetail; selection: ProjectSelection; mission: string; slice: string; doc: string | undefined; onDoc: (relPath: string | undefined) => void }) {
  const files = detail.docs.tree.filter((f) => f.type === "file");
  const document = useProjectSliceDocument(LOCAL_OPERATOR_INSTANCE, selection, mission, slice, doc ?? null);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_1fr]">
      <nav aria-label="Slice documents" data-testid="slice-docs-list">
        {files.length === 0 ? <p className="text-sm text-on-surface-variant">No documents are listed for this slice.</p> : (
          <ul onKeyDown={(e) => listKeyboard(e)} className="divide-y divide-outline-variant/60 border border-outline-variant">
            {files.map((f) => (
              <li key={f.relPath}>
                <button type="button" data-nav-item data-testid={`slice-doc-${f.relPath}`} aria-current={f.relPath === doc ? "true" : undefined}
                  onClick={() => onDoc(f.relPath)}
                  className={cn("w-full px-2 py-1.5 text-left font-mono text-[11px] hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface", f.relPath === doc && "bg-surface-low font-bold")}>
                  {f.relPath}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div data-testid="slice-doc-body" className="min-w-0">
        {!doc ? <p className="text-sm text-on-surface-variant">Choose a document. It is read from the selected project’s slice only.</p> : (
          <ReadGate query={document as ReadLike} what={`Document ${doc}`} testId="slice-doc-read">
            {() => (
              <>
                <ReadStatus query={document as ReadLike} testId="slice-doc-status" />
                {document.data!.content === ""
                  ? <p data-testid="slice-doc-empty" className="text-sm text-on-surface-variant">This document is empty.</p>
                  : <ProjectMarkdown content={document.data!.content} path={document.data!.relPath} project={projectIdentity(selection)} />}
                <p data-testid="slice-doc-relative-note" className="mt-2 text-xs text-on-surface-variant">
                  Read from the selected project on the connected instance. Relative links and images in this document are not resolved here, because the project document read serves its text without a Files location; headings and external links work.
                </p>
              </>
            )}
          </ReadGate>
        )}
      </div>
    </div>
  );
}

export function SliceEvidence({ selection, mission, slice, scope, view, doc, onView, onDoc }: {
  selection: ProjectSelection; mission: string; slice: string; scope: CanonicalSliceScope | null;
  view: string | undefined; doc: string | undefined; onView: (view: SliceView) => void; onDoc: (relPath: string | undefined) => void;
}) {
  const detail = useProjectSliceDetail(LOCAL_OPERATOR_INSTANCE, selection, mission, slice);
  const execution = useExecutionView(LOCAL_OPERATOR_INSTANCE, selection, mission);
  const active: SliceView = doc ? "docs" : isSliceView(view) ? view : "outcomes";
  const row = execution.data ? sliceRows(execution.data.rows[0], null).find((r) => r.dir === slice) ?? null : null;
  return (
    <div data-testid="slice-evidence">
      <TabBar tabs={SLICE_TABS} active={active} onSelect={onView} testId="slice-tabs" label="Slice views" />
      <ReadGate query={detail as ReadLike} what="Slice detail" testId="slice-detail-read">
        {() => {
          const d = detail.data!;
          return (
            <>
              <ReadStatus query={detail as ReadLike} testId="slice-detail-status" />
              {active === "outcomes" ? <NativeOutcomes readiness={d.readiness} testId="slice-native-outcomes" /> : null}
              {active === "proof" ? <div className="space-y-4"><ProofContract scope={scope} /><ProofPackets detail={d} selection={selection} mission={mission} slice={slice} /></div> : null}
              {active === "work" ? (
                <>
                  {execution.error && !execution.data ? <p role="alert" className="mb-2 text-sm text-tertiary">Execution facts unavailable: {execution.error.message}</p> : null}
                  <WorkFacts row={row} scope={scope} />
                </>
              ) : null}
              {active === "story" ? (
                <div className="space-y-4">
                  <Panel title="Story" testId="slice-story" note="Recorded queue and workflow events for this slice, oldest first.">
                    {d.story.events.length === 0 ? <p className="text-sm text-on-surface-variant">No events recorded.</p> : (
                      <ol className="space-y-1">
                        {d.story.events.map((e, i) => (
                          <li key={`${e.ts}-${i}`} className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
                            <span className="font-mono text-[10px] text-on-surface-variant"><Timestamp iso={e.ts} /></span>
                            <span>{e.phase ? <Tag tone="muted">{e.phase}</Tag> : null} {e.summary}<span className="block text-xs text-on-surface-variant">{e.kind}{e.actorSession ? ` · ${e.actorSession}` : ""}{e.qitemId ? ` · ${e.qitemId}` : ""}</span></span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </Panel>
                  <Panel title="Decisions" testId="slice-decisions">
                    {d.decisions.rows.length === 0 ? <p className="text-sm text-on-surface-variant">No decisions recorded.</p> : (
                      <ul className="space-y-1 text-sm">{d.decisions.rows.map((r) => <li key={r.actionId}><Timestamp iso={r.ts} /> · {r.actor} {r.verb} <span className="font-mono text-[11px]">{r.qitemId}</span>{r.beforeState ? ` (${r.beforeState} → ${r.afterState ?? "?"})` : ""}{r.reason ? ` — ${r.reason}` : ""}</li>)}</ul>
                    )}
                  </Panel>
                  {scope?.narrative ? <Disclose summary="Progress narrative (display only)" testId="slice-narrative"><ProjectMarkdown content={scope.narrative} path={scope.progressPath ?? ""} project={projectIdentity(selection)} hideRawToggle /></Disclose> : null}
                </div>
              ) : null}
              {active === "docs" ? <DocsTab detail={d} selection={selection} mission={mission} slice={slice} doc={doc} onDoc={onDoc} /> : null}
              {active === "workflow" ? (
                <Panel title="Workflow binding" testId="slice-workflow"
                  note="The workflow lifecycle bound to this slice. Lifecycle progress is separate from outcome acceptance.">
                  {!d.workflowBinding ? <p className="text-sm text-on-surface-variant">No workflow is bound to this slice.</p> : (
                    <Fields>
                      <Field label="Instance"><Link to="/workflow/instance/$instanceId" params={{ instanceId: d.workflowBinding.instanceId }} className="font-mono text-[12px] underline-offset-2 hover:underline">{d.workflowBinding.instanceId}</Link></Field>
                      <Field label="Workflow">{d.workflowBinding.workflowName} v{d.workflowBinding.workflowVersion} · {d.workflowBinding.status}</Field>
                      <Field label="Current step">{d.workflowBinding.currentStepId ?? "none"} · hop {d.workflowBinding.hopCount}</Field>
                      <Field label="Frontier">{d.workflowBinding.currentFrontier.join(", ") || "empty"}</Field>
                      {d.workflowBinding.additionalInstanceIds.length ? <Field label="Other instances">{d.workflowBinding.additionalInstanceIds.join(", ")}</Field> : null}
                      {d.acceptance.currentStep ? <Field label="Allowed exits">{d.acceptance.currentStep.allowedExits.join(", ")} · next {d.acceptance.currentStep.allowedNextSteps.map((s) => s.stepId).join(", ") || "none"}</Field> : null}
                      <Field label="Rigs">{d.topology.affectedRigs.map((r) => `${r.rigName} (${r.sessionNames.join(", ")})`).join("; ") || "none"}</Field>
                    </Fields>
                  )}
                  <p className="mt-2 text-[11px] text-on-surface-variant">Commit refs: {displayValue(d.commitRefs)} · last activity <Timestamp iso={d.lastActivityAt} /></p>
                </Panel>
              ) : null}
            </>
          );
        }}
      </ReadGate>
    </div>
  );
}
