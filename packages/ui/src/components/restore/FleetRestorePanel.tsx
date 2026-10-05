// Connected fleet restore: one deliberate kickoff, then progressive receipts for
// the exact accepted attempt. This is NOT the single-snapshot restore on a rig
// page; that action and its semantics are unchanged.
//
// What the daemon serves is all that is shown: done/cancelled/verdict, the four
// outcome counts and ordered per-rig rows as each rig finishes. There is no total,
// current rig or percentage in this API, so none is invented. Pausing only stops
// this browser's observation; Stop asks the conductor to stop BEFORE THE NEXT rig
// and the attempt stays observed until the daemon reports done.

import { useState } from "react";
import { cn } from "../../lib/utils.js";
import type { FleetRestoreAttention, FleetRestoreOutcome, FleetRestoreRow, FleetRestoreStatus } from "../../lib/startup-contracts.js";
import { useRecoveryOperations, type FleetCancelRecord, type FleetKickoffRecord } from "../startup/RecoveryOperationsProvider.js";
import { ActionButton, Badge, Evidence, ExactId, Fact, FactList, Notice, SectionLabel, SurfaceHeader, RecoveryStamp, receiptIso, type RecoveryTone } from "../startup/recovery-primitives.js";
import { DisplayZoneNote } from "../time/DisplayTime.js";

export interface FleetRestorePanelProps {
  /** Open the rig page for a restored/failed rig (exact served rig ID). */
  onOpenRig?: (rigId: string) => void;
  /** Open the exact seat named by an attention row so its native prompt can be resolved there. */
  onInspectSeat?: (target: { rigId: string; seat: string }) => void;
}

const OUTCOMES: { key: FleetRestoreOutcome; label: string; tone: RecoveryTone }[] = [
  { key: "fully_restored", label: "Fully restored", tone: "success" },
  { key: "partially_restored", label: "Partially restored", tone: "warning" },
  { key: "failed", label: "Failed", tone: "error" },
  { key: "not_attempted", label: "Not attempted", tone: "neutral" },
];
const outcomeMeta = Object.fromEntries(OUTCOMES.map(o => [o.key, o])) as Record<FleetRestoreOutcome, (typeof OUTCOMES)[number]>;
const verdictCopy: Record<FleetRestoreStatus["verdict"], string> = {
  all_fully_restored: "Every finished rig fully restored",
  all_failed: "Every finished rig failed",
  none_attempted: "No rig attempted",
  mixed: "Mixed outcomes",
};

export function FleetRestorePanel({ onOpenRig, onInspectSeat }: FleetRestorePanelProps) {
  const { selection, refusal, connectionKey, fleet } = useRecoveryOperations();
  const [refusalNote, setRefusalNote] = useState<string | null>(null);
  const run = (outcome: { ok: boolean; reason?: string }) => setRefusalNote(outcome.ok ? null : outcome.reason ?? null);

  return (
    <div data-testid="fleet-restore" className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6">
      <SurfaceHeader
        testId="fleet-restore"
        eyebrow="Recovery · connected instance"
        title="Fleet restore"
        description={<>Restores every rig on the connected daemon: kernel first, then one rig at a time, best effort. Surviving panes are adopted;
          stopped rigs use their latest restore-usable snapshot; nothing is started fresh automatically. Single-snapshot restore on a rig page is separate.</>}
      >
        <p data-testid="fleet-instance-label" className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface">
          Connected instance · {selection.state === "unknown" ? "reading" : selection.instanceName ?? "name not reported"}
        </p>
        <DisplayZoneNote testId="fleet-zone-note" />
      </SurfaceHeader>

      <div className="grid gap-4">
        <ScopeNotices />
        {fleet.foreignHandle ? (
          <Notice tone="warning" title="Attempt from another connected instance" testId="fleet-foreign-handle">
            Attempt <ExactId value={fleet.foreignHandle.fleetAttemptId} /> was accepted by <ExactId value={fleet.foreignHandle.connectionKey} />.
            It is not observed or stopped from this instance, and its rows are not shown here.
          </Notice>
        ) : null}
        <RetentionNotices />
        <KickoffSection kickoff={fleet.kickoff} onRun={run} />
        {fleet.handle ? (
          <AttemptSection onRun={run} onOpenRig={onOpenRig} onInspectSeat={onInspectSeat} />
        ) : null}
        {refusalNote ? <Notice tone="warning" title="Not sent" testId="fleet-refusal" live="polite">{refusalNote}</Notice> : null}
        {refusal && fleet.handle ? (
          <p className="text-xs text-on-surface-variant" data-testid="fleet-scope-hold">{refusal} The retained attempt ID is kept.</p>
        ) : null}
        <Evidence summary="Source evidence · connection and limits" testId="fleet-evidence">
          <FactList>
            <Fact label="Connection key">{connectionKey ? <ExactId value={connectionKey} testId="fleet-connection-key" /> : "not known yet"}</Fact>
            <Fact label="Retention">One accepted attempt per connected instance in this browser tab. Not shared across tabs; not server-side history.</Fact>
            <Fact label="Daemon memory">Attempts live in daemon memory. After a daemon restart the attempt ID is unknown to it, which does not mean nothing ran.</Fact>
            <Fact label="Offline">The browser cannot start a stopped daemon or run offline crash-cart detection. Use <code className="font-mono">rig</code> on the daemon host.</Fact>
          </FactList>
        </Evidence>
      </div>
    </div>
  );
}

function ScopeNotices() {
  const { selection } = useRecoveryOperations();
  if (selection.state === "unknown") {
    return (
      <Notice tone="neutral" title="Reading host selection" testId="fleet-selection-unknown" live="polite">
        {selection.error ? `Host selection could not be read: ${selection.error.message}. ` : ""}
        Fleet restore waits until the selection is known to be the connected local instance.
      </Notice>
    );
  }
  if (selection.state === "remote") {
    return (
      <Notice tone="warning" title="Remote host selected · fleet restore unavailable" testId="fleet-remote-scope" live="polite">
        Topology is viewing <ExactId value={selection.hostId} />. Fleet restore is not forwarded to other hosts and never falls back to this instance under a remote label.
        Select the local host to start or observe an attempt here; a retained attempt ID is kept meanwhile.
      </Notice>
    );
  }
  if (selection.stale) {
    return (
      <Notice tone="warning" title="Host selection not re-read" testId="fleet-selection-stale" live="polite">
        The latest host-selection refresh failed{selection.error ? ` (${selection.error.message})` : ""}. Observation of a retained attempt continues;
        no new kickoff or stop is sent until the selection reads again.
      </Notice>
    );
  }
  return null;
}

function RetentionNotices() {
  const { fleet } = useRecoveryOperations();
  return (
    <>
      {fleet.acceptedRetentionError ? (
        <Notice tone="warning" title="Accepted · not saved for reload" testId="fleet-retention-error">
          {fleet.acceptedRetentionError} This tab keeps the exact attempt ID while it stays open; reloading will lose it.
        </Notice>
      ) : null}
      {fleet.storageError && fleet.storageError !== fleet.acceptedRetentionError ? (
        <Notice tone="warning" title="Browser storage unavailable" testId="fleet-storage-error">{fleet.storageError}</Notice>
      ) : null}
    </>
  );
}

// -------------------------------------------------------------------- kickoff

function KickoffSection({ kickoff, onRun }: { kickoff: FleetKickoffRecord | null; onRun: (o: { ok: boolean; reason?: string }) => void }) {
  const { refusal, fleet } = useRecoveryOperations();
  const blockedByAttempt = !!fleet.handle && !fleet.done && !fleet.unknownToDaemon;
  const lostUnacknowledged = kickoff?.status === "outcome_unknown" && !kickoff.acknowledged;
  return (
    <section aria-labelledby="fleet-kickoff-label" data-testid="fleet-kickoff" className="grid gap-3 border border-outline-variant p-3">
      <SectionLabel id="fleet-kickoff-label">Start</SectionLabel>
      {kickoff?.status === "pending" ? (
        <Notice tone="info" title="Kickoff submitted once" testId="fleet-kickoff-pending" live="polite">
          Waiting for the daemon to accept. Leaving this page does not cancel the request; the accepted attempt ID is kept when it arrives.
        </Notice>
      ) : null}
      {kickoff?.status === "rejected" ? (
        <Notice tone="warning" title="Kickoff refused" testId="fleet-kickoff-rejected">
          {kickoff.error?.message}{kickoff.error?.status ? ` (HTTP ${kickoff.error.status})` : ""}
        </Notice>
      ) : null}
      {kickoff?.status === "outcome_unknown" ? (
        <Notice tone="error" title="Kickoff outcome unknown · no attempt ID" testId="fleet-kickoff-unknown" live="assertive">
          {kickoff.error?.message} A restore may already be running on the connected daemon. This API has no list or latest-attempt route, so the attempt cannot be
          found again from here. Inspect rig status before deciding to start another; nothing is resent automatically.
          {!kickoff.acknowledged ? (
            <span className="mt-2 block">
              <ActionButton data-testid="fleet-kickoff-acknowledge" onClick={() => fleet.acknowledgeLostKickoff()}>I have checked · allow another kickoff</ActionButton>
            </span>
          ) : null}
        </Notice>
      ) : null}
      {blockedByAttempt ? (
        <p className="text-sm text-on-surface-variant" data-testid="fleet-kickoff-held">
          The retained attempt below has not reported done. Starting another restore would run a second conductor, so this stays unavailable until it finishes.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            variant="primary"
            data-testid="fleet-kickoff-start"
            disabled={!!refusal || fleet.kickoffPending || lostUnacknowledged}
            onClick={() => onRun(fleet.start())}
          >
            {fleet.kickoffPending ? "Awaiting acceptance…" : "Restore fleet"}
          </ActionButton>
          <span className="text-xs text-on-surface-variant">Acceptance means started, not finished or successful.</span>
        </div>
      )}
    </section>
  );
}

// -------------------------------------------------------------- the attempt

function AttemptSection({ onRun, onOpenRig, onInspectSeat }: { onRun: (o: { ok: boolean; reason?: string }) => void } & FleetRestorePanelProps) {
  const { fleet, refusal } = useRecoveryOperations();
  const [confirmForget, setConfirmForget] = useState(false);
  const handle = fleet.handle!;
  const status = fleet.status;
  const observation = fleet.observation;
  const phase = status.frame?.phase ?? "observing";
  const readError = status.error ?? null;
  const notObserved = !fleet.observedHandle;
  const autoDetached = status.detached && !fleet.pausedByOperator && !fleet.done;
  const phaseBadge = fleet.unknownToDaemon ? { tone: "error" as const, label: "unknown to daemon" }
    : fleet.done ? { tone: "success" as const, label: "done" }
    : fleet.pausedByOperator ? { tone: "neutral" as const, label: "observation paused" }
    : autoDetached ? { tone: "warning" as const, label: "observation stopped" }
    : notObserved ? { tone: "neutral" as const, label: "not observed" }
    : observation ? { tone: "info" as const, label: "running" } : { tone: "info" as const, label: "reading" };

  return (
    <section aria-labelledby="fleet-attempt-label" data-testid="fleet-attempt" data-phase={phase} className="grid gap-3 border border-outline-variant p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel id="fleet-attempt-label">Attempt</SectionLabel>
        <ExactId value={handle.fleetAttemptId} testId="fleet-attempt-id" />
        <Badge tone={phaseBadge.tone} testId="fleet-phase">{phaseBadge.label}</Badge>
        {status.dataUpdatedAt ? <span data-testid="fleet-last-read" className="font-mono text-[9px] text-on-surface-variant">last read <RecoveryStamp iso={receiptIso(status.dataUpdatedAt)} testId="fleet-last-read-at" /> · {status.polls} reads</span> : null}
      </div>

      {fleet.unknownToDaemon ? (
        <Notice tone="error" title="This daemon no longer knows the attempt" testId="fleet-unknown-attempt" live="assertive">
          The connected daemon answered 404 for <ExactId value={handle.fleetAttemptId} />, for example after a restart. That does not mean nothing ran:
          rigs may have been restored before it was lost. Inspect rigs directly. The last observation below is kept.
        </Notice>
      ) : null}
      {autoDetached ? (
        <Notice tone="warning" title="Observation stopped · restore not stopped" testId="fleet-auto-detached" live="polite">
          This view stopped reading after {status.polls >= 4500 ? "its poll ceiling" : "repeated failed reads"}. The conductor on the daemon is unaffected.
          Resume to read the same attempt again.
        </Notice>
      ) : null}
      {fleet.pausedByOperator && !fleet.done ? (
        <Notice tone="neutral" title="Observation paused" testId="fleet-paused">
          Only this browser stopped reading. The restore continues on the daemon; use Stop to request that it stop before the next rig.
        </Notice>
      ) : null}
      {readError && !fleet.unknownToDaemon && !status.detached ? (
        <p role="status" data-testid="fleet-read-error" className="text-xs text-warning">
          Last read failed: {readError.message} Retrying the same attempt; the last observation stays as served.
        </p>
      ) : null}

      <CancelState cancel={fleet.cancel} observation={observation} cancelReadSince={fleet.cancelReadSince} />

      {observation ? <Observation observation={observation} onOpenRig={onOpenRig} onInspectSeat={onInspectSeat} />
        : !fleet.unknownToDaemon ? <p role="status" className="text-sm text-on-surface-variant">Reading the attempt…</p> : null}

      <div className="flex flex-wrap gap-2" data-testid="fleet-controls">
        {!fleet.done && !fleet.unknownToDaemon ? (
          status.detached ? (
            <ActionButton data-testid="fleet-resume" disabled={notObserved} onClick={() => fleet.resumeObservation()}>Resume observing</ActionButton>
          ) : (
            <ActionButton variant="quiet" data-testid="fleet-pause" disabled={notObserved} onClick={() => fleet.pauseObservation()}>Pause observing</ActionButton>
          )
        ) : null}
        {!fleet.done && !fleet.unknownToDaemon ? (
          <ActionButton variant="danger" data-testid="fleet-stop"
            disabled={!!refusal || notObserved || fleet.cancelPending || !fleet.cancelReadSince || fleet.cancel?.status === "accepted" || observation?.cancelled === true}
            onClick={() => onRun(fleet.requestCancel())}>
            {fleet.cancelPending ? "Requesting stop…" : "Stop before next rig"}
          </ActionButton>
        ) : null}
        {confirmForget ? (
          <span className="inline-flex flex-wrap items-center gap-2" data-testid="fleet-forget-confirm">
            <span className="text-xs text-on-surface">Forget only clears this tab&apos;s record{!fleet.done ? "; the restore keeps running" : ""}.</span>
            <ActionButton variant="danger" data-testid="fleet-forget-yes" onClick={() => { fleet.forget(); setConfirmForget(false); }}>Forget attempt</ActionButton>
            <ActionButton data-testid="fleet-forget-no" onClick={() => setConfirmForget(false)}>Keep</ActionButton>
          </span>
        ) : (
          <ActionButton variant="quiet" data-testid="fleet-forget" disabled={fleet.kickoffPending || fleet.cancelPending} onClick={() => setConfirmForget(true)}>
            Forget attempt…
          </ActionButton>
        )}
      </div>
    </section>
  );
}

function CancelState({ cancel, observation, cancelReadSince }: { cancel: FleetCancelRecord | null; observation?: FleetRestoreStatus; cancelReadSince: boolean }) {
  if (observation?.cancelled) {
    return (
      <Notice tone="info" title={observation.done ? "Stopped before the next rig · done" : "Stop observed · current rig finishing"} testId="fleet-cancel-observed" live="polite">
        The daemon reports the attempt cancelled.{observation.done ? " Rigs not reached are not restored." : " The rig in progress continues until it finishes; observation continues until done."}
      </Notice>
    );
  }
  if (!cancel) return null;
  if (cancel.status === "pending") return <Notice tone="info" title="Stop requested · awaiting response" testId="fleet-cancel-pending" live="polite">Sent once for this exact attempt.</Notice>;
  if (cancel.status === "accepted") {
    return (
      <Notice tone="info" title="Stop accepted · not yet stopped" testId="fleet-cancel-accepted" live="polite">
        The conductor stops before the next rig. The current rig continues; this attempt is observed until the daemon reports done.
      </Notice>
    );
  }
  if (cancel.status === "rejected") {
    return <Notice tone="warning" title="Stop refused" testId="fleet-cancel-rejected">{cancel.error?.message}{cancel.error?.status === 404 ? " The daemon no longer knows this attempt." : ""}</Notice>;
  }
  return (
    <Notice tone="error" title="Stop outcome unknown" testId="fleet-cancel-unknown" live="assertive">
      {cancel.error?.message} The stop may or may not have reached the daemon. {cancelReadSince
        ? "A newer status has been read; you may deliberately request stop again for this same attempt."
        : "Waiting for a newer status read before another stop request is allowed."}
    </Notice>
  );
}

function Observation({ observation, onOpenRig, onInspectSeat }: { observation: FleetRestoreStatus } & FleetRestorePanelProps) {
  const { counts, sequence, attention_required: attention } = observation.rollup;
  return (
    <div className="grid gap-3" data-testid="fleet-observation">
      <FactList testId="fleet-raw-facts">
        <Fact label="Done" testId="fleet-fact-done">{observation.done ? "yes" : "no — still running"}</Fact>
        <Fact label="Cancelled" testId="fleet-fact-cancelled">{observation.cancelled ? "yes" : "no"}</Fact>
        <Fact label={observation.done ? "Verdict" : "Verdict so far"} testId="fleet-fact-verdict">
          {verdictCopy[observation.verdict]} <span className="font-mono text-[10px] text-on-surface-variant">({observation.verdict})</span>
        </Fact>
      </FactList>

      <ul aria-label="Outcome counts" data-testid="fleet-counts" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {OUTCOMES.map(o => (
          <li key={o.key} data-testid={`fleet-count-${o.key}`} className="border border-outline-variant px-2 py-1.5">
            <span className="block font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">{o.label}</span>
            <span className="font-mono text-lg text-on-surface">{counts[o.key]}</span>
          </li>
        ))}
      </ul>

      {attention.length ? (
        <section aria-labelledby="fleet-attention-label" data-testid="fleet-attention" className="grid gap-2">
          <SectionLabel id="fleet-attention-label">Needs attention · {attention.length}</SectionLabel>
          <ul className="grid gap-1">
            {attention.map((row, index) => <AttentionItem key={`${row.rigId}\u0000${row.seat}\u0000${index}`} row={row} onInspectSeat={onInspectSeat} />)}
          </ul>
          <p className="text-xs text-on-surface-variant">Answer trust, login or permission prompts in the native session. This page never answers them or starts a seat fresh.</p>
        </section>
      ) : null}

      <section aria-labelledby="fleet-rows-label" className="grid gap-2">
        <SectionLabel id="fleet-rows-label">Finished rigs · in order</SectionLabel>
        {sequence.length === 0 ? (
          <p data-testid="fleet-rows-empty" className="text-sm text-on-surface-variant">
            {observation.done ? "The attempt finished without reporting any rig." : "No rig has finished yet. The daemon reports rows only as each rig completes; it serves no total or current rig."}
          </p>
        ) : (
          <ol data-testid="fleet-rows" className="grid gap-2">
            {sequence.map((row, index) => <RigRow key={`${row.rigId}\u0000${index}`} row={row} index={index} onOpenRig={onOpenRig} onInspectSeat={onInspectSeat} />)}
          </ol>
        )}
      </section>
    </div>
  );
}

function AttentionItem({ row, onInspectSeat }: { row: FleetRestoreAttention; onInspectSeat?: FleetRestorePanelProps["onInspectSeat"] }) {
  return (
    <li data-testid="fleet-attention-item" className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-l-2 border-warning pl-2 text-sm">
      <ExactId value={row.rigId} /> <span className="text-on-surface-variant">/</span> <ExactId value={row.seat} />
      <span className="text-on-surface">— {row.need || "need not described"}</span>
      {onInspectSeat ? (
        <ActionButton variant="quiet" className="min-h-0 px-2 py-0.5" data-testid="fleet-attention-inspect"
          aria-label={`Inspect seat ${row.seat} in rig ${row.rigId}`} onClick={() => onInspectSeat({ rigId: row.rigId, seat: row.seat })}>
          Inspect seat
        </ActionButton>
      ) : null}
    </li>
  );
}

function RigRow({ row, index, onOpenRig, onInspectSeat }: { row: FleetRestoreRow; index: number } & FleetRestorePanelProps) {
  const meta = outcomeMeta[row.outcome];
  return (
    <li data-testid="fleet-row" data-outcome={row.outcome} className={cn("grid gap-1 border px-3 py-2", row.outcome === "failed" ? "border-tertiary" : "border-outline-variant")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-on-surface-variant">{index + 1}.</span>
        <ExactId value={row.rigId} />
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {onOpenRig ? <ActionButton variant="quiet" className="min-h-0 px-2 py-0.5" aria-label={`Open rig ${row.rigId}`} onClick={() => onOpenRig(row.rigId)}>Open rig</ActionButton> : null}
      </div>
      {row.reason ? <p className="text-sm text-on-surface"><span className="text-on-surface-variant">Reason · </span>{row.reason}</p> : null}
      {row.remediation ? <p className="text-sm text-on-surface" data-testid="fleet-row-remediation"><span className="text-on-surface-variant">Remediation · </span>{row.remediation}</p> : null}
      {row.attention?.length ? (
        <ul className="grid gap-1">{row.attention.map((item, i) => <AttentionItem key={`${item.seat}\u0000${i}`} row={item} onInspectSeat={onInspectSeat} />)}</ul>
      ) : null}
      {row.receiptRef !== undefined ? <p className="text-xs text-on-surface-variant">Receipt <ExactId value={String(row.receiptRef)} /></p> : null}
    </li>
  );
}
