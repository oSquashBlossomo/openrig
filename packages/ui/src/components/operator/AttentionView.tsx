// Canonical Attention — human requests and updates composed by the connected
// daemon (/api/attention), with delivered human updates as a separate lens
// (/api/queue/human-updates).
//
// Browsing is passive: opening, copying and refreshing never decide or send
// anything. No approve/dispatch control is synthesized from text; the existing
// Activity feed keeps its own authorized action surfaces.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { LOCAL_OPERATOR_INSTANCE } from "../../lib/operator-read.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import {
  useCanonicalAttention, useCanonicalAttentionDetail, useDeliveredHumanUpdates,
  type AttentionDetail, type AttentionItem, type AttentionRead, type DeliveredHumanUpdate,
} from "../../hooks/useCanonicalAttention.js";
import { FileLink } from "../ui/FileLink.js";
import {
  ChipGroup, CopyButton, DetailSection, Field, Fields, ListDetailLayout, LoadingBlock, ReadFailure, ReadStatusBar,
  SearchInput, Tag, Timestamp, listKeyboardHandler, useUrlSyncedText, type Tone,
} from "./OperatorPrimitives.js";
import {
  attentionRows, deliveredUpdateScope, deliveredUpdateSummary, filterAttentionRows, filterDeliveredUpdates,
  findDeliveredUpdate, humanUpdateId, itemDependsOnSource, splitFileAnchor, type AttentionLens, type AttentionRow, type PriorAttention,
} from "./attention-model.js";
import { classifyAttentionId } from "./operator-search.js";

const DELIVERED_LIMIT = 20;

/** Every file reference on this view is produced by a canonical read of the
 * connected instance (LOCAL_OPERATOR_INSTANCE), so its origin is exactly
 * "local" — retained rows included. Never the current topology selection. */
const EVIDENCE_ORIGIN = LOCAL_HOST_ID;

function urgencyTone(item: AttentionItem): Tone {
  if (item.urgency === "critical" || item.urgency === "urgent") return "bad";
  if (item.urgency === "high" || item.urgency === "warning") return "warn";
  if (item.kind === "update") return "info";
  return "neutral";
}

type AttentionQuery = ReturnType<typeof useCanonicalAttention>;
type UpdatesQuery = ReturnType<typeof useDeliveredHumanUpdates>;
interface SeenUpdate { update: DeliveredHumanUpdate; readAt: number }

export interface AttentionFilters { lens?: Exclude<AttentionLens, "all">; q?: string }

/** Lens and search are controlled when `filters`/`onFilters` are supplied (For
 * You keeps them in the URL for Back/direct links); otherwise local. */
export function AttentionView({ selectedItem, onSelect, filters, onFilters }: {
  selectedItem: string | undefined; onSelect: (id: string | undefined) => void;
  filters?: AttentionFilters; onFilters?: (patch: AttentionFilters) => void;
}) {
  // Two independent reads. Canonical attention and delivered updates gate
  // their own sections: one failing never hides the other's available facts.
  const attention = useCanonicalAttention(LOCAL_OPERATOR_INSTANCE);
  const updates = useDeliveredHumanUpdates(LOCAL_OPERATOR_INSTANCE, DELIVERED_LIMIT);
  const [localLens, setLocalLens] = useState<AttentionLens>("all");
  const lens = onFilters ? filters?.lens ?? "all" : localLens;
  const setLens = (next: AttentionLens) => (onFilters ? onFilters({ lens: next === "all" ? undefined : next }) : setLocalLens(next));
  const writeQuery = useCallback((q: string | undefined) => onFilters?.({ q }), [onFilters]);
  const [query, setQuery] = useUrlSyncedText(onFilters ? filters?.q : undefined, writeQuery);
  const read = attention.scopeSupported === false ? null : attention.data ?? null;

  // Rows from a source that is unavailable now are carried over, labeled.
  const priorRef = useRef<PriorAttention | null>(null);
  const rows = useMemo(() => (read ? attentionRows(read, priorRef.current) : []), [read]);
  useEffect(() => { if (read) priorRef.current = { readAt: read.readAt, rows }; }, [read, rows]);

  // Last row/update seen per ID keeps a selection inspectable after it leaves.
  const seenRows = useRef(new Map<string, { row: AttentionRow; readAt: string }>());
  const seenUpdates = useRef(new Map<string, SeenUpdate>());
  if (read) for (const row of rows) seenRows.current.set(row.item.id, { row, readAt: row.retainedFrom ?? read.readAt });
  for (const update of updates.data?.items ?? []) seenUpdates.current.set(humanUpdateId(update.qitemId), { update, readAt: updates.dataUpdatedAt });

  return (
    <div data-testid="attention-view">
      <div className="mb-3 flex flex-col gap-2">
        <ChipGroup
          label="Show" testId="attention-lens" value={lens} onChange={setLens}
          options={[
            { id: "all", label: "All" },
            { id: "action", label: "Requests", count: read ? rows.filter((r) => r.item.kind === "action").length : undefined },
            { id: "update", label: "Updates", count: read ? rows.filter((r) => r.item.kind === "update").length : undefined },
            { id: "delivered", label: "Delivered", count: updates.data?.items.length },
          ]}
        />
        <SearchInput label="Search attention" testId="attention-search" value={query} onChange={setQuery} placeholder="summary, scope, recipient, id" />
      </div>
      <CanonicalReadState attention={attention} />
      <AttentionSources read={read} attention={attention} updates={updates} />
      <ListDetailLayout
        testId="attention-layout" listLabel="All attention" hasSelection={Boolean(selectedItem)} onClearSelection={() => onSelect(undefined)}
        list={<AttentionList rows={rows} read={read} attention={attention} lens={lens} query={query} updates={updates} selected={selectedItem} onSelect={onSelect} />}
        detail={(
          <AttentionDetailPanel
            id={selectedItem} rows={rows} read={read} listStale={Boolean(attention.error)}
            updates={updates} seenRows={seenRows.current} seenUpdates={seenUpdates.current}
          />
        )}
      />
      <p className="mt-4 border-t border-outline-variant pt-2 text-xs text-on-surface-variant">
        Viewing is not approval. Required Slack decisions still apply. Approve and chat actions remain in{" "}
        <Link to="/for-you" search={{ view: "activity" }} className="underline">Activity</Link>.
      </p>
    </div>
  );
}

/** Canonical read status: loading → failure → dated status bar. Delivered
 * updates are reported separately and stay usable either way. */
function CanonicalReadState({ attention }: { attention: AttentionQuery }) {
  if (attention.scopeSupported === false) {
    return <div className="mb-3"><ReadFailure error={attention.scopeError ?? null} what="Canonical attention" testId="attention-list-unsupported" /></div>;
  }
  if (attention.data === undefined) {
    return (
      <div className="mb-3">
        {attention.error
          ? <ReadFailure error={attention.error} what="Canonical attention" onRetry={() => void attention.refetch()} testId="attention-list-error" />
          : <LoadingBlock label="canonical attention" testId="attention-list-loading" />}
        <p className="mt-1 text-xs text-on-surface-variant">Delivered updates are read separately and remain available below.</p>
      </div>
    );
  }
  return <ReadStatusBar query={attention} servedAt={attention.data.readAt} testId="attention-read" what="Canonical attention" />;
}

function sourceTone(state: string): Tone {
  return state === "available" ? "good" : state === "partial" ? "warn" : state === "loading" ? "muted" : "bad";
}

/** Delivered source state from its own query. A retained cache after a
 * failed refresh is reported as unavailable now, never as available. */
export function deliveredSourceState(updates: Pick<UpdatesQuery, "data" | "error">): "loading" | "available" | "partial" | "unavailable" {
  if (updates.error) return "unavailable";
  if (!updates.data) return "loading";
  return updates.data.truncated ? "partial" : "available";
}

function AttentionSources({ read, attention, updates }: { read: AttentionRead | null; attention: AttentionQuery; updates: UpdatesQuery }) {
  const bad = read ? read.sources.filter((s) => s.state !== "available") : [];
  const deliveredState = deliveredSourceState(updates);
  const canonicalState = read ? (attention.error ? "unavailable" : null) : attention.error || attention.scopeSupported === false ? "unavailable" : "loading";
  const incomplete = bad.length > 0 || deliveredState === "unavailable" || canonicalState === "unavailable";
  const deliveredReadAt = updates.dataUpdatedAt ? new Date(updates.dataUpdatedAt).toISOString() : null;
  return (
    <details data-testid="attention-sources" open={incomplete} className="mb-3 border border-outline-variant px-3 py-2">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em]">
        {incomplete ? (
          <span data-testid="attention-incomplete" className="text-warning">Some sources unavailable or partial — this view is incomplete</span>
        ) : canonicalState === "loading" || deliveredState === "loading" ? (
          <span className="text-on-surface-variant">Sources · reading…</span>
        ) : <span className="text-on-surface-variant">Sources · {(read?.sources.length ?? 0) + 1} reporting</span>}
      </summary>
      <ul className="mt-2 space-y-1 text-xs">
        {canonicalState ? (
          <li data-testid="attention-source-canonical" className="flex flex-wrap items-baseline gap-2">
            <Tag tone={sourceTone(canonicalState)}>{canonicalState}</Tag>
            <span className="font-mono text-on-surface">canonical attention</span>
            <span className="min-w-0 flex-1 break-words text-on-surface-variant [overflow-wrap:anywhere]">
              {canonicalState === "loading" ? "Reading…" : read
                ? <>Refresh failed ({attention.error?.message}); per-source states below are from the read at <Timestamp iso={read.readAt} />.</>
                : attention.error?.message ?? attention.scopeError?.message ?? "Unavailable."}
            </span>
          </li>
        ) : null}
        {(read?.sources ?? []).map((s, i) => (
          <li key={`${s.source}-${i}`} data-testid={`attention-source-${s.source}`} className="flex flex-wrap items-baseline gap-2">
            <Tag tone={sourceTone(s.state)}>{s.state}</Tag>
            <span className="font-mono text-on-surface">{s.source}</span>
            <span className="min-w-0 flex-1 break-words text-on-surface-variant [overflow-wrap:anywhere]">{s.detail}</span>
          </li>
        ))}
        <li data-testid="attention-source-delivered" data-state={deliveredState} className="flex flex-wrap items-baseline gap-2">
          <Tag tone={sourceTone(deliveredState)}>{deliveredState}</Tag>
          <span className="font-mono text-on-surface">delivered updates</span>
          <span className="min-w-0 flex-1 break-words text-on-surface-variant [overflow-wrap:anywhere]">
            {updates.error
              ? <>{updates.error.message}{updates.data ? <> Earlier deliveries from the read at <Timestamp iso={deliveredReadAt} /> are retained and labeled.</> : null}</>
              : updates.data ? `Latest ${updates.data.limit} confirmed deliveries${updates.data.truncated ? "; more omitted" : ""}.` : "Reading…"}
          </span>
        </li>
      </ul>
    </details>
  );
}

function AttentionList({ rows, read, attention, lens, query, updates, selected, onSelect }: {
  rows: AttentionRow[]; read: AttentionRead | null; attention: AttentionQuery; lens: AttentionLens; query: string; updates: UpdatesQuery;
  selected: string | undefined; onSelect: (id: string) => void;
}) {
  const bad = read ? read.sources.filter((s) => s.state !== "available") : [];
  const sections: Array<{ kind: "action" | "update"; title: string }> = [
    { kind: "action", title: "Human requests" },
    { kind: "update", title: "Updates · outcomes & health" },
  ];
  return (
    <div onKeyDown={listKeyboardHandler} className="space-y-4">
      {sections.filter((s) => lens === "all" || lens === s.kind).map(({ kind, title }) => {
        if (!read) {
          return (
            <section key={kind} aria-label={title} data-testid={`attention-section-${kind}`}>
              <h2 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">{title}</h2>
              <p data-testid={`attention-unknown-${kind}`} className="border border-dashed border-outline-variant px-3 py-3 text-xs text-on-surface-variant">
                {attention.error || attention.scopeSupported === false ? "Unknown: canonical attention could not be read. Nothing is inferred." : "Reading canonical attention…"}
              </p>
            </section>
          );
        }
        const all = rows.filter((r) => r.item.kind === kind);
        const items = filterAttentionRows(rows, kind, query);
        const degraded = bad.some((s) => kind === "action" ? s.source === "queue" : s.source !== "queue");
        return (
          <section key={kind} aria-label={title} data-testid={`attention-section-${kind}`}>
            <h2 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">{title} · {items.length}</h2>
            {items.length === 0 ? (
              <p data-testid={`attention-empty-${kind}`} className="border border-dashed border-outline-variant px-3 py-3 text-xs text-on-surface-variant">
                {query && all.length ? "No matches in the served items."
                  : attention.error ? "Unknown now: the last successful read had none, and the latest refresh failed."
                    : degraded ? "Unknown: a required source is unavailable or partial." : "No current items in the available source window."}
              </p>
            ) : (
              <ul className="divide-y divide-outline-variant border border-outline-variant">
                {items.map(({ item, retainedFrom }) => (
                  <li key={item.id}>
                    <RowButton id={item.id} selected={selected === item.id} onSelect={onSelect}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Tag tone={urgencyTone(item)}>{item.urgency}</Tag>
                        {retainedFrom ? <Tag tone="warn" testId={`attention-retained-${item.id}`} title={`Last served ${retainedFrom}`}>Retained · source unavailable</Tag> : null}
                      </span>
                      <span className="mt-1 block break-words text-sm text-on-surface [overflow-wrap:anywhere]">{item.summary}</span>
                      {item.recipient ? <span className="block font-mono text-[10px] text-on-surface-variant">To {item.recipient}</span> : null}
                      {item.unblocks ? <span className="block break-words text-xs text-on-surface-variant [overflow-wrap:anywhere]">Unblocks: {item.unblocks}</span> : null}
                      <span className="block break-words font-mono text-[10px] text-on-surface-variant [overflow-wrap:anywhere]">{item.scope} · <Timestamp iso={item.at} fallback="time unknown" /></span>
                    </RowButton>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {lens === "all" || lens === "delivered" ? <DeliveredSection updates={updates} query={query} selected={selected} onSelect={onSelect} /> : null}
    </div>
  );
}

function RowButton({ id, selected, onSelect, children }: { id: string; selected: boolean; onSelect: (id: string) => void; children: ReactNode }) {
  return (
    <button
      type="button" data-list-item data-testid={`attention-row-${id}`} aria-current={selected ? "true" : undefined} onClick={() => onSelect(id)}
      className={cn("block w-full px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface",
        selected ? "bg-surface-low" : "hover:bg-surface-low/60")}
    >
      {children}
    </button>
  );
}

function DeliveredSection({ updates, query, selected, onSelect }: { updates: UpdatesQuery; query: string; selected: string | undefined; onSelect: (id: string) => void }) {
  const items = filterDeliveredUpdates(updates.data?.items ?? [], query);
  return (
    <section aria-label="Delivered updates" data-testid="attention-section-delivered">
      <h2 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">
        Delivered updates · no action needed{updates.data ? ` · ${items.length}` : ""}
      </h2>
      {!updates.data ? (
        updates.error ? <ReadFailure error={updates.error} what="Delivered updates" onRetry={() => void updates.refetch()} testId="attention-delivered-error" />
          : <p role="status" data-testid="attention-delivered-loading" className="px-3 py-3 font-mono text-[10px] uppercase text-on-surface-variant">Reading delivered updates…</p>
      ) : (
        <>
          <ReadStatusBar query={updates} testId="attention-delivered-read" what="Delivered updates" />
          {items.length === 0 ? (
            <p data-testid="attention-empty-delivered" className="border border-dashed border-outline-variant px-3 py-3 text-xs text-on-surface-variant">
              {query && updates.data.items.length ? "No matches in the delivered window."
                : updates.error ? "None in the last successful read; the latest refresh failed, so current deliveries are unknown."
                  : "No delivered updates in the retained window."}
            </p>
          ) : (
            <ul className="divide-y divide-outline-variant border border-outline-variant">
              {items.map((update) => {
                const id = humanUpdateId(update.qitemId);
                return (
                  <li key={id}>
                    <RowButton id={id} selected={selected === id} onSelect={onSelect}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Tag tone="info">update</Tag><Tag tone="muted">No action needed</Tag>
                        {updates.error ? <Tag tone="warn">Earlier read</Tag> : null}
                      </span>
                      <span className="mt-1 block break-words text-sm text-on-surface [overflow-wrap:anywhere]">{deliveredUpdateSummary(update)}</span>
                      <span className="block break-words font-mono text-[10px] text-on-surface-variant [overflow-wrap:anywhere]">To {update.destinationSession} · from {update.sourceSession}</span>
                      <span className="block font-mono text-[10px] text-on-surface-variant">Delivered <Timestamp iso={update.deliveredAt} /></span>
                    </RowButton>
                  </li>
                );
              })}
            </ul>
          )}
          {updates.data.truncated ? <p data-testid="attention-delivered-truncated" className="mt-1 text-xs text-warning">Showing the latest {updates.data.limit}; older delivered updates are omitted.</p> : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- detail

/** Whether the selected canonical item is in the current list. "absent" is
 * claimed only against a current, successful list whose sources this item
 * depends on are all available; otherwise membership is unknown. */
export type Membership = "listed" | "absent" | "unknown";

export function selectedMembership(item: AttentionItem, rows: AttentionRow[], read: AttentionRead | null, listStale: boolean): Membership {
  if (!read || listStale) return "unknown";
  const row = rows.find((r) => r.item.id === item.id);
  if (row && !row.retainedFrom) return "listed";
  // A retained row, or absence while a source it depends on is unavailable or
  // partial, says nothing about current membership or closure.
  if (row?.retainedFrom) return "unknown";
  const degraded = read.sources.filter((source) => source.state !== "available");
  return degraded.some((source) => itemDependsOnSource(item, source.source)) ? "unknown" : "absent";
}

function AttentionDetailPanel({ id, rows, read, listStale, updates, seenRows, seenUpdates }: {
  id: string | undefined; rows: AttentionRow[]; read: AttentionRead | null; listStale: boolean; updates: UpdatesQuery;
  seenRows: Map<string, { row: AttentionRow; readAt: string }>; seenUpdates: Map<string, SeenUpdate>;
}) {
  const kind = id ? classifyAttentionId(id) : null;
  const canonicalId = id && kind && kind !== "human-update" && kind !== "unrecognized" ? id : null;
  const detail = useCanonicalAttentionDetail(LOCAL_OPERATOR_INSTANCE, canonicalId);
  if (!id) {
    return <p data-testid="attention-detail-empty" className="border border-dashed border-outline-variant px-4 py-6 text-sm text-on-surface-variant">Select a request or update to read its full detail, recipient and source.</p>;
  }
  if (kind === "unrecognized") {
    return (
      <div role="alert" data-testid="attention-detail-unrecognized" className="border border-warning px-4 py-3 text-sm">
        <p className="font-mono text-[11px] uppercase text-warning">Unrecognized attention ID</p>
        <p className="mt-1 break-words [overflow-wrap:anywhere]">“{id}” is not a canonical attention identifier (queue:, proof:, workflow:, health: or human-update:). Nothing was requested.</p>
      </div>
    );
  }
  if (kind === "human-update") {
    // Resolved only from the delivered dataset — never canonical detail.
    const current = findDeliveredUpdate(updates.data, id);
    if (current) return <DeliveredUpdateDetail update={current} updates={updates} retainedAt={null} />;
    const remembered = seenUpdates.get(id);
    if (remembered) return <DeliveredUpdateDetail update={remembered.update} updates={updates} retainedAt={remembered.readAt} />;
    if (!updates.data && !updates.error) return <p role="status" data-testid="attention-detail-update-loading" className="px-4 py-6 font-mono text-[11px] uppercase text-on-surface-variant">Reading delivered updates…</p>;
    return (
      <div role="alert" data-testid="attention-detail-update-missing" className="border border-warning px-4 py-3 text-sm">
        {updates.data ? "Selected delivered update is outside the delivered window that was read." : "Delivered updates could not be read, so this update cannot be shown."} Absence is not resolution.
        {updates.error ? <span className="mt-1 block text-xs text-on-surface-variant">{updates.error.message}</span> : null}
        {updates.error ? <button type="button" onClick={() => void updates.refetch()} className="mt-2 block border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low">Retry</button> : null}
      </div>
    );
  }
  const served: AttentionDetail | null = detail.data?.detail?.item.id === id ? detail.data.detail : null;
  if (!detail.data) {
    if (detail.error) return <ReadFailure error={detail.error} what={`Attention detail ${id}`} onRetry={() => void detail.refetch()} testId="attention-detail-error" />;
    return <p role="status" data-testid="attention-detail-loading" className="px-4 py-6 font-mono text-[11px] uppercase text-on-surface-variant">Reading {id}…</p>;
  }
  const lastSeen = seenRows.get(id);
  return (
    <article data-testid="attention-detail" aria-label={`Attention ${id}`} className="border border-on-surface bg-surface-lowest px-4 py-3">
      <ReadStatusBar query={detail} servedAt={detail.data.readAt} testId="attention-detail-read" what="Attention detail" />
      {!served ? (
        <div role="alert" data-testid="attention-detail-unavailable" className="border border-warning px-3 py-2 text-sm">
          <p>{detail.data.detailError ?? "Selected source unavailable."}</p>
          {lastSeen ? (
            <p className="mt-1 text-xs text-on-surface-variant">
              Last seen in the list at <Timestamp iso={lastSeen.readAt} />: “{lastSeen.row.item.summary}” ({lastSeen.row.item.scope}).
            </p>
          ) : null}
        </div>
      ) : (
        <CanonicalDetail detail={served} membership={selectedMembership(served.item, rows, read, listStale)} />
      )}
    </article>
  );
}

function sourceLink(item: AttentionItem): ReactNode {
  const workflow = /^workflow:(.+)$/.exec(item.id);
  if (workflow) return <Link to="/workflow/instance/$instanceId" params={{ instanceId: workflow[1]! }} search={{}} data-testid="attention-workflow-link" className="underline">Open workflow {workflow[1]} →</Link>;
  const health = /^health:(.+)$/.exec(item.id);
  if (health) return <Link to="/settings/health" search={{ finding: health[1]! }} data-testid="attention-health-link" className="underline">Open health finding →</Link>;
  return null;
}

function CanonicalDetail({ detail, membership }: { detail: AttentionDetail; membership: Membership }) {
  const { item } = detail;
  // Absence from a list that failed to refresh, was never read, or whose
  // relevant source is unavailable/partial is not evidence of closure.
  const absentNow = membership === "absent";
  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone={item.kind === "action" ? "neutral" : "info"}>{item.kind === "action" ? "Human request" : "Update"}</Tag>
          <Tag tone={urgencyTone(item)}>{item.urgency}</Tag>
          {absentNow ? <Tag tone="warn" testId="attention-detail-closed">{item.kind === "action" ? "Closed or outside current window" : "Not in current list"}</Tag> : null}
          {membership === "unknown" ? <Tag tone="muted" testId="attention-detail-list-unknown">List membership unknown</Tag> : null}
        </div>
        <h2 data-testid="attention-detail-summary" className="mt-2 break-words font-headline text-lg font-bold text-on-surface [overflow-wrap:anywhere]">{item.summary}</h2>
        {absentNow ? (
          <p data-testid="attention-detail-retained" className="mt-1 text-xs text-on-surface-variant">
            This source record remains inspectable; it is no longer an item in the current {item.kind === "action" ? "Requests" : "Updates"} list.
          </p>
        ) : null}
      </div>
      <DetailSection title="Routing" testId="attention-detail-routing">
        <Fields>
          <Field label="ID" copy={item.id}><span className="font-mono text-xs">{item.id}</span></Field>
          {item.recipient ? <Field label="To">{item.recipient}</Field> : null}
          {item.unblocks ? <Field label="Unblocks">{item.unblocks}</Field> : null}
          <Field label="Scope">{item.scope}</Field>
          <Field label="Project">{item.project ? <><span className="font-mono text-xs">{item.project.id}</span> · <span className="font-mono text-xs">{item.project.root}</span></> : "unknown"}</Field>
          <Field label="Observed"><Timestamp iso={item.at} /></Field>
          <Field label="Source" copy={item.source}><span className="font-mono text-xs">{item.source}</span></Field>
        </Fields>
        {sourceLink(item) ? <div className="mt-2 font-mono text-[10px] uppercase">{sourceLink(item)}</div> : null}
      </DetailSection>
      <DetailSection title="Source detail" testId="attention-detail-lines">
        <div className="space-y-1.5">
          {detail.lines.map((line, i) => <DetailLine key={i} line={line} />)}
        </div>
      </DetailSection>
      {detail.files.length ? (
        <DetailSection title="Files" testId="attention-detail-files" note="Opens through the allowlisted file viewer; a path outside registered roots reports unavailable. The full path is always copyable.">
          <ul className="space-y-1.5">
            {detail.files.map((file, i) => <AttentionFile key={`${file.path}-${i}`} label={file.label} path={file.path} project={item.project} />)}
          </ul>
        </DetailSection>
      ) : null}
    </div>
  );
}

function DetailLine({ line }: { line: string }) {
  const technical = line.includes("\n") || /^[[{]/.test(line.trim());
  if (technical) return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-surface-low p-2 font-mono text-[11px] text-on-surface [overflow-wrap:anywhere]">{line}</pre>;
  const heading = /:$/.test(line.trim()) && line.length < 80;
  return <p className={cn("whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]", heading ? "pt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant" : "text-on-surface")}>{line}</p>;
}

function AttentionFile({ label, path, project }: { label: string; path: string; project: AttentionItem["project"] }) {
  const { file, anchor } = splitFileAnchor(path);
  const absolute = file.startsWith("/");
  return (
    <li data-testid="attention-file" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-mono text-[10px] uppercase text-on-surface-variant">{label}</span>
      {absolute ? (
        <FileLink
          path={file} absolutePath={file} originInstance={EVIDENCE_ORIGIN} anchor={anchor ?? undefined}
          project={project ? { projectId: project.id, projectRoot: project.root } : undefined}
          testId="attention-file-open" className="min-w-0 break-all text-left font-mono text-xs underline"
        >{file}</FileLink>
      ) : <span className="min-w-0 break-all font-mono text-xs">{file}</span>}
      {anchor ? <span className="font-mono text-[10px] text-on-surface-variant">#{anchor}</span> : null}
      <CopyButton value={path} label="Copy path" />
    </li>
  );
}

function DeliveredUpdateDetail({ update, updates, retainedAt }: { update: DeliveredHumanUpdate; updates: UpdatesQuery; retainedAt: number | null }) {
  const evidence = update.evidenceRef ? splitFileAnchor(update.evidenceRef) : null;
  const retainedIso = retainedAt ? new Date(retainedAt).toISOString() : null;
  return (
    <article data-testid="attention-delivered-detail" aria-label={`Delivered update ${update.qitemId}`} className="space-y-3 border border-on-surface bg-surface-lowest px-4 py-3">
      {retainedAt === null ? (
        // Same read as the list: a failed refresh is visible here too, so a
        // narrow layout showing only this detail never presents it as current.
        <ReadStatusBar query={updates} testId="attention-delivered-detail-read" what="Delivered updates" />
      ) : (
        <div role="note" data-testid="attention-delivered-detail-retained-note" className="border border-warning px-3 py-2 text-xs text-on-surface">
          Not in the latest delivered window that was read. Shown from an earlier read at <Timestamp iso={retainedIso} />; it may have aged out of the window.
          {updates.error ? <span className="mt-1 block text-on-surface-variant">Latest refresh failed: {updates.error.message}</span> : null}
        </div>
      )}
      <div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag tone="info">Delivered update</Tag>
          <Tag tone="muted" testId="attention-delivered-no-action">No action needed</Tag>
          {retainedAt !== null ? <Tag tone="warn" testId="attention-delivered-retained">Outside current window</Tag> : null}
        </div>
        <h2 className="mt-2 break-words font-headline text-lg font-bold text-on-surface [overflow-wrap:anywhere]">{deliveredUpdateSummary(update)}</h2>
      </div>
      <DetailSection title="Message">
        <p data-testid="attention-delivered-body" className="whitespace-pre-wrap break-words text-sm text-on-surface [overflow-wrap:anywhere]">{update.body}</p>
        {update.humanDetail ? (
          <div className="mt-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">Supplemental detail</p>
            <p data-testid="attention-delivered-human-detail" className="whitespace-pre-wrap break-words text-sm text-on-surface [overflow-wrap:anywhere]">{update.humanDetail}</p>
          </div>
        ) : null}
      </DetailSection>
      <DetailSection title="Delivery">
        <Fields>
          <Field label="To">{update.destinationSession}</Field>
          <Field label="From">{update.sourceSession}</Field>
          <Field label="Delivered"><Timestamp iso={update.deliveredAt} /></Field>
          <Field label="Receipt" copy={update.deliveryReceipt} testId="attention-delivered-receipt"><span className="font-mono text-xs">{update.deliveryReceipt}</span></Field>
          <Field label="Queue item" copy={update.qitemId}><span className="font-mono text-xs">{update.qitemId}</span></Field>
          <Field label="Scope">{deliveredUpdateScope(update)}</Field>
          <Field label="Tags">{update.tags?.length ? update.tags.join(", ") : "none"}</Field>
          <Field label="Evidence" copy={update.evidenceRef ?? undefined}>
            {evidence && evidence.file.startsWith("/") ? (
              <FileLink path={evidence.file} absolutePath={evidence.file} originInstance={EVIDENCE_ORIGIN} anchor={evidence.anchor ?? undefined}
                testId="attention-delivered-evidence-open" className="break-all text-left font-mono text-xs underline">{update.evidenceRef}</FileLink>
            ) : <span className="font-mono text-xs">{update.evidenceRef ?? "none recorded"}</span>}
          </Field>
        </Fields>
      </DetailSection>
      <p className="text-xs text-on-surface-variant">A delivery receipt records the message reaching the human channel. It is not acceptance or approval.</p>
    </article>
  );
}
