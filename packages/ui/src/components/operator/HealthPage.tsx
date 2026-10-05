// Canonical Health — connected-instance findings, exact-ID detail.
//
// Reads /api/health (+ /api/health/:findingId) through the typed canonical
// hooks. Empty findings are never a healthy verdict; coverage, truncation
// and freshness stay visible. Operating posture and diagnosis ceremony are
// passive evidence and grant no authority.

import { useCallback, useMemo, useRef } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { LOCAL_OPERATOR_INSTANCE } from "../../lib/operator-read.js";
import { useCanonicalHealth, useCanonicalHealthDetail, type HealthListProjection, type HealthRecord } from "../../hooks/useCanonicalHealth.js";
import {
  ChipGroup, DetailSection, Field, Fields, ListDetailLayout, OperatorPageHeader, OperatorReadGate,
  ReadFailure, ReadStatusBar, SearchInput, Tag, TechnicalDetails, Timestamp, displayScalar, formatAgeSeconds,
  listKeyboardHandler, useConnectedInstance, useUrlSyncedText, type Tone,
} from "./OperatorPrimitives.js";
import { HEALTH_SEVERITIES, HEALTH_STATUSES, validateHealthSearch, type HealthSearch } from "./operator-search.js";
import { matchesQuery } from "./attention-model.js";

type Scope = HealthRecord["scope"];
type Evidence = HealthRecord["evidence"][number];
type Coverage = NonNullable<HealthListProjection["coverage"]>[number];

const STATUS_ORDER = { active: 0, indeterminate: 1, cleared: 2 } as const;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

export function compareHealthRecords(a: HealthRecord, b: HealthRecord): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || (Date.parse(b.lastObservedAt ?? "") || 0) - (Date.parse(a.lastObservedAt ?? "") || 0)
    || a.id.localeCompare(b.id, "en-US");
}

/** STALE / Unknown / CLEARED — unknown and stale never paint as current. */
export function conditionLabel(record: HealthRecord): string | null {
  if (record.freshness.state === "stale") return "Stale";
  if (record.status === "indeterminate" || record.freshness.state === "unavailable" || record.freshness.state === "contradictory") return "Unknown";
  if (record.status === "cleared") return "Cleared";
  return null;
}

function recordTone(record: HealthRecord): Tone {
  if (record.status === "indeterminate" || record.freshness.state !== "fresh") return "warn";
  if (record.status === "cleared") return "muted";
  if (record.severity === "critical") return "bad";
  if (record.severity === "warning") return "warn";
  return "info";
}

/** The terminal identity the daemon accepts as `scope_id` (healthScopeId). */
export function scopeTerminalId(scope: Scope): string {
  switch (scope.type) {
    case "instance": return scope.instanceId;
    case "rig": return scope.rigId;
    case "seat": return scope.seatId;
    case "mission": return scope.missionId;
    case "slice": return scope.sliceId;
  }
}

export function scopeLabel(scope: Scope): string {
  switch (scope.type) {
    case "instance": return `instance ${scope.instanceId}`;
    case "rig": return `rig ${scope.rigId}`;
    case "seat": return `seat ${scope.seatId} · rig ${scope.rigId}`;
    case "mission": return `mission ${scope.missionId} · project ${scope.projectId}`;
    case "slice": return `slice ${scope.sliceId} · mission ${scope.missionId} · project ${scope.projectId}`;
  }
}

/** Selection pushes history (Back returns to the previous finding); filter
 * and search edits replace it. Both merge into the CURRENT URL state rather
 * than a render-time snapshot, so rapid edits never drop another field. */
function useHealthNavigation() {
  const navigate = useNavigate();
  const select = useCallback((finding: string | undefined) => void navigate({
    to: "/settings/health", search: (prev: Record<string, unknown>) => ({ ...validateHealthSearch(prev), finding }),
  }), [navigate]);
  const setFilters = useCallback((patch: Partial<HealthSearch>) => void navigate({
    to: "/settings/health", search: (prev: Record<string, unknown>) => ({ ...validateHealthSearch(prev), ...patch }), replace: true,
  }), [navigate]);
  return { select, setFilters };
}

export function HealthPage() {
  const search = validateHealthSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const nav = useHealthNavigation();
  const list = useCanonicalHealth(LOCAL_OPERATOR_INSTANCE, {
    severity: search.severity, status: search.status,
    ...(search.scopeType && search.scopeId ? { scopeType: search.scopeType, scopeId: search.scopeId } : {}),
  });
  const detail = useCanonicalHealthDetail(LOCAL_OPERATOR_INSTANCE, search.finding ?? null);
  const writeQuery = useCallback((q: string | undefined) => nav.setFilters({ q }), [nav.setFilters]);
  const [query, setQuery] = useUrlSyncedText(search.q, writeQuery);

  const records = useMemo(() => [...(list.data?.records ?? [])].sort(compareHealthRecords), [list.data]);
  const visible = useMemo(() => records.filter((record) => matchesQuery([
    record.summary, record.detector, record.id, record.category, scopeLabel(record.scope), record.explanation,
  ], query)), [records, query]);
  const serverFiltered = Boolean(search.severity || search.status || search.scopeType);

  return (
    <div data-testid="operator-health-page" className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6">
      <OperatorPageHeader
        testId="operator-health"
        title="Health"
        description="Canonical findings evaluated by the connected daemon: explanation, freshness, coverage and typed evidence. An empty list is not a healthy verdict. Process status for the daemon itself lives under Status."
      />
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-3">
          <ChipGroup
            label="Severity" testId="health-filter-severity" value={search.severity ?? "all"}
            options={[{ id: "all", label: "All" }, ...HEALTH_SEVERITIES.map((id) => ({ id, label: id }))]}
            onChange={(value) => nav.setFilters({ severity: value === "all" ? undefined : value })}
          />
          <ChipGroup
            // The daemon's default read omits cleared findings; "Open" names that
            // default truthfully instead of calling it "All".
            label="Status" testId="health-filter-status" value={search.status ?? "all"}
            options={[{ id: "all", label: "Open" }, ...HEALTH_STATUSES.map((id) => ({ id, label: id }))]}
            onChange={(value) => nav.setFilters({ status: value === "all" ? undefined : value })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            label="Search served findings" testId="health-search" value={query} placeholder="summary, detector, scope, finding id"
            onChange={setQuery}
          />
          {search.scopeType && search.scopeId ? (
            <span data-testid="health-scope-filter" className="inline-flex items-center gap-1 border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase">
              Scope {search.scopeType} {search.scopeId}
              <button type="button" aria-label="Clear scope filter" data-testid="health-scope-filter-clear" className="ml-1 hover:text-tertiary" onClick={() => nav.setFilters({ scopeType: undefined, scopeId: undefined })}>×</button>
            </span>
          ) : null}
        </div>
      </div>

      <OperatorReadGate query={list} what="Canonical health" testId="health-list">
        {() => (
          <>
            <ReadStatusBar query={list} servedAt={list.data!.evaluatedAt} servedLabel="evaluated" testId="health-read" />
            <HealthSummary data={list.data!} statusFilter={search.status} />
            <ListDetailLayout
              testId="health-layout" listLabel="All findings" hasSelection={Boolean(search.finding)}
              onClearSelection={() => nav.select(undefined)}
              list={<div data-testid="health-list"><HealthList records={visible} total={records.length} query={query} serverFiltered={serverFiltered} data={list.data!} selected={search.finding} onSelect={nav.select} /></div>}
              detail={<HealthDetailPanel findingId={search.finding ?? null} detail={detail} listed={records.find((r) => r.id === search.finding)} listReadAt={list.dataUpdatedAt} onFilterScope={(scope) => nav.setFilters({ scopeType: scope.type, scopeId: scopeTerminalId(scope) })} />}
            />
          </>
        )}
      </OperatorReadGate>
    </div>
  );
}

function coverageText(c: Coverage): string {
  if (c.status === "unavailable") return `${c.source} unavailable — ${c.reason}. Not assessed; results are partial.`;
  return `${c.source}: evaluated ${c.evaluated} of ${c.total} ${c.unit}; ${c.omitted} omitted (limit ${c.limit}, ${c.order})${c.partial ? " — partial; omitted items are not evaluated and are not healthy" : ""}.`;
}

function HealthSummary({ data, statusFilter }: { data: HealthListProjection; statusFilter: HealthSearch["status"] }) {
  const active = data.records.filter((r) => r.status === "active");
  const counts = HEALTH_SEVERITIES.map((sev) => [sev, active.filter((r) => r.severity === sev).length] as const);
  const unknown = data.records.filter((r) => r.status === "indeterminate").length;
  const cleared = data.records.filter((r) => r.status === "cleared").length;
  const partialCoverage = (data.coverage ?? []).filter((c) => c.partial);
  return (
    <section data-testid="health-summary" aria-label="Health summary" className="mb-4 border border-on-surface bg-surface-lowest px-4 py-3 hard-shadow">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">Active</span>
        {counts.map(([sev, n]) => (
          <Tag key={sev} testId={`health-count-${sev}`} tone={n === 0 ? "muted" : sev === "critical" ? "bad" : sev === "warning" ? "warn" : "info"}>{sev} {n}</Tag>
        ))}
        <Tag testId="health-count-unknown" tone={unknown ? "warn" : "muted"}>Unknown {unknown}</Tag>
        {statusFilter === undefined ? (
          <Tag testId="health-count-cleared" tone="muted" title="The default read omits cleared findings; choose Status · cleared to read them.">Cleared · not in this read</Tag>
        ) : <Tag testId="health-count-cleared" tone="muted">Cleared {cleared}</Tag>}
        {data.truncated ? <Tag testId="health-truncated" tone="warn">Partial · showing {data.records.length} of {data.total}</Tag> : (
          <span data-testid="health-total" className="font-mono text-[10px] uppercase text-on-surface-variant">{data.records.length} of {data.total} served (limit {data.limit})</span>
        )}
      </div>
      <div data-testid="health-coverage" className="mt-2 text-xs text-on-surface-variant">
        {data.coverage === undefined ? (
          <p data-testid="health-coverage-absent">This read reports no bounded-source coverage. Findings are the daemon&apos;s served records, not a complete assessment.</p>
        ) : data.coverage.length === 0 ? (
          <p>No source reported bounded or unavailable input in this read.</p>
        ) : (
          <ul className="space-y-0.5">
            {data.coverage.map((c, i) => (
              <li key={`${c.source}-${i}`} data-testid={`health-coverage-${c.source}`} className={cn(c.partial && "text-warning")}>{coverageText(c)} <span className="text-on-surface-variant">(<Timestamp iso={c.evaluatedAt} />)</span></li>
            ))}
          </ul>
        )}
        {partialCoverage.length || data.truncated ? <p className="mt-1 font-mono text-[10px] uppercase text-warning" data-testid="health-partial">Partial result</p> : null}
      </div>
    </section>
  );
}

function HealthList({ records, total, query, serverFiltered, data, selected, onSelect }: {
  records: HealthRecord[]; total: number; query: string; serverFiltered: boolean; data: HealthListProjection;
  selected: string | undefined; onSelect: (id: string) => void;
}) {
  if (total === 0) {
    const unavailable = (data.coverage ?? []).filter((c) => c.status === "unavailable");
    return (
      <div data-testid="health-empty" className="border border-dashed border-outline-variant px-4 py-5 text-sm">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface">{serverFiltered ? "No findings match these filters" : "No open findings served"}</p>
        <p className="mt-1 text-on-surface-variant">This is not a healthy verdict{unavailable.length ? `: ${unavailable.map((c) => c.source).join(", ")} could not be assessed` : data.coverage === undefined ? "; coverage was not reported" : ""}.</p>
      </div>
    );
  }
  if (records.length === 0) {
    return <p data-testid="health-filter-empty" className="border border-dashed border-outline-variant px-4 py-5 text-sm text-on-surface-variant">No served findings match “{query}”. {total} finding{total === 1 ? "" : "s"} hidden by the search.</p>;
  }
  return (
    <ul aria-label="Health findings" data-testid="health-list-items" onKeyDown={listKeyboardHandler} className="divide-y divide-outline-variant border border-outline-variant">
      {records.map((record) => {
        const condition = conditionLabel(record);
        const isSelected = record.id === selected;
        return (
          <li key={record.id}>
            <button
              type="button" data-list-item data-testid={`health-row-${record.id}`} aria-current={isSelected ? "true" : undefined}
              onClick={() => onSelect(record.id)}
              className={cn("block w-full px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface",
                isSelected ? "bg-surface-low" : "hover:bg-surface-low/60")}
            >
              <span className="flex flex-wrap items-center gap-1.5">
                <Tag tone={recordTone(record)}>{record.severity}</Tag>
                {condition ? <Tag tone="warn">{condition}</Tag> : null}
                <span className="font-mono text-[9px] uppercase text-on-surface-variant">{record.detector}</span>
              </span>
              <span className="mt-1 block break-words text-sm text-on-surface [overflow-wrap:anywhere]">{record.summary}</span>
              <span className="mt-0.5 block break-words font-mono text-[10px] text-on-surface-variant [overflow-wrap:anywhere]">
                {scopeLabel(record.scope)} · age {formatAgeSeconds(record.freshness.ageSeconds)} · {record.confidence} confidence
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type DetailQuery = ReturnType<typeof useCanonicalHealthDetail>;

function HealthDetailPanel({ findingId, detail, listed, listReadAt, onFilterScope }: {
  findingId: string | null; detail: DetailQuery; listed: HealthRecord | undefined; listReadAt: number; onFilterScope: (scope: Scope) => void;
}) {
  // Continuity: the last exact record seen for this ID survives a failed
  // refresh or its disappearance from the list, labeled as such.
  const lastSeen = useRef<{ id: string; record: HealthRecord } | null>(null);
  if (detail.data && detail.data.id === findingId) lastSeen.current = { id: detail.data.id, record: detail.data };
  if (!findingId) {
    return <p data-testid="health-detail-empty" className="border border-dashed border-outline-variant px-4 py-6 text-sm text-on-surface-variant">Select a finding to read its explanation, freshness and typed evidence.</p>;
  }
  const exact = detail.data?.id === findingId ? detail.data : undefined;
  const retained = !exact && lastSeen.current?.id === findingId ? lastSeen.current.record : undefined;
  const fallback = exact ?? retained ?? listed;
  if (!fallback) {
    if (detail.error) return <ReadFailure error={detail.error} what={`Finding ${findingId}`} onRetry={() => void detail.refetch()} testId="health-detail-error" />;
    return <p role="status" data-testid="health-detail-loading" className="px-4 py-6 font-mono text-[11px] uppercase text-on-surface-variant">Reading finding {findingId}…</p>;
  }
  return (
    <article data-testid="health-detail" aria-label={`Finding ${fallback.id}`} className="border border-on-surface bg-surface-lowest px-4 py-3">
      {exact ? <ReadStatusBar query={detail} testId="health-detail-read" /> : null}
      {!exact && detail.error ? (
        <p role="alert" data-testid="health-detail-fallback" className="mb-2 border border-warning px-3 py-2 text-xs text-on-surface">
          Exact detail read failed ({detail.error.message}). Showing the {retained ? "last exact record read for this ID" : <>record from the list read at <Timestamp iso={new Date(listReadAt).toISOString()} /></>}; it may no longer be current.
        </p>
      ) : null}
      {!listed ? (
        <p data-testid="health-detail-not-listed" className="mb-2 text-xs text-on-surface-variant">
          This finding is not in the current list (filtered out, beyond the served limit, or no longer served). It is shown by its exact ID.
        </p>
      ) : null}
      <HealthRecordDetail record={fallback} onFilterScope={onFilterScope} />
    </article>
  );
}

function HealthRecordDetail({ record, onFilterScope }: { record: HealthRecord; onFilterScope: (scope: Scope) => void }) {
  const condition = conditionLabel(record);
  const assessment = record.status === "indeterminate" || record.freshness.state !== "fresh" ? "Unknown" : record.status;
  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone={recordTone(record)}>{record.severity}</Tag>
          {condition ? <Tag tone="warn">{condition}</Tag> : null}
          <Tag tone="muted">{record.category}</Tag>
        </div>
        <h2 data-testid="health-detail-summary" className="mt-2 break-words font-headline text-lg font-bold text-on-surface [overflow-wrap:anywhere]">{record.summary}</h2>
      </div>
      <DetailSection title="Signal" testId="health-detail-signal">
        <Fields>
          <Field label="Assessment" testId="health-detail-assessment">{assessment}</Field>
          {record.indeterminateReason ? <Field label="Unknown because">{record.indeterminateReason}</Field> : null}
          <Field label="Finding ID" copy={record.id} testId="health-detail-id"><span className="font-mono text-xs">{record.id}</span></Field>
          <Field label="Detector">{record.detector}</Field>
          <Field label="Status">{record.status}</Field>
          <Field label="Confidence">{record.confidence}</Field>
          <Field label="Started"><Timestamp iso={record.startedAt} /></Field>
          <Field label="Last observed"><Timestamp iso={record.lastObservedAt} /></Field>
          <Field label="Schema"><span className="font-mono text-xs">{record.schema}</span></Field>
        </Fields>
      </DetailSection>
      <HealthScopeSection scope={record.scope} onFilterScope={onFilterScope} />
      <DetailSection title="Freshness & window" testId="health-detail-freshness" note="Ages come from the daemon's source observations, not from this page's poll.">
        <Fields>
          <Field label="Freshness" testId="health-detail-freshness-state">{record.freshness.state}</Field>
          <Field label="Evaluated"><Timestamp iso={record.freshness.evaluatedAt} /></Field>
          <Field label="Newest source"><Timestamp iso={record.freshness.newestSourceAt} fallback="no source observation" /></Field>
          <Field label="Source age">{formatAgeSeconds(record.freshness.ageSeconds)} (max {formatAgeSeconds(record.freshness.maxAgeSeconds)})</Field>
          <Field label="Window">{record.window.source} · <Timestamp iso={record.window.startedAt} /> → <Timestamp iso={record.window.endedAt} /></Field>
          <Field label="Window bounds">limit {record.window.limit} · retention {formatAgeSeconds(record.window.retentionSeconds)}</Field>
        </Fields>
      </DetailSection>
      <DetailSection title="Explanation" testId="health-detail-explanation">
        <Fields>
          <Field label="Why"><span className="whitespace-pre-wrap">{record.explanation}</span></Field>
          <Field label="Threshold">{record.threshold}</Field>
          <Field label="Policy">{record.policyVersion ?? "not reported by source"}</Field>
          <Field label="Inspect next" copy={record.suggestedInspection} testId="health-detail-inspect"><span className="whitespace-pre-wrap font-mono text-xs">{record.suggestedInspection}</span></Field>
        </Fields>
      </DetailSection>
      {record.operatingPosture ? <PostureSection posture={record.operatingPosture} /> : null}
      {record.ceremony ? <CeremonySection ceremony={record.ceremony} /> : null}
      <EvidenceSection evidence={record.evidence} />
      <TechnicalDetails value={record} testId="health-detail-raw" />
    </div>
  );
}

function HealthScopeSection({ scope, onFilterScope }: { scope: Scope; onFilterScope: (scope: Scope) => void }) {
  const { remoteSelection } = useConnectedInstance();
  const rigId = scope.type === "rig" || scope.type === "seat" ? scope.rigId : null;
  return (
    <DetailSection title="Scope identity" testId="health-detail-scope">
      <Fields>
        <Field label="Scope type">{scope.type}</Field>
        {Object.entries(scope).filter(([k]) => k !== "type").map(([key, value]) => (
          <Field key={key} label={key} copy={String(value)}><span className="font-mono text-xs">{String(value)}</span></Field>
        ))}
      </Fields>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" data-testid="health-filter-this-scope" onClick={() => onFilterScope(scope)} className="border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low">
          Show findings for this {scope.type}
        </button>
        {rigId && !remoteSelection ? (
          <Link to="/topology/rig/$rigId" params={{ rigId }} data-testid="health-scope-rig-link" className="border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low">
            Open rig {rigId} →
          </Link>
        ) : null}
      </div>
      {rigId && remoteSelection ? <p className="mt-1 text-xs text-on-surface-variant">Rig link hidden: topology is viewing {remoteSelection}, and this rig belongs to the connected instance.</p> : null}
      {scope.type === "seat" ? <p className="mt-1 text-xs text-on-surface-variant">The seat route needs a logical seat name, which this record does not carry; the seat is identified by its exact ID above.</p> : null}
      {scope.type === "mission" || scope.type === "slice" ? <p className="mt-1 text-xs text-on-surface-variant">Project work is identified by its exact project, mission and slice IDs; no route is inferred from them.</p> : null}
    </DetailSection>
  );
}

function PostureSection({ posture }: { posture: NonNullable<HealthRecord["operatingPosture"]> }) {
  return (
    <DetailSection title="Operating posture · passive evidence" testId="health-detail-posture" note="Posture describes oversight context. It grants no authority and does not approve anything.">
      <Fields>
        <Field label="Posture">{posture.posture}</Field>
        <Field label="Source">{posture.source}</Field>
        <Field label="Reason">{posture.reason}</Field>
        <Field label="Grants authority" testId="health-detail-posture-authority">{String(posture.grantsAuthority)}</Field>
        {posture.binding ? <Field label="Binding">{posture.binding.id} · {posture.binding.scope} · set <Timestamp iso={posture.binding.setAt} /> · {posture.binding.evidence}</Field> : <Field label="Binding">none</Field>}
        {posture.context ? (
          <>
            <Field label="Work phase">{posture.context.phase.value ?? "unknown"} · {posture.context.phase.source ?? "source unavailable"}</Field>
            {(["rigId", "projectId", "missionId", "workstreamId", "qitemId"] as const).map((key) => posture.context?.[key] ? <Field key={key} label={key}><span className="font-mono text-xs">{posture.context[key]}</span></Field> : null)}
            <Field label="Context sources">{displayScalar(posture.context.sources)}</Field>
            {posture.context.paths ? <Field label="Context paths"><span className="font-mono text-xs">{displayScalar(Object.values(posture.context.paths))}</span></Field> : null}
          </>
        ) : <Field label="Context">not supplied by source</Field>}
        {posture.members?.length ? <Field label="Members">{posture.members.map((m) => `${m.qitemId}: ${m.posture} (${m.source}${m.bindingId ? `, ${m.bindingId}` : ""})`).join("; ")}</Field> : null}
      </Fields>
    </DetailSection>
  );
}

function CeremonySection({ ceremony }: { ceremony: NonNullable<HealthRecord["ceremony"]> }) {
  const assessment = ceremony.assessment;
  return (
    <DetailSection title="Diagnosis ceremony · passive evidence" testId="health-detail-ceremony" note="Stage is an evidence-derived interpretation. No acceptance is synthesized from missing facts.">
      <Fields>
        <Field label="Stage" testId="health-detail-ceremony-stage">{ceremony.stage}</Field>
        <Field label="Origin">{ceremony.origin}</Field>
        <Field label="Lineage" copy={ceremony.lineageId}><span className="font-mono text-xs">{ceremony.lineageId}</span></Field>
        <Field label="Basis">{ceremony.basis}</Field>
        <Field label="Transitions">{displayScalar(ceremony.transitionIds)}</Field>
        <Field label="Missing facts">{ceremony.missingFacts.length ? ceremony.missingFacts.join("; ") : "none reported"}</Field>
        {ceremony.context.map((ref, i) => (
          <Field key={`${ref.path}-${i}`} label={`Context · ${ref.role}`} copy={ref.path}>
            <span className="font-mono text-xs">{ref.path}</span> · {ref.state}{ref.sha256 ? ` · sha256 ${ref.sha256}` : ""}
          </Field>
        ))}
        {ceremony.workflowReceipts.map((r) => (
          <Field key={r.trailId} label="Workflow receipt">
            <Link to="/workflow/instance/$instanceId" params={{ instanceId: r.instanceId }} search={{ step: r.stepId }} className="underline">{r.instanceId}</Link>
            {" "}· step {r.stepId} · qitem {r.qitemId} · {r.closureReason} by {r.actor} at <Timestamp iso={r.at} /> · evidence {displayScalar(r.evidence)}
          </Field>
        ))}
        {assessment ? (
          <Field label="Assessment">
            {assessment.result.conclusion} by {assessment.actor} at <Timestamp iso={assessment.at} /> (transition {assessment.transitionId}) · basis {assessment.result.basis} · boundary {assessment.result.boundary} · bounded authority {displayScalar(assessment.result.boundedAuthority)} · evidence {displayScalar(assessment.result.evidenceRefs)} · missing {displayScalar(assessment.result.missingFacts)} · outcomes {assessment.result.outcomes.map((o) => `${o.id} (${o.observedAt}: ${o.evidenceRefs.join(", ")})`).join("; ") || "none"}
          </Field>
        ) : <Field label="Assessment">none recorded</Field>}
      </Fields>
    </DetailSection>
  );
}

const EVIDENCE_HEADLINE: Record<Evidence["type"], (e: Record<string, unknown>) => string> = {
  "queue-transition": (e) => `qitem ${displayScalar(e.qitemId)} · transition ${displayScalar(e.transitionId)} · ${displayScalar(e.state)}`,
  "watchdog-history": (e) => `job ${displayScalar(e.jobId)} · ${displayScalar(e.outcome)}`,
  "work-graph": (e) => `${displayScalar(e.nodeType)} ${displayScalar(e.nodeId)} · mission ${displayScalar(e.missionId)}`,
  "topology-activity": (e) => `node ${displayScalar(e.nodeId)} · activity ${displayScalar(e.activity)}`,
  "context-usage": (e) => `node ${displayScalar(e.nodeId)} · used ${e.usedPercentage === null ? "unknown" : `${displayScalar(e.usedPercentage)}%`}`,
  "occupant-model": (e) => `node ${displayScalar(e.nodeId)} · ${displayScalar(e.runtime)} ${displayScalar(e.model)}`,
  "lifecycle-receipt": (e) => `receipt ${displayScalar(e.receiptId)} · ${displayScalar(e.operation)} · ${displayScalar(e.outcome)}`,
};

function EvidenceSection({ evidence }: { evidence: Evidence[] }) {
  return (
    <DetailSection title={`Evidence · ${evidence.length}`} testId="health-detail-evidence">
      {evidence.length === 0 ? <p className="text-sm text-warning">No evidence served for this finding.</p> : (
        <ol className="space-y-2">
          {[...evidence].sort((a, b) => a.sourceOrder - b.sourceOrder).map((item) => {
            const fields = item as unknown as Record<string, unknown>;
            const headline = EVIDENCE_HEADLINE[item.type]?.(fields) ?? item.type;
            return (
              <li key={`${item.type}-${item.sourceOrder}`} data-testid={`health-evidence-${item.type}`} className="border border-outline-variant px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface">{item.type} · #{item.sourceOrder}</span>
                  <span className="font-mono text-[10px] text-on-surface-variant">observed <Timestamp iso={item.observedAt} fallback="no observation time" /></span>
                </div>
                <p className="mt-1 break-words text-sm text-on-surface [overflow-wrap:anywhere]">{headline}</p>
                <Fields>
                  {Object.entries(fields).filter(([k]) => !["type", "sourceOrder", "observedAt"].includes(k)).map(([key, value]) => (
                    <Field key={key} label={key}><span className="font-mono text-xs">{displayScalar(value)}</span></Field>
                  ))}
                </Fields>
              </li>
            );
          })}
        </ol>
      )}
    </DetailSection>
  );
}
