// Exact-seat work and canonical activity (gui-seat-work-contract.md).
//
// Identity: the successfully read, current inventory row for this exact
// host + rig + logical id, and ITS served canonicalSessionName — never a label,
// alias, node id or session reconstructed by the UI. The page's asserted
// sourceHost must equal the current, successfully read host selection.
//   - local  → three bounded exact-session queue windows (useSeatWork) and the
//              local review read for Needs you;
//   - remote → served inventory facts only; queue/review are not forwarded, so
//              nothing local is read or shown;
//   - unknown (unasserted / unconfirmed / mismatched source) → nothing is read.
// Served totals come from inventory and may include server-known adopted
// addresses; the lists show only rows addressed to the exact session. A failed
// current inventory read keeps its dated last row but authorizes no new work or
// review read. A failed window keeps its own dated retained rows with Retry.
// Canonical activity is the server's decision, distinct from the topology
// ring's quiet visual default.

import type { ReactNode } from "react";
import { useNodeInventory, type NodeInventoryEntry } from "../hooks/useNodeInventory.js";
import { NodeInventoryPartialReadError } from "../lib/fleet-inventory-reads.js";
import { useSeatWork, type SeatWorkWindowRead } from "../hooks/useSeatWork.js";
import { useRigAgents } from "../hooks/useReview.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";
import { LOCAL_OPERATOR_INSTANCE, type OperatorInstanceScope } from "../lib/operator-read.js";
import type { PulseQueueItem } from "../lib/recent-pulse-contracts.js";
import type { SeatWorkTarget } from "../lib/seat-work-reads.js";
import { cn } from "../lib/utils.js";
import { DisplayTime } from "./time/DisplayTime.js";
import { HistoryLink } from "./recent-pulse/RecentPulseParts.js";
import { recentPulseHref } from "./recent-pulse/recent-pulse-location.js";
import { useKnownSelectedHost } from "./topology/topology-navigation.js";
import { rowHeadline, selectSeatNeeds, sortFinished, type SeatNeedRow } from "./seat-work-selectors.js";

const PANEL = "border border-outline-variant bg-surface-lowest/30";
const HEADING = "font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-on-surface";
const MUTED = "text-[11px] text-on-surface-variant";
const BUTTON = "border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface";

type Admission = { kind: "local" } | { kind: "remote"; hostId: string } | { kind: "unknown" };

const isoOf = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export function SeatWorkPanel({ rigId, logicalId, sourceHost }: { rigId: string; logicalId: string; sourceHost?: string }) {
  const known = useKnownSelectedHost();
  const admission: Admission = sourceHost === undefined || known === null || known !== sourceHost
    ? { kind: "unknown" }
    : sourceHost === LOCAL_HOST_ID ? { kind: "local" } : { kind: "remote", hostId: sourceHost };
  if (admission.kind === "unknown") {
    return (
      <section data-testid="seat-work-panel" className={cn(PANEL, "px-3 py-3")}>
        <h2 className={HEADING}>Work</h2>
        <p data-testid="seat-work-source-unknown" role="status" className={cn(MUTED, "mt-1")}>
          This seat&apos;s source host isn&apos;t confirmed for this page, so its work and activity were not read.
        </p>
      </section>
    );
  }
  return <SeatWorkBody rigId={rigId} logicalId={logicalId} admission={admission} />;
}

function SeatWorkBody({ rigId, logicalId, admission }: { rigId: string; logicalId: string; admission: Exclude<Admission, { kind: "unknown" }> }) {
  const inventory = useNodeInventory(rigId);
  const exact = (rows: NodeInventoryEntry[] | undefined) => rows?.find((r) => r.rigId === rigId && r.logicalId === logicalId);
  const currentRow = !inventory.isError ? exact(inventory.data) : undefined;
  const retainedRow = inventory.isError ? exact(inventory.data) : undefined;
  const row = currentRow ?? retainedRow;
  // A partial read is still a FAILED read: its verified exact-seat row is shown
  // as its own dated evidence, never merged into the cache, never used as the
  // session/target for queue or review reads.
  const admittedHost = admission.kind === "local" ? LOCAL_HOST_ID : admission.hostId;
  const partial = inventory.error instanceof NodeInventoryPartialReadError
    && inventory.error.partial.hostId === admittedHost && inventory.error.partial.rigId === rigId
    ? inventory.error.partial : null;
  const partialRow = partial?.rows.find((r) => r.rigId === rigId && r.logicalId === logicalId);
  const session = currentRow && typeof currentRow.canonicalSessionName === "string" && currentRow.canonicalSessionName.trim()
    ? currentRow.canonicalSessionName : null;
  const target: SeatWorkTarget | null = admission.kind === "local" && currentRow && session
    ? { rigId: currentRow.rigId, logicalId: currentRow.logicalId, canonicalSessionName: session }
    : null;
  const scope: OperatorInstanceScope = admission.kind === "remote" ? { kind: "remote-instance", hostId: admission.hostId } : LOCAL_OPERATOR_INSTANCE;
  const work = useSeatWork(scope, target);

  const disabledReason = inventory.isError
    ? "Waiting for a current seat identity; the inventory read failed, so nothing new is read for this seat."
    : inventory.data === undefined
      ? "Reading this seat's identity…"
      : !currentRow
        ? "This seat is not in the rig's current inventory."
        : !session
          ? "This seat has no served session, so no work addressed to it can be listed (no served session)."
          : "Not read.";
  const remoteNote = admission.kind === "remote"
    ? `Queue details for remote host ${admission.hostId} are not forwarded; nothing was read locally.`
    : null;
  const windowContext = { disabledReason, remoteNote };

  return (
    <section data-testid="seat-work-panel" aria-label="Seat work" className={cn(PANEL, "divide-y divide-outline-variant/55")}>
      <IdentityStatus inventory={inventory} retainedRow={retainedRow} />
      {partial && partialRow ? <PartialReadSection row={partialRow} receivedAt={partial.receivedAt} rejectedCount={partial.rejectedCount} /> : null}
      <ActivitySection row={row} readAt={isoOf(inventory.dataUpdatedAt)} retained={!currentRow && !!retainedRow} />
      <TotalsSection row={row} session={session ?? (retainedRow?.canonicalSessionName ?? null)} />
      <WorkWindow name="current" title="Current work" read={work.windows.current} context={windowContext}
        emptyText="Nothing in progress or blocked is addressed to this seat."
        rows={(rows) => rows} />
      <NeedsYouSection row={row} admission={admission} session={target ? session : null} />
      <WorkWindow name="pending" title="Up next" read={work.windows.pending} context={windowContext}
        emptyText="Nothing pending is addressed to this seat."
        rows={(rows) => rows} />
      <WorkWindow name="finished" title="Recently finished" read={work.windows.finished} context={windowContext}
        emptyText="No finished work in this window."
        note={(limit) => `Bounded: the latest ${limit} created items, ordered here by last update — not the full finish history.`}
        rows={sortFinished} />
    </section>
  );
}

function IdentityStatus({ inventory, retainedRow }: { inventory: ReturnType<typeof useNodeInventory>; retainedRow: NodeInventoryEntry | undefined }) {
  if (!inventory.isError) return null;
  const message = inventory.error instanceof Error ? inventory.error.message : "read failed";
  return (
    <div className="px-3 py-2">
      {retainedRow ? (
        <p data-testid="seat-work-identity-stale" role="alert" className="text-[11px] text-warning">
          Seat inventory refresh failed ({message}). Facts below are from the last read at{" "}
          <DisplayTime iso={isoOf(inventory.dataUpdatedAt)} />; work lists wait for a current read.
        </p>
      ) : (
        <p data-testid="seat-work-identity-error" role="alert" className="text-[11px] text-tertiary">
          Seat inventory unavailable ({message}); this seat&apos;s work cannot be read.
        </p>
      )}
      <button type="button" onClick={() => void inventory.refetch()} className={cn(BUTTON, "mt-1")}>Retry</button>
    </div>
  );
}

/** Verified exact-seat facts from the latest (partial, failed) inventory read,
 *  dated by that read's receipt and kept apart from any older successful row. */
function PartialReadSection({ row, receivedAt, rejectedCount }: { row: NodeInventoryEntry; receivedAt: number; rejectedCount: number }) {
  const state = row.activityState;
  const count = (value: number | undefined) => (typeof value === "number" ? String(value) : NOT_SERVED);
  return (
    <div data-testid="seat-work-partial" className="px-3 py-2">
      <h3 className={HEADING}>Latest inventory read · partial</h3>
      <p className={cn(MUTED, "mt-1")}>
        Read at <DisplayTime iso={isoOf(receivedAt)} />: {rejectedCount} other record{rejectedCount === 1 ? " was" : "s were"} rejected, so the read
        failed. This seat&apos;s own record in it was valid; its facts are shown here but are not used to read work or review requests.
      </p>
      <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        <Fact label="now" testId="seat-work-partial-display">{state?.display ?? NOT_SERVED}</Fact>
        <Fact label="decided by">{state?.decidedBy ?? NOT_SERVED}</Fact>
        <Fact label="input needed">
          {state == null ? NOT_SERVED : state.needsInput.count > 0 ? `${state.needsInput.count} · ${state.needsInput.reason ?? "reason not served"}` : "none reported"}
        </Fact>
        <Fact label="totals">
          assigned {count(row.assignedWorkCount)} · pending {count(row.pendingWorkCount)} · in progress {count(row.inProgressWorkCount)} · blocked {count(row.blockedWorkCount)}
        </Fact>
      </dl>
    </div>
  );
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 font-mono text-[10px] lowercase text-on-surface-variant">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-words text-[11px] text-on-surface [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const NOT_SERVED = <span className="text-on-surface-variant">not served</span>;

function ActivitySection({ row, readAt, retained }: { row: NodeInventoryEntry | undefined; readAt: string | null; retained: boolean }) {
  const state = row?.activityState;
  const hook = row?.agentActivity;
  const input = state === undefined || state === null
    ? NOT_SERVED
    : state.needsInput.count > 0
      ? `${state.needsInput.count} request${state.needsInput.count === 1 ? "" : "s"} · ${state.needsInput.reason ?? "reason not served"}`
      : "none reported";
  return (
    <div data-testid="seat-work-activity" className="px-3 py-2">
      <h3 className={HEADING}>Activity</h3>
      <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        <Fact label="now" testId="seat-work-activity-display">{state?.display ?? NOT_SERVED}</Fact>
        <Fact label="decided by">{state?.decidedBy ?? NOT_SERVED}</Fact>
        <Fact label="input needed" testId="seat-work-activity-input">{input}</Fact>
        <Fact label="reason">{hook?.reason ?? NOT_SERVED}</Fact>
      </dl>
      <details className="mt-1">
        <summary className={cn(MUTED, "cursor-pointer")}>Activity evidence</summary>
        <dl className="mt-1 space-y-0.5">
          <Fact label="activity">{state?.activity ?? NOT_SERVED}</Fact>
          <Fact label="source">{hook?.evidenceSource ?? NOT_SERVED}</Fact>
          <Fact label="event at"><DisplayTime iso={hook?.eventAt ?? null} fallback="not served" /></Fact>
          <Fact label="sampled at"><DisplayTime iso={hook?.sampledAt ?? null} fallback="not served" /></Fact>
          <Fact label="last swap">{state?.lastSwap ? <><DisplayTime iso={state.lastSwap.at} /> · {state.lastSwap.generation}</> : NOT_SERVED}</Fact>
          <Fact label="sequence">{state ? String(state.seq) : NOT_SERVED}</Fact>
          <Fact label={retained ? "last read" : "read at"}><DisplayTime iso={readAt} fallback="not read" /></Fact>
        </dl>
        <p className={cn(MUTED, "mt-1")}>Decided by the server from runtime evidence; the topology ring is a separate visual cue.</p>
      </details>
    </div>
  );
}

function TotalsSection({ row, session }: { row: NodeInventoryEntry | undefined; session: string | null }) {
  const count = (value: number | undefined) => (typeof value === "number" ? String(value) : NOT_SERVED);
  return (
    <div data-testid="seat-work-totals" className="px-3 py-2">
      <h3 className={HEADING}>Queue depth</h3>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
        <Fact label="assigned" testId="seat-work-total-assigned">{count(row?.assignedWorkCount)}</Fact>
        <Fact label="pending" testId="seat-work-total-pending">{count(row?.pendingWorkCount)}</Fact>
        <Fact label="in progress" testId="seat-work-total-in-progress">{count(row?.inProgressWorkCount)}</Fact>
        <Fact label="blocked" testId="seat-work-total-blocked">{count(row?.blockedWorkCount)}</Fact>
      </dl>
      <p className={cn(MUTED, "mt-1")}>
        Totals are served for this seat and can include server-known adopted addresses.{" "}
        {session ? <>Lists show only work addressed to <span className="font-mono">{session}</span>.</> : "This seat has no served session."}
      </p>
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  "in-progress": "In progress", blocked: "Blocked", pending: "Pending", done: "Done", "handed-off": "Handed off",
};

function WorkRow({ row }: { row: PulseQueueItem }) {
  return (
    <li data-testid="seat-work-row" data-qitem-id={row.qitemId} className="px-3 py-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={cn("font-mono text-[9px] uppercase tracking-[0.1em]", row.state === "blocked" ? "text-tertiary" : "text-on-surface-variant")}>
          {STATE_LABEL[row.state] ?? row.state}
        </span>
        {row.state === "pending" && row.claimedAt ? <span className="font-mono text-[9px] uppercase text-on-surface-variant">Claimed</span> : null}
        {row.priority !== "routine" ? <span className="font-mono text-[9px] uppercase text-warning">{row.priority}</span> : null}
        <span className="min-w-0 flex-1 break-words text-[12px] text-on-surface [overflow-wrap:anywhere]">{rowHeadline(row)}</span>
      </div>
      {row.blockedOn ? <p className={MUTED}>Blocked on {row.blockedOn}</p> : null}
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 font-mono text-[10px] text-on-surface-variant">
        <HistoryLink href={recentPulseHref({ qitem: row.qitemId })} data-testid="seat-work-qitem-link" className="underline decoration-dotted hover:text-on-surface">
          {row.qitemId}
        </HistoryLink>
        <span>from {row.sourceSession}</span>
        <span>created <DisplayTime iso={row.tsCreated} /></span>
        <span>updated <DisplayTime iso={row.tsUpdated} /></span>
      </div>
    </li>
  );
}

function WorkWindow({ name, title, read, context, emptyText, note, rows }: {
  name: string;
  title: string;
  read: SeatWorkWindowRead;
  context: { disabledReason: string; remoteNote: string | null };
  emptyText: string;
  note?: (limit: number) => string;
  rows: (rows: PulseQueueItem[]) => PulseQueueItem[];
}) {
  const window = read.current ?? read.retained;
  let body: ReactNode;
  if (read.status === "unsupported") {
    body = <p className={MUTED}>{context.remoteNote ?? "Not available for this source."}</p>;
  } else if (read.status === "disabled") {
    body = <p className={MUTED}>{context.disabledReason}</p>;
  } else if (read.status === "loading") {
    body = <p role="status" className={MUTED}>Reading…</p>;
  } else if (read.status === "error" && !read.retained) {
    body = (
      <div data-testid="seat-work-window-error" role="alert" className="text-[11px] text-tertiary">
        Unavailable ({read.error?.message ?? "read failed"}) — this is not an empty list.
        <button type="button" onClick={() => void read.refetch()} className={cn(BUTTON, "ml-2")}>Retry</button>
      </div>
    );
  } else if (window) {
    const list = rows(window.rows);
    body = (
      <>
        {read.status === "error" ? (
          <div data-testid="seat-work-window-stale" role="alert" className="mb-1 text-[11px] text-warning">
            Refresh failed ({read.error?.message ?? "read failed"}); showing the last read at <DisplayTime iso={isoOf(window.readAt)} />.
            <button type="button" onClick={() => void read.refetch()} className={cn(BUTTON, "ml-2")}>Retry</button>
          </div>
        ) : null}
        {list.length === 0 ? (
          <p data-testid="seat-work-window-empty" className={MUTED}>{emptyText}</p>
        ) : (
          <ul className="-mx-3 divide-y divide-outline-variant/40">{list.map((row) => <WorkRow key={row.qitemId} row={row} />)}</ul>
        )}
        {window.possiblyBounded ? <p className={cn(MUTED, "mt-1")}>Showing the first {window.limit} served; more may exist.</p> : null}
        {note ? <p className={cn(MUTED, "mt-1")}>{note(window.limit)}</p> : null}
      </>
    );
  }
  return (
    <div data-testid={`seat-work-${name}`} className="px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={HEADING}>{title}{window && read.status !== "error" ? ` · ${window.rows.length}` : ""}</h3>
        {read.isFetching && window ? <span aria-live="polite" className={MUTED}>Refreshing…</span> : null}
      </div>
      <div className="mt-1">{body}</div>
    </div>
  );
}

function NeedsYouSection({ row, admission, session }: { row: NodeInventoryEntry | undefined; admission: Exclude<Admission, { kind: "unknown" }>; session: string | null }) {
  const input = row?.activityState?.needsInput;
  return (
    <div data-testid="seat-work-needs-you" className="px-3 py-2">
      <h3 className={HEADING}>Needs you</h3>
      <div className="mt-1 space-y-1">
        {input && input.count > 0 ? (
          <p data-testid="seat-work-runtime-need" className="text-[12px] text-on-surface">
            The runtime reports {input.count} input request{input.count === 1 ? "" : "s"}: {input.reason ?? "reason not served"}.
          </p>
        ) : row?.activityState == null ? (
          <p className={MUTED}>Runtime input need: not served.</p>
        ) : null}
        {admission.kind === "remote" ? (
          <p className={MUTED}>Review requests for remote host {admission.hostId} are not forwarded; nothing was read locally.</p>
        ) : session === null ? (
          <p className={MUTED}>Review requests wait for a current seat identity.</p>
        ) : (
          <SeatReviewNeeds session={session} />
        )}
      </div>
    </div>
  );
}

/** Mounted only for an admitted local seat with a current served session. */
function SeatReviewNeeds({ session }: { session: string }) {
  const review = useRigAgents();
  const items = review.data && review.data.needsYou && Array.isArray(review.data.needsYou.items) ? (review.data.needsYou.items as unknown[]) : null;
  if (review.data === undefined) {
    return review.error ? (
      <div data-testid="seat-work-review-error" role="alert" className="text-[11px] text-tertiary">
        Review requests unavailable ({review.error.message}) — this is not &ldquo;none&rdquo;.
        <button type="button" onClick={() => void review.refetch()} className={cn(BUTTON, "ml-2")}>Retry</button>
      </div>
    ) : <p role="status" className={MUTED}>Reading review requests…</p>;
  }
  if (items === null) {
    return <p data-testid="seat-work-review-error" role="alert" className="text-[11px] text-tertiary">Review requests could not be read (response lacks its needs list).</p>;
  }
  const { matched, unreadable } = selectSeatNeeds(items, session);
  return (
    <>
      {review.error ? (
        <div data-testid="seat-work-review-stale" role="alert" className="text-[11px] text-warning">
          Review refresh failed ({review.error.message}); showing the last read at <DisplayTime iso={isoOf(review.dataUpdatedAt)} />.
          <button type="button" onClick={() => void review.refetch()} className={cn(BUTTON, "ml-2")}>Retry</button>
        </div>
      ) : null}
      {matched.length === 0 ? (
        <p data-testid="seat-work-review-none" className={MUTED}>No review requests are addressed to this seat in the latest read.</p>
      ) : (
        <ul className="space-y-1">{matched.map((need) => <NeedRow key={need.identity} need={need} />)}</ul>
      )}
      {unreadable > 0 ? <p className={MUTED}>{unreadable} review row{unreadable === 1 ? "" : "s"} could not be read and {unreadable === 1 ? "is" : "are"} not shown.</p> : null}
    </>
  );
}

function NeedRow({ need }: { need: SeatNeedRow }) {
  return (
    <li data-testid="seat-work-need" data-identity={need.identity} className="text-[12px] text-on-surface">
      <span className="mr-2 font-mono text-[9px] uppercase text-on-surface-variant">{need.source === "agent" ? need.leg : `flagged · ${need.derived?.kind ?? need.leg}`}</span>
      {need.summary}
      {need.unblocks ? <span className={cn(MUTED, "ml-1")}>· unblocks {need.unblocks}</span> : null}
      {need.qitemId ? (
        <HistoryLink href={recentPulseHref({ qitem: need.qitemId })} data-testid="seat-work-need-qitem-link" className="ml-2 font-mono text-[10px] underline decoration-dotted">
          {need.qitemId}
        </HistoryLink>
      ) : null}
      <details>
        <summary className={cn(MUTED, "cursor-pointer")}>Evidence</summary>
        <dl className="mt-0.5 space-y-0.5">
          <Fact label="identity"><span className="font-mono">{need.identity}</span></Fact>
          {need.derived ? <Fact label="evidence">{need.derived.evidence} (threshold {need.derived.threshold})</Fact> : null}
          {need.evidenceRef ? <Fact label="evidence ref">{need.evidenceRef}</Fact> : null}
          <Fact label="age"><DisplayTime iso={need.ageIso} fallback="not served" /></Fact>
        </dl>
      </details>
    </li>
  );
}
