// Durable Recent queue transitions: instance or exact-rig served window,
// collapsed (last five) or full, with a frozen original detail.
//
// Rows come only from useRecentTransitions' `rows`/`visibleRows` (never a
// retained raw query after a failed refresh). A selected transition is the
// row frozen at selection; refresh or eviction never swaps in another row or
// current queue facts. Current queue state is opened separately.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LOCAL_OPERATOR_INSTANCE, type OperatorInstanceScope, type OperatorReadError } from "../../lib/operator-read.js";
import { useHosts } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import type { RecentScope, RecentTransition } from "../../lib/recent-pulse-contracts.js";
import { useRecentTransitions, useRecentTransitionSelection } from "../../hooks/useRecentTransitions.js";
import { usePulse } from "../../hooks/usePulse.js";
import { cn } from "../../lib/utils.js";
import { ChipGroup, CopyButton, Field, Fields, LoadingBlock, ReadFailure, Tag, Timestamp, listKeyboardHandler } from "../operator/OperatorPrimitives.js";
import { recentPulseHref, retainRecentSelection, retainedRecentSelection, type RecentPulseLocation, type RetainedRecentSelection } from "./recent-pulse-location.js";
import { resolveRig, resolveSeat } from "./recent-pulse-model.js";
import { HistoryLink, NewTag, ReadCompletion, RigPointer, SeatPointer, flashClass, useArrivalFlash } from "./RecentPulseParts.js";

export const RECENT_LIMIT = 20;

export function recentScopeLabel(filter: RecentScope): string {
  return filter.kind === "instance" ? "Instance · connected local instance" : `Rig ${filter.rig} · exact name`;
}

type RecentRead = ReturnType<typeof useRecentTransitions>;

/** Rows with a transition ID served more than once in this window. */
function duplicateIds(rows: readonly RecentTransition[]): Set<number> {
  const seen = new Set<number>(), dup = new Set<number>();
  for (const row of rows) (seen.has(row.transitionId) ? dup : seen).add(row.transitionId);
  return dup;
}

export function RecentTransitionList({ recent, filter, selectedId, onSelect, hrefFor, testId = "recent-list" }: {
  recent: RecentRead; filter: RecentScope; selectedId: number | null;
  onSelect?: (id: number) => void; hrefFor?: (id: number) => string; testId?: string;
}) {
  const flashing = useArrivalFlash(recent.status === "ready" ? recent.rows.map((r) => String(r.transitionId)) : null);
  const duplicates = useMemo(() => duplicateIds(recent.rows), [recent.rows]);
  if (recent.status === "unsupported") return <ReadFailure error={recent.scopeError} what="Recent transitions" testId={`${testId}-unsupported`} />;
  if (recent.status === "error") return <ReadFailure error={recent.error as OperatorReadError | null} what="Recent transitions" onRetry={() => void recent.refetch()} testId={`${testId}-error`} />;
  if (recent.status === "loading") return <LoadingBlock label="recent transitions" testId={`${testId}-loading`} />;
  if (!recent.rows.length) {
    return (
      <p data-testid={`${testId}-empty`} className="border border-dashed border-outline-variant px-3 py-4 text-sm text-on-surface-variant">
        No recorded transitions served for {filter.kind === "instance" ? "this instance's active rigs" : `rig ${filter.rig}`} (a successful, empty window).
      </p>
    );
  }
  const showRig = filter.kind === "instance";
  return (
    <div>
      {duplicates.size ? (
        <p role="note" data-testid={`${testId}-duplicates`} className="mb-2 border-l-2 border-warning pl-2 text-xs text-on-surface-variant">
          Transition ID{duplicates.size > 1 ? "s" : ""} {[...duplicates].map((id) => `#${id}`).join(", ")} served more than once in this window; selection uses the first served row with that ID.
        </p>
      ) : null}
      <ol data-testid={testId} onKeyDown={listKeyboardHandler} className="divide-y divide-outline-variant border border-outline-variant">
        {recent.visibleRows.map((row, index) => {
          const selected = row.transitionId === selectedId;
          const flash = flashing.has(String(row.transitionId));
          const body = (
            <>
              <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px] text-on-surface-variant">
                <Timestamp iso={row.ts} />
                <span>#{row.transitionId}</span>
                <Tag tone={row.change.includes("blocked") ? "warn" : row.change.includes("fail") || row.change.includes("denied") ? "bad" : "neutral"}>{row.change}</Tag>
                {showRig ? <span>rig {row.rig}</span> : null}
                <NewTag active={flash} />
              </span>
              <span className="mt-0.5 block text-sm text-on-surface [overflow-wrap:anywhere]">{row.summary ?? <span className="text-on-surface-variant">no summary recorded</span>}</span>
              <span className="mt-0.5 block font-mono text-[11px] text-on-surface-variant [overflow-wrap:anywhere]">{row.actorSession || "actor unknown"} · {row.targetKind}: {row.target}</span>
            </>
          );
          const className = cn("block w-full px-3 py-2 text-left hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface", selected && "bg-surface-low", flashClass(flash));
          return (
            <li key={`${row.transitionId}:${index}`} data-testid={`${testId}-row`} data-transition-id={row.transitionId} aria-current={selected ? "true" : undefined}>
              {hrefFor ? (
                <HistoryLink href={hrefFor(row.transitionId)} data-list-item className={className}>{body}</HistoryLink>
              ) : (
                <button type="button" data-list-item onClick={() => onSelect?.(row.transitionId)} className={className}>{body}</button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Served-window disclosure: shown vs served, latest-window bound, no total. */
export function RecentWindowFooter({ recent, expanded, testId = "recent-window" }: { recent: RecentRead; expanded: boolean; testId?: string }) {
  if (recent.status !== "ready") return null;
  const served = recent.servedCount ?? 0;
  const shown = recent.visibleRows.length;
  return (
    <p data-testid={testId} className="mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface-variant">
      {expanded ? `All ${served} served` : `Last ${shown} of ${served} served`} · latest window, limit {RECENT_LIMIT}
      {recent.possiblyBounded ? " · window full: older transitions may exist" : " · fewer than the limit served"}
      {" · no total or older pages from this source"}
    </p>
  );
}

/** Frozen original detail. Current queue state is a separate, explicit drill. */
export function RecentTransitionDetail({ scope, record, inWindow, onOpenQitem, onClose }: {
  scope: OperatorInstanceScope; record: RetainedRecentSelection; inWindow: boolean | null;
  onOpenQitem: (qitemId: string) => void; onClose: () => void;
}) {
  const row = record.selection.row;
  const pulse = usePulse(scope);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [row.transitionId]);
  return (
    <section data-testid="recent-detail" aria-labelledby="recent-detail-heading" className="border border-outline-variant bg-surface-lowest p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">Recorded transition · frozen original</p>
      <h2 id="recent-detail-heading" ref={heading} tabIndex={-1} className="mt-1 font-headline text-lg font-bold text-on-surface">Recent event #{row.transitionId}</h2>
      {inWindow === false ? (
        <p role="note" data-testid="recent-detail-outside-window" className="mt-2 border-l-2 border-warning pl-2 text-xs text-on-surface-variant">
          This transition is no longer in the current served window (evicted by newer transitions, or the scope changed). Shown exactly as served when selected.
        </p>
      ) : null}
      <Fields testId="recent-detail-fields">
        <Field label="When"><Timestamp iso={row.ts} testId="recent-detail-when" /></Field>
        <Field label="Raw time" copy={row.ts}><span className="font-mono text-[12px]">{row.ts}</span></Field>
        <Field label="Actor"><SeatPointer session={row.actorSession} resolution={resolveSeat(pulse.current, pulse.status, row.actorSession)} testId="recent-detail-actor" /></Field>
        <Field label="Change"><span data-testid="recent-detail-change">{row.change}</span></Field>
        <Field label="Work summary">{row.summary ?? <span className="text-on-surface-variant">no summary recorded (current summary is not substituted)</span>}</Field>
        <Field label="Target"><span data-testid="recent-detail-target" className="font-mono text-[12px] [overflow-wrap:anywhere]">{row.targetKind}: {row.target}</span></Field>
        <Field label="Rig"><RigPointer rigName={row.rig} resolution={resolveRig(pulse.current, row.rig)} testId="recent-detail-rig" /></Field>
        <Field label="Queue item" copy={row.qitemId}><span className="font-mono text-[12px] [overflow-wrap:anywhere]">{row.qitemId}</span></Field>
        <Field label="Captured"><Timestamp iso={new Date(record.capturedAt).toISOString()} /> <span className="text-[11px] text-on-surface-variant">(browser time this row was selected from {record.capturedFrom})</span></Field>
      </Fields>
      <p className="mt-3 text-xs text-on-surface-variant">This is the recorded change, not an independent check of its outcome.</p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Related">
        <button type="button" data-testid="recent-detail-open-qitem" onClick={() => onOpenQitem(row.qitemId)} className="border border-on-surface px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface">
          Current queue item {row.qitemId}
        </button>
        {row.targetKind === "qitem" && row.target !== row.qitemId ? (
          <button type="button" data-testid="recent-detail-open-target" onClick={() => onOpenQitem(row.target)} className="border border-outline-variant px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] hover:bg-surface-low">
            Target queue item {row.target}
          </button>
        ) : null}
        <CopyButton value={`rig queue show ${row.qitemId} --full`} label="Copy CLI" />
        <button type="button" data-testid="recent-detail-close" onClick={onClose} className="border border-outline-variant px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface-variant hover:bg-surface-low">
          Close
        </button>
      </div>
      {row.targetKind !== "qitem" ? (
        <p data-testid="recent-detail-target-pointer" className="mt-2 text-xs text-on-surface-variant">
          The {row.targetKind} target is shown as recorded. Opening it needs its exact project; it is not inferred from the name.
        </p>
      ) : null}
    </section>
  );
}

/** Resolve the URL's selected transition to a frozen original, if any. */
function useSelectedRecord(scope: OperatorInstanceScope, recent: RecentRead, transitionId: number | null, capturedFrom: string) {
  const selection = useRecentTransitionSelection(scope);
  const selected = selection.selected;
  // Freeze from the served window once the selected ID is served.
  useEffect(() => {
    if (transitionId === null || recent.status !== "ready") return;
    if (selected?.row.transitionId === transitionId || retainedRecentSelection(scope, transitionId)) return;
    if (recent.rows.some((r) => r.transitionId === transitionId)) selection.select(recent.rows, transitionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionId, recent.status, recent.rows]);
  const [record, setRecord] = useState<RetainedRecentSelection | null>(null);
  useEffect(() => {
    if (transitionId === null) { setRecord(null); return; }
    if (selected && selected.row.transitionId === transitionId) setRecord(retainRecentSelection(selected, capturedFrom));
    else setRecord(retainedRecentSelection(scope, transitionId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionId, selected]);
  return { record, select: selection.select, clear: selection.clear };
}

export function useRecentView({ scope, location, go, active = true }: {
  scope: OperatorInstanceScope; location: RecentPulseLocation; go: (next: Partial<RecentPulseLocation>, options?: { replace?: boolean }) => void; active?: boolean;
}) {
  const filter: RecentScope = location.rig === null ? { kind: "instance" } : { kind: "rig", rig: location.rig };
  const expanded = location.window === "full";
  const recent = useRecentTransitions(scope, filter, { limit: RECENT_LIMIT, expanded, enabled: active });
  const { record, select, clear } = useSelectedRecord(scope, recent, location.transition, recentScopeLabel(filter));
  const [rigDraft, setRigDraft] = useState(location.rig ?? "");
  useEffect(() => setRigDraft(location.rig ?? ""), [location.rig]);
  const applyRig = (event: FormEvent) => {
    event.preventDefault();
    const rig = rigDraft.trim() ? rigDraft : null;
    go({ rig, transition: location.transition, qitem: null }, { replace: true });
  };
  const inWindow = record && recent.status === "ready" ? recent.rows.some((r) => r.transitionId === record.selection.row.transitionId) : null;
  return {
    filter,
    recent,
    hasDetail: location.transition !== null,
    list: (
      <div data-testid="recent-view">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <button
            type="button"
            data-testid="recent-scope-instance"
            aria-pressed={filter.kind === "instance"}
            onClick={() => go({ rig: null, transition: location.transition, qitem: null }, { replace: true })}
            className={cn("border px-2 py-0.5 font-mono text-[10px] uppercase", filter.kind === "instance" ? "border-on-surface bg-inverse-surface text-background" : "border-outline-variant hover:bg-surface-low")}
          >
            Whole instance
          </button>
          <form onSubmit={applyRig} className="flex items-center gap-1" aria-label="Exact rig name">
            <label className="flex items-center gap-1 border border-outline-variant bg-surface-lowest px-2 py-0.5">
              <span className="font-mono text-[9px] uppercase text-on-surface-variant">Rig name</span>
              <input data-testid="recent-rig-input" value={rigDraft} maxLength={512} onChange={(e) => setRigDraft(e.target.value)} placeholder="exact rig name" className="w-40 min-w-0 bg-transparent text-sm text-on-surface outline-none" />
            </label>
            <button type="submit" data-testid="recent-rig-apply" className="border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low">Apply</button>
          </form>
          <ChipGroup
            label="Window"
            value={location.window}
            options={[{ id: "collapsed", label: "Last 5" }, { id: "full", label: "All served" }]}
            onChange={(window) => go({ window }, { replace: true })}
            testId="recent-window-mode"
          />
        </div>
        <p data-testid="recent-scope-label" className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface">{recentScopeLabel(filter)}</p>
        <ReadCompletion at={recent.status === "ready" ? recent.dataUpdatedAt : null} fetching={recent.isFetching} testId="recent-read" />
        <div className="mt-2">
          <RecentTransitionList
            recent={recent}
            filter={filter}
            selectedId={location.transition}
            onSelect={(id) => { select(recent.rows, id); go({ transition: id, qitem: null }); }}
          />
          <RecentWindowFooter recent={recent} expanded={expanded} />
        </div>
      </div>
    ),
    detail: location.qitem !== null ? null : location.transition === null ? null : record ? (
      <RecentTransitionDetail
        scope={scope}
        record={record}
        inWindow={inWindow}
        onOpenQitem={(qitem) => go({ qitem })}
        onClose={() => { clear(); go({ transition: null, qitem: null }); }}
      />
    ) : (
      <section data-testid="recent-detail-unavailable" role="note" className="border border-warning bg-surface-lowest p-4 text-sm">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-warning">Transition #{location.transition}</p>
        {recent.status === "ready" ? (
          <p className="mt-1 text-on-surface">
            Not in the current served window, and its original row was not retained in this browser session (for example after a reload).
            Recent has no per-transition read, so the original cannot be re-read; it is not replaced by another row.
          </p>
        ) : (
          <p className="mt-1 text-on-surface">Waiting for the served window before resolving this transition.</p>
        )}
        <button type="button" onClick={() => go({ transition: null })} className="mt-2 border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low">Close</button>
      </section>
    ),
  };
}

/** Explicit authority for a topology-hosted panel: null until the host
 * selection has been read; local → the connected instance; a remote
 * selection → that remote-instance (rendered unsupported, never local data). */
export function useTopologyRecentInstance(): OperatorInstanceScope | null {
  const { data } = useHosts();
  if (!data) return null;
  return data.selected === LOCAL_HOST_ID ? LOCAL_OPERATOR_INSTANCE : { kind: "remote-instance", hostId: data.selected };
}

/**
 * ScopePages entry for host (instance) and rig scope. Explicit connected-
 * instance authority: `instance` null = selection still resolving (no read);
 * a remote-instance renders the unsupported state (no local fallback, no
 * remote label on local data); `filter` "pending" = rig name not yet known,
 * "unavailable" = the rig's name was not served (no name is guessed).
 */
export function RecentScopePanel({ instance, filter, testId = "recent-scope-panel" }: {
  instance: OperatorInstanceScope | null; filter: RecentScope | "pending" | "unavailable"; testId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const ready = instance !== null && typeof filter !== "string";
  const recent = useRecentTransitions(instance ?? LOCAL_OPERATOR_INSTANCE, typeof filter === "string" ? { kind: "instance" } : filter, { limit: RECENT_LIMIT, expanded, enabled: ready });
  const rig = typeof filter !== "string" && filter.kind === "rig" ? filter.rig : null;
  return (
    <section data-testid={testId} aria-labelledby={`${testId}-heading`} className="border-t border-outline-variant px-6 py-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${testId}-heading`} className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">Recent transitions</h2>
        {ready && instance.kind === "local-instance" ? (
          <span className="flex gap-3 font-mono text-[10px] uppercase tracking-[0.08em]">
            <HistoryLink href={recentPulseHref({ view: "recent", rig })} data-testid={`${testId}-open`} className="underline decoration-dotted hover:text-secondary">Open Recent</HistoryLink>
            {rig === null ? <HistoryLink href={recentPulseHref({ view: "pulse" })} data-testid={`${testId}-pulse`} className="underline decoration-dotted hover:text-secondary">Open Pulse</HistoryLink> : null}
          </span>
        ) : null}
      </div>
      {instance === null ? (
        <p data-testid={`${testId}-resolving`} className="font-mono text-[10px] uppercase text-on-surface-variant">Resolving selected host… (no queue read yet)</p>
      ) : filter === "pending" ? (
        <p data-testid={`${testId}-rig-pending`} className="font-mono text-[10px] uppercase text-on-surface-variant">Resolving rig name… (Recent filters by exact rig name)</p>
      ) : filter === "unavailable" ? (
        <p data-testid={`${testId}-rig-unavailable`} className="text-xs text-on-surface-variant">This rig&apos;s name was not served, and Recent filters by exact rig name, so no rig window is shown. The instance window is on the host page.</p>
      ) : (
        <>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-on-surface-variant">{recentScopeLabel(filter)}</p>
          <RecentTransitionList
            recent={recent}
            filter={filter}
            selectedId={null}
            hrefFor={(id) => recentPulseHref({ view: "recent", rig, transition: id })}
            testId={`${testId}-list`}
          />
          {recent.status === "ready" && recent.rows.length > 5 ? (
            <button type="button" data-testid={`${testId}-expand`} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="mt-2 border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low">
              {expanded ? "Show last 5" : `Show all ${recent.servedCount} served`}
            </button>
          ) : null}
          <RecentWindowFooter recent={recent} expanded={expanded} testId={`${testId}-window`} />
        </>
      )}
    </section>
  );
}
