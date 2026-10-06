// Pulse: instance-wide cross-section from the reviewed usePulse model.
//
// Lanes and footer counts come from the SAME model windows, so they change
// together. A null window is an unavailable source (never zero); a served
// empty window is zero. Totals are shown only where the model knows them.
// Times: row ages derive from served timestamps; the cohort's read time is
// this browser's read completion, not instance activity.

import { useMemo, type ReactNode } from "react";
import type { OperatorInstanceScope, OperatorReadError } from "../../lib/operator-read.js";
import type { PulseBlockedItem, PulseNowRow, PulseQueueItem, PulseRead, PulseWindow } from "../../lib/recent-pulse-contracts.js";
import { MAX_PULSE_BLOCKERS, MAX_PULSE_RIGS, MAX_PULSE_SEATS } from "../../lib/recent-pulse-contracts.js";
import { usePulse } from "../../hooks/usePulse.js";
import { cn } from "../../lib/utils.js";
import { ReadFailure, Tag, Timestamp, listKeyboardHandler } from "../operator/OperatorPrimitives.js";
import { LANES, ageSince, claimAgeText, laneCountText, laneUnknownReason, qitemSubject, resolveSeat, type LaneId } from "./recent-pulse-model.js";
import { NewTag, ReadCompletion, SeatPointer, flashClass, useArrivalFlash } from "./RecentPulseParts.js";

type PulseHook = ReturnType<typeof usePulse>;

const SOURCE_LABEL: Record<string, string> = {
  attention: "attention window", blocked: "blocked window", inProgress: "in-progress window",
  pending: "pending window", finished: "finished candidate window", inventory: "rig inventory",
};

function laneKey(id: LaneId, row: unknown): string {
  if (id === "now") { const seat = row as PulseNowRow; return `${seat.rigId}\u0000${seat.session}`; }
  return (row as PulseQueueItem).qitemId;
}

function rowButtonClass(active: boolean, flash: boolean) {
  return cn("block w-full px-3 py-2 text-left hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface", active && "bg-surface-low", flashClass(flash));
}

export function PulseView({ scope, selectedQitem, onOpenQitem, compact }: {
  scope: OperatorInstanceScope; selectedQitem: string | null; onOpenQitem: (qitemId: string) => void; compact: boolean;
}) {
  const pulse = usePulse(scope);
  const now = pulse.current?.readAt ?? Date.now();
  if (pulse.status === "unsupported") return <ReadFailure error={pulse.scopeError} what="Pulse" testId="pulse-unsupported" />;
  if (pulse.status === "loading" && !pulse.current) {
    return (
      <div role="status" aria-live="polite" data-testid="pulse-loading" className="border border-dashed border-outline-variant px-4 py-6 font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface-variant">
        <span className="motion-safe:animate-pulse">Reading Pulse from the connected instance…</span>
        <span className="mt-1 block normal-case tracking-normal">
          Up to four bounded phases (queue windows, rig summary, node inventory, blocker lookups), each read limited to 5 seconds, so a full read can take roughly 20 seconds. Nothing is assumed meanwhile.
        </span>
      </div>
    );
  }
  if (!pulse.current || !pulse.model) {
    return (
      <div data-testid="pulse-error">
        {pulse.current ? (
          <div role="alert" data-testid="pulse-no-usable-lane" className="border border-tertiary bg-surface-lowest px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-tertiary">Pulse unavailable</p>
            <p className="mt-1 text-sm text-on-surface">Every queue window failed and no usable seat evidence was read, so no lane can be shown. Nothing here means zero.</p>
            <button type="button" onClick={() => void pulse.refetch()} className="mt-2 border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low">Retry</button>
          </div>
        ) : <ReadFailure error={pulse.error as OperatorReadError | null} what="Pulse" onRetry={() => void pulse.refetch()} testId="pulse-error-read" />}
        {pulse.current ? <SourceDisclosure pulse={pulse} read={pulse.current} /> : null}
      </div>
    );
  }
  const read = pulse.current;
  const model = pulse.model;
  return (
    <div data-testid="pulse-view" data-status={pulse.status}>
      <ReadCompletion at={read.readAt} fetching={pulse.isFetching} label="Pulse read completed" testId="pulse-read">
        <span data-testid="pulse-status">{pulse.status === "partial" ? "Partial: some sources unavailable or capped" : "All sources read"}</span>
      </ReadCompletion>
      <div className={cn("mt-3 grid gap-3", compact ? "grid-cols-1" : "md:grid-cols-2 xl:grid-cols-3")}>
        {LANES.map((lane) => (
          <Lane key={lane.id} id={lane.id} title={lane.title} reason={lane.reason} sources={lane.sources} read={read} window={model[lane.id] as PulseWindow<unknown> | null}>
            {(rows, flashing) => rows.map((row) => {
              const key = laneKey(lane.id, row);
              const flash = flashing.has(key);
              if (lane.id === "now") return <NowRow key={key} row={row as PulseNowRow} read={read} status={pulse.status} flash={flash} selectedQitem={selectedQitem} onOpenQitem={onOpenQitem} now={now} />;
              const item = row as PulseQueueItem;
              return (
                <li key={key} data-testid={`pulse-${lane.id}-row`} data-qitem-id={item.qitemId}>
                  <button type="button" data-list-item aria-current={selectedQitem === item.qitemId ? "true" : undefined} onClick={() => onOpenQitem(item.qitemId)} className={rowButtonClass(selectedQitem === item.qitemId, flash)}>
                    <span className="block text-sm text-on-surface [overflow-wrap:anywhere]">{qitemSubject(item)}<NewTag active={flash} /></span>
                    <QueueRowMeta lane={lane.id} item={item} read={read} now={now} />
                  </button>
                </li>
              );
            })}
          </Lane>
        ))}
      </div>
      <PulseFooter model={model} read={read} />
      <SourceDisclosure pulse={pulse} read={read} />
    </div>
  );
}

function Lane({ id, title, reason, sources, read, window, children }: {
  id: LaneId; title: string; reason: string; sources: readonly string[]; read: PulseRead; window: PulseWindow<unknown> | null;
  children: (rows: unknown[], flashing: ReadonlySet<string>) => ReactNode;
}) {
  const keys = useMemo(() => window ? window.rows.map((row) => laneKey(id, row)) : null, [id, window]);
  const flashing = useArrivalFlash(keys);
  const failed = sources.filter((s) => s === "inventory" ? read.inventory.state === "unavailable" : read.sources[s as keyof PulseRead["sources"]]?.state === "unavailable");
  const unknown = laneUnknownReason(id, read);
  return (
    <section data-testid={`pulse-lane-${id}`} aria-labelledby={`pulse-lane-${id}-heading`} className="min-w-0 border border-outline-variant bg-surface-lowest">
      <header className="flex items-baseline justify-between gap-2 border-b border-outline-variant px-3 py-2">
        <h3 id={`pulse-lane-${id}-heading`} className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">{title}</h3>
        <span data-testid={`pulse-lane-${id}-count`} className="font-mono text-[11px] text-on-surface">{window ? laneCountText(window) : "unavailable"}</span>
      </header>
      {!window ? (
        <div data-testid={`pulse-lane-${id}-unavailable`} role="note" className="px-3 py-3 text-xs text-on-surface">
          <p className="font-mono text-[10px] uppercase text-tertiary">Unavailable — not zero</p>
          {failed.map((s) => {
            const error = s === "inventory" ? (read.inventory.state === "unavailable" ? read.inventory.error : null) : read.sources[s as keyof PulseRead["sources"]].error;
            return <p key={s} className="mt-1 break-words">{SOURCE_LABEL[s]}: {error?.message ?? "not read"}</p>;
          })}
        </div>
      ) : (
        <>
          {window.rows.length ? (
            <ul onKeyDown={listKeyboardHandler} className="divide-y divide-outline-variant">{children(window.rows, flashing)}</ul>
          ) : (
            <p data-testid={`pulse-lane-${id}-empty`} className="px-3 py-3 text-xs text-on-surface-variant">
              {window.totalCount === 0 ? "None (0)." : "None among the served evidence; total unknown."}
            </p>
          )}
          <p data-testid={`pulse-lane-${id}-window`} className="border-t border-outline-variant px-3 py-1.5 font-mono text-[10px] text-on-surface-variant">
            Showing {window.visibleCount} of {window.servedCount} served{window.servedCount > window.visibleCount ? ` · ${window.servedCount - window.visibleCount} more served, not shown` : ""}
            {unknown ? <span className="block">{unknown}</span> : null}
          </p>
        </>
      )}
      <p className="px-3 pb-2 pt-1 text-[11px] text-on-surface-variant">{reason}</p>
    </section>
  );
}

function QueueRowMeta({ lane, item, read, now }: { lane: LaneId; item: PulseQueueItem; read: PulseRead; now: number }) {
  if (lane === "blocked") {
    const blocked = item as PulseBlockedItem;
    const pointer = blocked.blockedOn;
    const lookupError = pointer ? read.blockerErrors[pointer] : undefined;
    const omitted = pointer ? read.omittedBlockerIds.includes(pointer) : false;
    return (
      <span className="mt-0.5 block font-mono text-[11px] text-on-surface-variant [overflow-wrap:anywhere]">
        blocked on <span data-testid="pulse-blocked-pointer" className="text-on-surface">{pointer ?? "no pointer recorded"}</span>
        {" · "}
        <span data-testid="pulse-blocked-owner">
          {blocked.blockerSession ? <>owner {blocked.blockerSession}</>
            : lookupError ? <>owner lookup failed: {lookupError}</>
            : omitted ? <>owner not looked up (cap {MAX_PULSE_BLOCKERS} lookups)</>
            : pointer?.startsWith("qitem-") ? <>owner unresolved</>
            : <>not a queue item; no owner inferred</>}
        </span>
        {" · "}to {item.destinationSession}
      </span>
    );
  }
  if (lane === "parked") {
    const seat = read.seats.find((s) => s.session === item.destinationSession);
    return (
      <span className="mt-0.5 block font-mono text-[11px] text-on-surface-variant [overflow-wrap:anywhere]">
        {item.destinationSession} · terminal inactive · idle {ageSince(seat?.lastActivityAt, now)} · {claimAgeText(item, now)}
      </span>
    );
  }
  if (lane === "finished") {
    return (
      <span className="mt-0.5 block font-mono text-[11px] text-on-surface-variant [overflow-wrap:anywhere]">
        <Tag tone="muted">{item.state === "handed-off" ? "handed off (recorded delivery)" : item.state}</Tag> {item.destinationSession} · updated <Timestamp iso={item.tsUpdated} />
      </span>
    );
  }
  return (
    <span className="mt-0.5 block font-mono text-[11px] text-on-surface-variant [overflow-wrap:anywhere]">
      {lane === "waitingYou" ? `${item.state} · ` : ""}{item.destinationSession} · {item.priority} · {ageSince(item.claimedAt ?? item.tsUpdated, now)}
    </span>
  );
}

function NowRow({ row, read, status, flash, selectedQitem, onOpenQitem, now }: {
  row: PulseNowRow; read: PulseRead; status: string; flash: boolean; selectedQitem: string | null; onOpenQitem: (id: string) => void; now: number;
}) {
  return (
    <li data-testid="pulse-now-row" data-session={row.session} data-rig-id={row.rigId} className={cn("px-3 py-2", flashClass(flash))}>
      <span className="block text-sm text-on-surface [overflow-wrap:anywhere]">
        {row.logicalId} <span className="text-[11px] text-on-surface-variant">· rig {row.rigName}</span><NewTag active={flash} />
      </span>
      <span className="mt-0.5 block text-[12px]"><SeatPointer session={row.session} resolution={resolveSeat(read, status, row.session)} testId="pulse-now-seat" /></span>
      <span className="mt-0.5 block font-mono text-[11px] text-on-surface-variant">last activity {ageSince(row.lastActivityAt, now)}</span>
      {row.work ? (
        <button type="button" data-list-item data-testid="pulse-now-work" aria-current={selectedQitem === row.work.qitemId ? "true" : undefined} onClick={() => onOpenQitem(row.work!.qitemId)} className="mt-1 block w-full border-l-2 border-secondary pl-2 text-left text-[12px] text-on-surface hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface [overflow-wrap:anywhere]">
          {qitemSubject(row.work)} <span className="font-mono text-[10px] text-on-surface-variant">{row.work.qitemId}</span>
        </button>
      ) : (
        <span data-testid="pulse-now-no-work" className="mt-1 block text-[12px] text-on-surface-variant">
          {row.workSourceAvailable ? "No in-progress work served for this seat." : "Work unknown: the in-progress source is unavailable."}
        </span>
      )}
    </li>
  );
}

/** Footer counts are the lanes' own referent sets (same model object). */
function PulseFooter({ model, read }: { model: NonNullable<PulseHook["model"]>; read: PulseRead }) {
  const count = (w: PulseWindow<unknown> | null) => w ? laneCountText(w) : "unavailable";
  return (
    <footer data-testid="pulse-footer" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-outline-variant pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface">
      <span data-testid="pulse-footer-now">Active {count(model.now)}</span>
      <span data-testid="pulse-footer-parked">Parked {count(model.parked)}</span>
      <span data-testid="pulse-footer-waiting">Needs you {count(model.waitingYou)}</span>
      <span className="text-on-surface-variant">Read completed <Timestamp iso={new Date(read.readAt).toISOString()} /></span>
    </footer>
  );
}

function SourceDisclosure({ pulse, read }: { pulse: PulseHook; read: PulseRead }) {
  const failedNodes = read.nodeSources.filter((n) => n.source.state === "unavailable");
  const blockerErrors = Object.entries(read.blockerErrors);
  return (
    <details data-testid="pulse-sources" open={pulse.status !== "ready"} className="mt-3 border-t border-outline-variant pt-2">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant hover:text-on-surface">Sources, bounds and freshness</summary>
      <ul className="mt-2 space-y-1 text-xs text-on-surface">
        {(Object.keys(read.sources) as Array<keyof PulseRead["sources"]>).map((name) => {
          const source = read.sources[name];
          return (
            <li key={name} data-testid={`pulse-source-${name}`} data-state={source.state}>
              <span className="font-mono">{SOURCE_LABEL[name]}</span>: {source.state === "available"
                ? <>{source.data.length} rows · read <Timestamp iso={new Date(source.readAt).toISOString()} /></>
                : <span className="text-tertiary">unavailable — {source.error.message}</span>}
            </li>
          );
        })}
        <li data-testid="pulse-source-inventory" data-state={read.inventory.state}>
          <span className="font-mono">rig inventory</span>: {read.inventory.state === "available"
            ? <>{read.inventory.data.length} rigs · {read.seats.length} seats read{read.truncatedRigCount ? ` · ${read.truncatedRigCount} rigs beyond the ${MAX_PULSE_RIGS}-rig cap not read` : ""}{read.truncatedSeatCount ? ` · ${read.truncatedSeatCount} seats beyond the ${MAX_PULSE_SEATS}-seat cap omitted` : ""}</>
            : <span className="text-tertiary">unavailable — {read.inventory.error.message}</span>}
        </li>
        {failedNodes.map((n) => (
          <li key={n.rig.id} data-testid="pulse-source-node-failure" className="text-tertiary">node read for rig {n.rig.name ?? n.rig.id} ({n.rig.id}) unavailable — {n.source.error?.message}</li>
        ))}
        {blockerErrors.map(([id, message]) => <li key={id} data-testid="pulse-source-blocker-failure" className="text-tertiary">blocker lookup {id} failed — {message}</li>)}
        {read.omittedBlockerIds.length ? <li data-testid="pulse-source-blocker-omitted">{read.omittedBlockerIds.length} blocker lookups omitted by the {MAX_PULSE_BLOCKERS}-lookup cap</li> : null}
        {!read.inventoryComplete ? <li data-testid="pulse-inventory-incomplete" className="text-warning">Inventory incomplete: Now/Parked totals are unknown.</li> : null}
      </ul>
    </details>
  );
}
