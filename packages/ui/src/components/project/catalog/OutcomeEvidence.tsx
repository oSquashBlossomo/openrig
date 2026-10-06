// Outcome evidence for one exact slice: native readiness judgments (current
// and retained history), proof-contract pairing, and the legacy delivery
// ladder. Three different facts, three different panels. Pairing a proof drop
// or a legacy PASS never counts as an accepted outcome.

import type { CanonicalSliceScope, ExecutionLadder, MissionReadiness, NativeJudgment, ScopeReadiness } from "../../../lib/project-read.js";
import { CopyButton, Disclose, Field, Fields, Panel, Tag, Timestamp } from "./evidence-ui.js";
import { itemStateTone, outcomeSummary, RUNGS, RUNG_WORD, rungCell, rungTone } from "./execution-model.js";

const short = (value: string, n = 12) => (value.length > n ? `${value.slice(0, n)}…` : value);

function JudgmentDetail({ judgment, testId }: { judgment: NativeJudgment; testId: string }) {
  return (
    <div data-testid={testId} className="mt-1.5 border-l-2 border-outline-variant pl-3">
      <p className="text-sm text-on-surface">
        <Tag tone={judgment.verdict === "accept" ? "good" : "bad"} testId={`${testId}-verdict`}>{judgment.verdict}</Tag>
        <span className="ml-2">by <span className="font-mono text-[12px]">{judgment.actor}</span> · <Timestamp iso={judgment.at} /></span>
      </p>
      <p className="mt-1 text-sm text-on-surface">{judgment.reason}</p>
      {judgment.previous ? (
        <p data-testid={`${testId}-corrects`} className="mt-1 text-xs text-on-surface-variant">
          Corrects earlier judgment <span className="font-mono">{judgment.previous}</span>
        </p>
      ) : null}
      <Disclose summary="Evidence, subject and provenance" testId={`${testId}-detail`}>
        <Fields>
          <Field label="Subject">{judgment.subject.kind} · <span className="font-mono text-[11px]">{judgment.subject.ref}</span>{judgment.subject.comparison ? ` (${judgment.subject.comparison})` : ""}</Field>
          <Field label="Evidence">
            {judgment.evidence.length ? (
              <ul className="space-y-0.5">
                {judgment.evidence.map((e) => (
                  <li key={`${e.ref}:${e.sha256}`} className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                    <span>{e.ref}</span><span className="text-on-surface-variant" title={e.sha256}>sha256 {short(e.sha256)}</span>
                    <CopyButton value={e.sha256} label="Copy hash" />
                  </li>
                ))}
              </ul>
            ) : "none cited"}
          </Field>
          <Field label="Intent">{judgment.intent}</Field>
          <Field label="Provenance"><span className="font-mono text-[11px]">{judgment.provenance}</span></Field>
          <Field label="Judgment"><span className="font-mono text-[11px]">{judgment.id} · sequence {judgment.sequence} · operation {judgment.operationId}</span></Field>
          <Field label="Revisions"><span className="font-mono text-[11px]">item {judgment.itemRevision} · policy {judgment.policyRevision} ({judgment.policySource})</span></Field>
        </Fields>
      </Disclose>
    </div>
  );
}

/** Canonical native readiness for one slice: only the current judgment counts. */
export function NativeOutcomes({ readiness, testId = "native-outcomes" }: { readiness: ScopeReadiness | null | undefined; testId?: string }) {
  const summary = outcomeSummary(readiness);
  return (
    <Panel title="Accepted outcomes" testId={testId}
      note="Native outcome judgments recorded by the configured judges. Only the current judgment for each item drives readiness; declared status, proof pairing and legacy review verdicts are shown separately."
      right={<Tag tone={summary.tone} testId={`${testId}-summary`}>{summary.label}</Tag>}>
      {!readiness ? (
        <p className="text-sm text-on-surface-variant">The daemon did not serve native readiness for this slice.</p>
      ) : (
        <>
          {!readiness.configured ? (
            <p data-testid={`${testId}-unconfigured`} className="mb-2 text-sm text-on-surface-variant">
              No native outcome policy is configured, so no outcome can be accepted here. Declared status and legacy evidence are not substitutes.
            </p>
          ) : null}
          {readiness.issues.length ? (
            <ul data-testid={`${testId}-issues`} className="mb-2 list-disc pl-5 text-sm text-warning">
              {readiness.issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          ) : null}
          <ol className="space-y-3">
            {readiness.items.map((item) => (
              <li key={item.id} data-testid={`${testId}-item-${item.id}`} className="border border-outline-variant bg-surface-lowest px-3 py-2">
                <div className="flex flex-wrap items-start gap-2">
                  <Tag tone={itemStateTone(item.state)} testId={`${testId}-item-${item.id}-state`}>{item.state}</Tag>
                  <span className="min-w-0 flex-1 text-sm text-on-surface">{item.index}. {item.text}</span>
                </div>
                <p className="mt-1 text-xs text-on-surface-variant">{item.reason}</p>
                <p className="mt-0.5 font-mono text-[10px] text-on-surface-variant">{item.source.file}:{item.source.line} · item revision {short(item.revision)}</p>
                {item.judgment ? <JudgmentDetail judgment={item.judgment} testId={`${testId}-item-${item.id}-judgment`} />
                  : <p className="mt-1 text-xs text-on-surface-variant">No current judgment.</p>}
              </li>
            ))}
          </ol>
          {readiness.history.length ? (
            <Disclose summary={`Retained judgment history (${readiness.history.length})`} testId={`${testId}-history`}>
              <p className="mb-1 text-xs text-on-surface-variant">Earlier and superseded judgments remain on record. They do not drive readiness.</p>
              <ul className="space-y-0.5 font-mono text-[11px]">
                {readiness.history.map((h) => (
                  <li key={h.ref}>
                    <Tag tone={h.verdict === "accept" ? "muted" : "bad"}>{h.verdict}</Tag>{" "}
                    {h.itemId} · {h.id}{h.previous ? ` · corrects ${h.previous}` : ""} · <span className="text-on-surface-variant">{h.ref}</span>
                  </li>
                ))}
              </ul>
            </Disclose>
          ) : null}
          <Disclose summary="Policy and revision" testId={`${testId}-policy`}>
            <Fields>
              <Field label="State">{readiness.state}</Field>
              <Field label="Revision"><span className="font-mono text-[11px]">{readiness.revision}</span></Field>
              <Field label="Judges">{readiness.policy?.judges.join(", ") || "not configured"}</Field>
              <Field label="Policy source"><span className="font-mono text-[11px]">{readiness.policy ? `${readiness.policy.source} · ${readiness.policy.revision}` : "none"}</span></Field>
              <Field label="Attention scope"><span className="font-mono text-[11px]">{readiness.attention.scope} · {readiness.attention.revision}</span></Field>
            </Fields>
          </Disclose>
        </>
      )}
    </Panel>
  );
}

export function MissionOutcomeLine({ readiness, testId }: { readiness: MissionReadiness | null | undefined; testId: string }) {
  if (!readiness) return <Tag tone="muted" testId={testId}>outcomes not served</Tag>;
  const complete = readiness.slices.filter((s) => outcomeSummary(s.readiness).complete).length;
  const tone = readiness.state === "ready" && complete === readiness.slices.length && readiness.slices.length > 0 ? "good"
    : readiness.state === "unknown" ? "warn" : "neutral";
  return <Tag tone={tone} testId={testId} title={`native readiness ${readiness.state} · revision ${readiness.revision}`}>{complete}/{readiness.slices.length} slice outcomes accepted</Tag>;
}

/** Requirement ↔ proof drop pairing. A pairing is evidence placement, not acceptance. */
export function ProofContract({ scope, testId = "proof-contract" }: { scope: CanonicalSliceScope | null; testId?: string }) {
  if (!scope) return <Panel title="Proof contract" testId={testId}><p className="text-sm text-on-surface-variant">The selected mission did not serve this slice's scope record.</p></Panel>;
  return (
    <Panel title="Proof contract" testId={testId}
      note="Each requirement and the proof drops filed against it. Pairing shows where evidence was placed; it is not an accepted outcome. Verdict words come from the artifact text."
      right={<Tag tone="muted" testId={`${testId}-paired`}>{scope.proof.paired}/{scope.proof.total} paired</Tag>}>
      {scope.proofContract.length === 0 ? <p className="text-sm text-on-surface-variant">No proof contract items are declared.</p> : (
        <ol className="space-y-2">
          {scope.proofContract.map((item) => (
            <li key={item.id} data-testid={`${testId}-item-${item.id}`} className="border border-outline-variant px-3 py-2">
              <div className="flex flex-wrap items-start gap-2">
                <Tag tone={item.paired ? "info" : "muted"}>{item.paired ? "paired" : "no drop"}</Tag>
                <span className="min-w-0 flex-1 text-sm">{item.index}. {item.text}</span>
              </div>
              <p className="mt-0.5 font-mono text-[10px] text-on-surface-variant">{item.source.file}:{item.source.line}</p>
              {item.drops.length ? (
                <ul className="mt-1 space-y-1">
                  {item.drops.map((drop) => (
                    <li key={drop.file} className="text-xs">
                      <span className="font-mono text-[11px]">{drop.file}</span>
                      {drop.artifactType ? <span className="ml-2 text-on-surface-variant">{drop.artifactType}</span> : null}
                      {drop.verdict ? <span data-testid={`${testId}-drop-verdict`} className="ml-2 text-on-surface-variant">artifact says “{drop.verdict}”</span> : null}
                      {drop.media.length ? (
                        <div className="mt-0.5 text-on-surface-variant">
                          Media: {drop.media.map((m) => <span key={m} className="mr-2 font-mono text-[11px]">{m}</span>)}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <p data-testid={`${testId}-media-note`} className="mt-2 text-xs text-on-surface-variant">
        Media paths are relative to the slice source{scope.sourcePath ? <> (<span className="font-mono">{scope.sourcePath}</span>)</> : null}. This view does not load them:
        catalog projects have no proof-packet source, and the default workspace is never substituted.
      </p>
    </Panel>
  );
}

/** The five-rung legacy code-evidence ladder, each rung with its derivation basis. */
export function LegacyLadder({ ladder, testId = "legacy-ladder" }: { ladder: ExecutionLadder | null; testId?: string }) {
  return (
    <Panel title="Legacy delivery ladder" testId={testId}
      note="Code-delivery evidence derived from specs, candidates, review artifacts and git. It is not outcome acceptance; an undetermined rung stays undetermined.">
      {!ladder ? <p className="text-sm text-on-surface-variant">The execution view did not serve a ladder row for this slice.</p> : (
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-5">
          {RUNGS.map((rung) => {
            const cell = rungCell(ladder, rung);
            return (
              <li key={rung} data-testid={`${testId}-${rung}`} data-state={cell.state} className="border border-outline-variant px-2 py-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em]">{RUNG_WORD[rung]}</span>
                  <Tag tone={rungTone(cell)}>{cell.state}</Tag>
                </div>
                {cell.detail ? <p className="mt-0.5 font-mono text-[10px]" title={cell.detail}>{short(cell.detail, 10)}</p> : null}
                <p className="mt-0.5 text-[11px] text-on-surface-variant">{cell.basis}</p>
              </li>
            );
          })}
        </ol>
      )}
      {ladder ? (
        <Disclose summary={`Review legs (${ladder.reviewed.legs.length})${ladder.reviewed.excluded?.length ? ` · ${ladder.reviewed.excluded.length} excluded` : ""}`} testId={`${testId}-legs`}>
          <ul className="space-y-0.5 text-xs">
            {ladder.reviewed.legs.map((leg) => (
              <li key={leg.path}><span className="font-mono text-[11px]">{leg.path}</span> · artifact says “{leg.verdict}”{leg.candidate_sha ? ` · candidate ${short(leg.candidate_sha, 9)}` : ""}{leg.artifact_type ? ` · ${leg.artifact_type}` : ""}</li>
            ))}
            {ladder.reviewed.excluded?.map((e) => <li key={e.path} className="text-on-surface-variant"><span className="font-mono text-[11px]">{e.path}</span> · excluded: {e.reason}</li>)}
          </ul>
          {ladder.built.resolved_commit ? <p className="mt-1 text-xs">Resolved commit <span className="font-mono">{ladder.built.resolved_commit}</span></p> : null}
        </Disclose>
      ) : null}
    </Panel>
  );
}
