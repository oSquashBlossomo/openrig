// Maintained stream: persisted chronology from /api/stream/list through the
// reviewed useMaintainedStream hook. Not the live event feed and not a FIFO.
//
// Direction "latest" is the newest window (served oldest→newest); it has no
// older-page API. "Chronological" pages forward by the exact last served
// streamSortKey. Filters are exact and validated by the daemon. No total or
// older-page control is invented.

import { useEffect, useState, type FormEvent } from "react";
import type { OperatorInstanceScope, OperatorReadError } from "../../lib/operator-read.js";
import type { MaintainedStreamItem, StreamFilter } from "../../lib/recent-pulse-contracts.js";
import { useMaintainedStream } from "../../hooks/useRecentTransitions.js";
import { cn } from "../../lib/utils.js";
import { ChipGroup, Field, Fields, LoadingBlock, ReadFailure, Tag, TechnicalDetails, Timestamp, listKeyboardHandler } from "../operator/OperatorPrimitives.js";
import { STREAM_LIMITS, type RecentPulseLocation, type StreamLocation } from "./recent-pulse-location.js";
import { NewTag, ReadCompletion, flashClass, useArrivalFlash } from "./RecentPulseParts.js";

export function streamFilterOf(s: StreamLocation): StreamFilter {
  return {
    direction: s.direction,
    limit: s.limit,
    ...(s.after !== null ? { afterSortKey: s.after } : {}),
    ...(s.source !== null ? { sourceSession: s.source } : {}),
    ...(s.dest !== null ? { hintDestination: s.dest } : {}),
    ...(s.tag !== null ? { hintTag: s.tag } : {}),
    ...(s.since !== null ? { since: s.since } : {}),
    ...(s.until !== null ? { until: s.until } : {}),
    ...(s.archived ? { includeArchived: true } : {}),
  };
}

type Go = (next: Partial<RecentPulseLocation>, options?: { replace?: boolean }) => void;
const FILTER_FIELDS = [
  { key: "source", label: "Source session", placeholder: "exact session" },
  { key: "dest", label: "Hint destination", placeholder: "exact destination" },
  { key: "tag", label: "Hint tag", placeholder: "exact tag" },
  { key: "since", label: "Since (ISO)", placeholder: "2026-10-04T00:00:00Z" },
  { key: "until", label: "Until (ISO)", placeholder: "2026-10-04T23:59:59Z" },
] as const;

function StreamFilters({ stream, go }: { stream: StreamLocation; go: Go }) {
  const [draft, setDraft] = useState(stream);
  useEffect(() => setDraft(stream), [stream]);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    const clean = (v: string | null) => (v !== null && v.trim() ? v : null);
    // A filter change restarts paging: the cursor belongs to the old filter set.
    go({ item: null, stream: { ...draft, source: clean(draft.source), dest: clean(draft.dest), tag: clean(draft.tag), since: clean(draft.since), until: clean(draft.until), after: null } }, { replace: true });
  };
  return (
    <form data-testid="stream-filters" onSubmit={apply} className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Stream filters">
      {FILTER_FIELDS.map((field) => (
        <label key={field.key} className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-on-surface-variant">{field.label}</span>
          <input
            data-testid={`stream-filter-${field.key}`}
            value={draft[field.key] ?? ""}
            maxLength={512}
            placeholder={field.placeholder}
            onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
            className="min-w-0 border border-outline-variant bg-surface-lowest px-2 py-1 text-sm text-on-surface outline-none focus:border-on-surface"
          />
        </label>
      ))}
      <label className="flex items-center gap-2 self-end text-sm text-on-surface">
        <input type="checkbox" data-testid="stream-filter-archived" checked={draft.archived} onChange={(e) => setDraft({ ...draft, archived: e.target.checked })} />
        Include archived
      </label>
      <div className="flex items-end gap-2">
        <button type="submit" data-testid="stream-filter-apply" className="border border-on-surface px-2 py-1 font-mono text-[10px] uppercase hover:bg-surface-low">Apply filters</button>
        <button type="button" data-testid="stream-filter-clear" onClick={() => go({ item: null, stream: { direction: stream.direction, limit: stream.limit, after: null, source: null, dest: null, tag: null, since: null, until: null, archived: false } }, { replace: true })} className="border border-outline-variant px-2 py-1 font-mono text-[10px] uppercase hover:bg-surface-low">Clear</button>
      </div>
    </form>
  );
}

export function useStreamView({ scope, location, go, active = true }: { scope: OperatorInstanceScope; location: RecentPulseLocation; go: Go; active?: boolean }) {
  const s = location.stream;
  const stream = useMaintainedStream(scope, streamFilterOf(s), { enabled: active });
  const page = stream.current;
  const flashing = useArrivalFlash(page ? page.rows.map((r) => r.streamItemId) : null);
  const selected = location.item !== null ? page?.rows.find((r) => r.streamItemId === location.item) ?? null : null;
  const list = (
    <div data-testid="stream-view">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <ChipGroup
          label="Direction"
          value={s.direction}
          options={[{ id: "latest", label: "Newest window" }, { id: "chronological", label: "Chronological" }]}
          onChange={(direction) => go({ item: null, stream: { ...s, direction, after: null } }, { replace: true })}
          testId="stream-direction"
        />
        <label className="flex items-center gap-1 font-mono text-[9px] uppercase text-on-surface-variant">
          Limit
          <select data-testid="stream-limit" value={s.limit} onChange={(e) => go({ item: null, stream: { ...s, limit: Number(e.target.value), after: null } }, { replace: true })} className="border border-outline-variant bg-surface-lowest px-1 py-0.5 text-sm text-on-surface">
            {(STREAM_LIMITS as readonly number[]).includes(s.limit) ? null : <option value={s.limit}>{s.limit}</option>}
            {STREAM_LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <StreamFilters stream={s} go={go} />
      <p data-testid="stream-scope" className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface">
        Persisted maintained stream · connected local instance · {s.direction === "latest" ? `newest ${s.limit}, shown oldest→newest` : s.after ? `after sort key ${s.after}` : "from the oldest item"}{s.archived ? " · including archived" : " · active items only"}
      </p>
      {!stream.scopeSupported ? <ReadFailure error={stream.scopeError} what="Maintained stream" testId="stream-unsupported" />
        : stream.isError ? <ReadFailure error={stream.error as OperatorReadError | null} what="Maintained stream" onRetry={() => void stream.refetch()} testId="stream-error" />
        : !page ? <LoadingBlock label="maintained stream" testId="stream-loading" />
        : (
          <>
            <ReadCompletion at={stream.dataUpdatedAt} fetching={stream.isFetching} testId="stream-read" />
            {page.rows.length ? (
              <ol data-testid="stream-list" onKeyDown={listKeyboardHandler} className="mt-2 divide-y divide-outline-variant border border-outline-variant">
                {page.rows.map((row, index) => (
                  <StreamRow key={`${row.streamSortKey}:${index}`} row={row} selected={row.streamItemId === location.item} flash={flashing.has(row.streamItemId)} onSelect={() => go({ item: row.streamItemId })} />
                ))}
              </ol>
            ) : (
              <p data-testid="stream-empty" className="mt-2 border border-dashed border-outline-variant px-3 py-4 text-sm text-on-surface-variant">
                No stream items served for these filters{s.after ? " after this cursor" : ""} (a successful, empty page).
              </p>
            )}
            <p data-testid="stream-window" className="mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface-variant">
              {page.rows.length} served · limit {page.limit} · {page.possiblyBounded ? "page full: more may exist" : "fewer than the limit served"} · no total from this source
              {s.direction === "latest" ? " · older pages are not available for the newest window; use Chronological with since/until" : ""}
            </p>
            {s.direction === "chronological" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" data-testid="stream-first" disabled={s.after === null} onClick={() => go({ item: null, stream: { ...s, after: null } })} className="border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase enabled:hover:bg-surface-low disabled:opacity-50">
                  From the oldest
                </button>
                <button
                  type="button"
                  data-testid="stream-next"
                  disabled={!page.nextSortKey || !page.possiblyBounded}
                  onClick={() => page.nextSortKey && go({ item: null, stream: { ...s, after: page.nextSortKey } })}
                  className="border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase enabled:hover:bg-surface-low disabled:opacity-50"
                  title={page.nextSortKey ? `Items after sort key ${page.nextSortKey}` : undefined}
                >
                  Next {s.limit} after {page.nextSortKey ? "this page" : "—"}
                </button>
                <span className="font-mono text-[10px] text-on-surface-variant">Back returns to the previous page.</span>
              </div>
            ) : null}
          </>
        )}
    </div>
  );
  const detail = location.item === null ? null : selected ? <StreamItemDetail item={selected} /> : (
    <section data-testid="stream-item-outside-page" role="note" className="border border-warning bg-surface-lowest p-4 text-sm text-on-surface">
      Stream item <span className="font-mono">{location.item}</span> is not in the current served page{page ? "" : " (page not read yet)"}. It is not replaced by another item; adjust filters or the cursor to reach it.
    </section>
  );
  return { list, detail, hasDetail: location.item !== null };
}

function StreamRow({ row, selected, flash, onSelect }: { row: MaintainedStreamItem; selected: boolean; flash: boolean; onSelect: () => void }) {
  const head = row.body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "(empty body)";
  return (
    <li data-testid="stream-row" data-stream-item-id={row.streamItemId} aria-current={selected ? "true" : undefined}>
      <button type="button" data-list-item onClick={onSelect} className={cn("block w-full px-3 py-2 text-left hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface", selected && "bg-surface-low", flashClass(flash))}>
        <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-on-surface-variant">
          <Timestamp iso={row.tsEmitted} />
          <span className="[overflow-wrap:anywhere]">{row.sourceSession}</span>
          {row.hintType ? <Tag tone="info">{row.hintType}</Tag> : null}
          {row.hintUrgency ? <Tag tone="warn">{row.hintUrgency}</Tag> : null}
          {row.interrupt ? <Tag tone="bad">interrupt</Tag> : null}
          {row.archivedAt ? <Tag tone="muted">archived</Tag> : null}
          <NewTag active={flash} />
        </span>
        <span className="mt-0.5 block text-sm text-on-surface [overflow-wrap:anywhere]">{head}</span>
      </button>
    </li>
  );
}

function StreamItemDetail({ item }: { item: MaintainedStreamItem }) {
  return (
    <section data-testid="stream-item-detail" aria-labelledby="stream-item-heading" className="border border-outline-variant bg-surface-lowest p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">Maintained stream item · as served in this page</p>
      <h2 id="stream-item-heading" tabIndex={-1} className="mt-1 break-words font-mono text-sm font-bold text-on-surface [overflow-wrap:anywhere]">{item.streamItemId}</h2>
      <Fields>
        <Field label="Emitted"><Timestamp iso={item.tsEmitted} /></Field>
        <Field label="Raw time" copy={item.tsEmitted}><span className="font-mono text-[12px]">{item.tsEmitted}</span></Field>
        <Field label="Source">{item.sourceSession}</Field>
        <Field label="Sort key" copy={item.streamSortKey}><span className="font-mono text-[12px] [overflow-wrap:anywhere]">{item.streamSortKey}</span></Field>
        <Field label="Format">{item.format}</Field>
        <Field label="Hints">{[item.hintType, item.hintUrgency, item.hintDestination].filter(Boolean).join(" · ") || "—"}{item.hintTags?.length ? ` · tags ${item.hintTags.join(", ")}` : ""}</Field>
        <Field label="Archived"><Timestamp iso={item.archivedAt} fallback="active" /></Field>
      </Fields>
      <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-surface-low p-2 font-mono text-[12px] text-on-surface [overflow-wrap:anywhere]">{item.body}</pre>
      <TechnicalDetails value={item} />
    </section>
  );
}
