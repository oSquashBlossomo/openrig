// Scoped canonical Health for topology (docs/plans/gui-scoped-health-integration.md).
//
// One bounded connected-instance read — useCanonicalHealth(LOCAL_OPERATOR_
// INSTANCE, {limit: 200}), the same shared query the operator page uses — is
// projected onto the topology context with the TUI's display predicates:
//   host  → every served record (the connected instance's projection);
//   rig   → rig records for that exact rig id AND seat records whose rigId
//           matches (descendants);
//   pod   → HealthScope has no pod: the ENCLOSING rig's predicate, labelled so;
//   seat  → seat records whose rigId AND seatId equal the admitted detail's
//           rigId and stable nodeId, compared byte-for-byte. A missing/empty/
//           blank nodeId means the seat identity is unavailable, never "zero".
// Canonical Health is not forwarded to remote hosts, so a remote source shows
// a named unavailable state and reads/shows nothing local. Counts describe
// matching SERVED rows: the read is bounded (limit/truncation/coverage) and
// the default status omits cleared findings, so emptiness is never "healthy".
// Each finding opens the existing canonical detail (/settings/health?finding=)
// with a normal push, so Back returns to the exact topology entry.

import type { ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { useCanonicalHealth, type HealthListProjection, type HealthRecord } from "../../hooks/useCanonicalHealth.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { LOCAL_OPERATOR_INSTANCE } from "../../lib/operator-read.js";
import { cn } from "../../lib/utils.js";
import { formatAgeSeconds, listKeyboardHandler, LoadingBlock, ReadFailure, ReadStatusBar, Tag, Timestamp, type Tone } from "../operator/OperatorPrimitives.js";
import { prepareTopologyDrill, useKnownSelectedHost } from "./topology-navigation.js";
import type { TopologyScope } from "../../lib/topology-location.js";

export const SCOPED_HEALTH_LIMIT = 200;

export type HealthDisplayScope =
  | { kind: "host" }
  | { kind: "rig"; rigId: string }
  | { kind: "pod"; rigId: string; podName: string }
  /** nodeId: the admitted detail's stable seat identity (null = unavailable). */
  | { kind: "seat"; rigId: string; nodeId: string | null };

/** A served stable seat id is usable only when it is a nonempty string that is
 *  not whitespace-only. The original bytes are returned — never trimmed. */
export function usableSeatHealthId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const STATUS_ORDER = { active: 0, indeterminate: 1, cleared: 2 } as const;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

/** TUI/operator ordering: status, severity, newest observation, exact id. */
export function compareScopedHealth(a: HealthRecord, b: HealthRecord): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || (Date.parse(b.lastObservedAt ?? "") || 0) - (Date.parse(a.lastObservedAt ?? "") || 0)
    || a.id.localeCompare(b.id, "en-US");
}

/** Matching served records in display order; null when the scope's identity
 *  is unavailable (no correlation is attempted). */
export function healthRecordsForScope(records: readonly HealthRecord[], scope: HealthDisplayScope): HealthRecord[] | null {
  let match: (record: HealthRecord) => boolean;
  switch (scope.kind) {
    case "host":
      match = () => true;
      break;
    case "rig":
    case "pod":
      match = (r) => (r.scope.type === "rig" || r.scope.type === "seat") && r.scope.rigId === scope.rigId;
      break;
    case "seat": {
      const seatId = usableSeatHealthId(scope.nodeId);
      if (seatId === null) return null;
      match = (r) => r.scope.type === "seat" && r.scope.rigId === scope.rigId && r.scope.seatId === seatId;
      break;
    }
  }
  return records.filter(match).sort(compareScopedHealth);
}

export type HealthAdmission =
  | { kind: "local" }
  | { kind: "remote"; hostId: string }
  /** No current, successfully read source (pending, failed or unasserted). */
  | { kind: "unknown" };

/** Admission for a topology page body (already behind TopologySourceGate) or
 *  a standalone seat consumer: the asserted source must equal the CURRENT
 *  successfully read selection. A cached hosts payload after a failed read is
 *  not authority. Only local admits the canonical read. */
export function useHealthAdmission(assertedSource?: string | null): HealthAdmission {
  const known = useKnownSelectedHost();
  if (known === null) return { kind: "unknown" };
  if (assertedSource !== undefined && assertedSource !== known) return { kind: "unknown" };
  return known === LOCAL_HOST_ID ? { kind: "local" } : { kind: "remote", hostId: known };
}

/** The shared bounded canonical read, enabled only for a local admission. */
function useScopedHealthQuery(admission: HealthAdmission) {
  return useCanonicalHealth(LOCAL_OPERATOR_INSTANCE, { limit: SCOPED_HEALTH_LIMIT }, { enabled: admission.kind === "local" });
}

function scopeHeading(scope: HealthDisplayScope): string {
  switch (scope.kind) {
    case "host": return "Connected instance health";
    case "rig": return `Rig ${scope.rigId} health`;
    case "pod": return `Health for the enclosing rig ${scope.rigId}`;
    case "seat": return "Seat health";
  }
}

function scopeExplanation(scope: HealthDisplayScope): string {
  switch (scope.kind) {
    case "host": return "Every finding the connected instance served in this bounded read.";
    case "rig": return "Rig findings and findings for seats in this rig.";
    case "pod": return `Pods have no Health scope, so pod ${scope.podName} shows its enclosing rig's findings (rig and its seats), not a pod-only assessment.`;
    case "seat": return "Findings recorded for this exact seat.";
  }
}

function recordScopeLabel(record: HealthRecord): string {
  const scope = record.scope;
  switch (scope.type) {
    case "instance": return `instance ${scope.instanceId}`;
    case "rig": return `rig ${scope.rigId}`;
    case "seat": return `seat ${scope.seatId} · rig ${scope.rigId}`;
    case "mission": return `mission ${scope.missionId} · project ${scope.projectId}`;
    case "slice": return `slice ${scope.sliceId} · mission ${scope.missionId}`;
  }
}

function conditionLabel(record: HealthRecord): string | null {
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

function partialNotes(data: HealthListProjection): string[] {
  const notes: string[] = [];
  if (data.truncated) notes.push(`The connected instance served ${data.records.length} of ${data.total} findings (limit ${data.limit}); findings for this scope may be omitted.`);
  if (data.coverage === undefined) notes.push("This read reports no source coverage; it is not a complete assessment.");
  for (const c of data.coverage ?? []) {
    if (c.status === "unavailable") notes.push(`${c.source} unavailable — ${c.reason}; not assessed.`);
    else if (c.partial) notes.push(`${c.source}: evaluated ${c.evaluated} of ${c.total} ${c.unit}; omitted items are not evaluated.`);
  }
  return notes;
}

function Counts({ records }: { records: HealthRecord[] }) {
  const active = records.filter((r) => r.status === "active");
  const unknown = records.filter((r) => r.status === "indeterminate").length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {(["critical", "warning", "info"] as const).map((sev) => {
        const n = active.filter((r) => r.severity === sev).length;
        return <Tag key={sev} testId={`scoped-health-count-${sev}`} tone={n === 0 ? "muted" : sev === "critical" ? "bad" : sev === "warning" ? "warn" : "info"}>{sev} {n}</Tag>;
      })}
      <Tag testId="scoped-health-count-unknown" tone={unknown ? "warn" : "muted"}>Unknown {unknown}</Tag>
      <Tag testId="scoped-health-count-cleared" tone="muted" title="The default read omits cleared findings.">Cleared · not in this read</Tag>
    </span>
  );
}

function UnadmittedState({ admission, testId }: { admission: Exclude<HealthAdmission, { kind: "local" }>; testId: string }) {
  if (admission.kind === "unknown") {
    return (
      <p data-testid={`${testId}-source-unknown`} role="status" className="text-xs text-on-surface-variant">
        Health waits for a confirmed current source; nothing was read.
      </p>
    );
  }
  return (
    <div data-testid={`${testId}-remote`} role="status" className="text-xs text-on-surface-variant">
      <p>Health for remote host {admission.hostId} is unavailable: canonical Health is served only by the connected instance and is not forwarded. Nothing was read, and no local findings are shown here.</p>
      <Link to="/settings/health" data-testid={`${testId}-connected-link`} className="mt-1 inline-block underline decoration-dotted hover:text-on-surface">
        Open the connected instance&apos;s Health (this daemon, not {admission.hostId})
      </Link>
    </div>
  );
}

function FindingRow({ record, from, testId }: { record: HealthRecord; from: TopologyScope | null; testId: string }) {
  const router = useRouter();
  const condition = conditionLabel(record);
  return (
    <li>
      <Link
        to="/settings/health"
        search={{ finding: record.id } as never}
        data-list-item=""
        data-testid={`${testId}-row`}
        data-finding-id={record.id}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          prepareTopologyDrill(router, from);
        }}
        className="block px-3 py-2 text-left hover:bg-surface-low/60 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <Tag tone={recordTone(record)}>{record.severity}</Tag>
          {condition ? <Tag tone="warn">{condition}</Tag> : null}
          <span className="font-mono text-[9px] uppercase text-on-surface-variant">{record.category} · {record.detector}</span>
        </span>
        <span className="mt-1 block break-words text-sm text-on-surface [overflow-wrap:anywhere]">{record.summary}</span>
        <span className="mt-0.5 block break-words font-mono text-[10px] text-on-surface-variant [overflow-wrap:anywhere]">
          {recordScopeLabel(record)} · age {formatAgeSeconds(record.freshness.ageSeconds)} · {record.confidence} confidence
        </span>
      </Link>
    </li>
  );
}

/** Full scoped Health: summary + served matching findings (the Health view
 *  for host/rig/pod, and the seat's inline section). */
export function ScopedHealthPanel({ scope, admission, from, testId = "scoped-health" }: {
  scope: HealthDisplayScope;
  admission: HealthAdmission;
  /** The topology scope being left by a finding drill. */
  from: TopologyScope | null;
  testId?: string;
}) {
  const query = useScopedHealthQuery(admission);
  return (
    <section data-testid={testId} data-scope-kind={scope.kind} aria-labelledby={`${testId}-heading`} className="space-y-3">
      <header>
        <h2 id={`${testId}-heading`} className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface">{scopeHeading(scope)}</h2>
        <p data-testid={`${testId}-explanation`} className="mt-0.5 text-xs text-on-surface-variant">{scopeExplanation(scope)}</p>
      </header>
      {admission.kind !== "local" ? (
        <UnadmittedState admission={admission} testId={testId} />
      ) : scope.kind === "seat" && usableSeatHealthId(scope.nodeId) === null ? (
        <p data-testid={`${testId}-identity-unavailable`} role="status" className="text-xs text-on-surface-variant">
          This seat&apos;s stable identity was not served, so its findings cannot be matched. This is not &quot;no findings&quot;.
        </p>
      ) : query.data === undefined ? (
        query.error
          ? <ReadFailure error={query.error} what="Health" onRetry={() => void query.refetch()} testId={`${testId}-error`} />
          : <LoadingBlock label="health" testId={`${testId}-loading`} />
      ) : (
        <ScopedHealthBody data={query.data} query={query} scope={scope} from={from} testId={testId} />
      )}
    </section>
  );
}

function ScopedHealthBody({ data, query, scope, from, testId }: {
  data: HealthListProjection;
  query: ReturnType<typeof useScopedHealthQuery>;
  scope: HealthDisplayScope;
  from: TopologyScope | null;
  testId: string;
}) {
  const records = healthRecordsForScope(data.records, scope) ?? [];
  const notes = partialNotes(data);
  return (
    <>
      <ReadStatusBar query={query} servedAt={data.evaluatedAt} servedLabel="evaluated" testId={`${testId}-read`} what="Health" />
      <div data-testid={`${testId}-summary`} className="flex flex-wrap items-center gap-2">
        <Counts records={records} />
        <span data-testid={`${testId}-matches`} className="font-mono text-[10px] uppercase text-on-surface-variant">
          {records.length} matching of {data.records.length} served
        </span>
        {notes.length ? <Tag testId={`${testId}-partial`} tone="warn">Partial</Tag> : null}
      </div>
      {notes.length ? (
        <ul data-testid={`${testId}-notes`} className="space-y-0.5 text-xs text-warning">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
      {records.length === 0 ? (
        <p data-testid={`${testId}-empty`} className="border border-dashed border-outline-variant px-3 py-3 text-sm text-on-surface-variant">
          No findings served for this scope; this is not a healthy verdict.
        </p>
      ) : (
        <ul aria-label={`${scopeHeading(scope)} findings`} data-testid={`${testId}-list`} onKeyDown={listKeyboardHandler} className="divide-y divide-outline-variant border border-outline-variant">
          {records.map((record) => <FindingRow key={record.id} record={record} from={from} testId={testId} />)}
        </ul>
      )}
    </>
  );
}

/** Compact always-visible scope summary with an entry to the Health view. */
export function ScopedHealthStrip({ scope, admission, onOpen, testId = "scoped-health-strip" }: {
  scope: HealthDisplayScope;
  admission: HealthAdmission;
  onOpen: () => void;
  testId?: string;
}) {
  const query = useScopedHealthQuery(admission);
  let body: ReactNode;
  if (admission.kind === "remote") body = <span data-testid={`${testId}-remote`}>unavailable for remote host {admission.hostId} (not forwarded)</span>;
  else if (admission.kind === "unknown") body = <span data-testid={`${testId}-source-unknown`}>waiting for a confirmed source</span>;
  else if (query.data === undefined) {
    body = query.error
      ? <span data-testid={`${testId}-error`} className="text-tertiary">unavailable — {query.error.message} <button type="button" onClick={() => void query.refetch()} className="underline">Retry</button></span>
      : <span data-testid={`${testId}-loading`}>reading…</span>;
  } else {
    const records = healthRecordsForScope(query.data.records, scope) ?? [];
    const partial = partialNotes(query.data).length > 0;
    body = (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Counts records={records} />
        <span data-testid={`${testId}-matches`}>{records.length} matching served{partial ? " · partial" : ""}</span>
        {query.error ? (
          <span data-testid={`${testId}-stale`} className="text-warning">
            · refresh failed, read <Timestamp iso={new Date(query.dataUpdatedAt).toISOString()} />{" "}
            <button type="button" onClick={() => void query.refetch()} className="underline">Retry</button>
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <div data-testid={testId} className={cn("flex flex-wrap items-center gap-2 pb-2 font-mono text-[10px] text-on-surface-variant")}>
      <span className="uppercase tracking-[0.12em] text-on-surface">{scope.kind === "pod" ? "Enclosing rig health" : "Health"}</span>
      {body}
      <button type="button" data-testid={`${testId}-open`} onClick={onOpen} className="border border-outline-variant px-2 py-0.5 uppercase hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
        Open Health
      </button>
    </div>
  );
}
