// Per-seat startup chooser: discover a rig, inspect one served seat, then choose
// exactly one action (Resume/Start, Continue, or an explicitly confirmed Fresh).
// This is distinct from the bulk Launch/Restore actions on the rig page, which
// keep their own whole-rig semantics.
//
// Facts shown here are the daemon's served startup projection. They are not
// native conversation IDs and are never turned into synthetic progress. Native
// trust/login/permission prompts stay in the native session: the operator
// inspects that exact session, resolves the prompt there, and returns.

import { useMemo, useState } from "react";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import {
  useStartupPrerequisites, useStartupRig, selectStartupSeat, consentToFreshStartup, sameStartupSelection,
  type StartupRig, type StartupSeat, type StartupSelection,
} from "../../hooks/useStartup.js";
import { LOCAL_OPERATOR_INSTANCE, OperatorReadError, type OperatorInstanceScope } from "../../lib/operator-read.js";
import { cn } from "../../lib/utils.js";
import { useRecoveryOperations, type StartupAttemptRecord } from "./RecoveryOperationsProvider.js";
import { ActionButton, Badge, Evidence, ExactId, Fact, FactList, Notice, SectionLabel, SurfaceHeader, RecoveryStamp, useRetainedScroll, type RecoveryTone } from "./recovery-primitives.js";
import { DisplayZoneNote } from "../time/DisplayTime.js";

export interface StartupChooserProps {
  /** Open the existing exact-session inspection (e.g. /topology/seat/$rigId/$logicalId). */
  onInspectSeat?: (target: { rigId: string; logicalId: string; sessionName: string }) => void;
  /** Open the rig page where the legacy bulk Launch/Restore actions live. */
  onOpenRig?: (rigId: string) => void;
}

const observedTone: Record<StartupSeat["observed"]["state"], RecoveryTone> = {
  running: "success", stopped: "neutral", attention_required: "warning", transport_unavailable: "error", unverified: "warning",
};
const observedLabel: Record<StartupSeat["observed"]["state"], string> = {
  running: "running", stopped: "stopped", attention_required: "attention required", transport_unavailable: "transport unavailable", unverified: "unverified",
};
const actionLabel = { resume: "Resume", start: "Start", fresh: "Fresh start", continue: "Continue" } as const;

/** Hooks type their errors as Error; the startup read transport throws the
 * structured OperatorReadError. Narrow at runtime instead of widening the copy
 * contract: anything else is reported as an unclassified failure. */
export function asOperatorReadError(error: unknown): OperatorReadError | null {
  return error instanceof OperatorReadError ? error : null;
}

function readFailureCopy(error: OperatorReadError | null, fallback: string | null): { title: string; body: string } {
  if (!error) return { title: "Read unavailable", body: `${fallback ? `${fallback} ` : ""}The read did not complete. No state is inferred.` };
  if (error.status === 401 || error.status === 403)
    return { title: "Terminal authorization unavailable", body: "Startup reads use the terminal bearer token primed by the UI-serving daemon. This is an authorization failure, not proof the daemon is down." };
  if (error.code === "network" || error.code === "timeout")
    return { title: "Connected daemon unreachable", body: `${error.message} The browser cannot start a stopped daemon. On the daemon host, check \`rig daemon status\` and start it with \`rig daemon start\`, then refresh.` };
  if (error.code === "invalid_contract" || error.code === "invalid_json")
    return { title: "Startup contract not verified", body: `${error.message} Nothing is shown from an unverified response.` };
  return { title: "Read unavailable", body: error.message };
}

function ReadProblem({ error, onRetry, testId }: { error: unknown; onRetry: () => void; testId: string }) {
  const copy = readFailureCopy(asOperatorReadError(error), error instanceof Error ? error.message : null);
  return (
    <div className="grid gap-2">
      <Notice tone="error" title={copy.title} testId={testId} live="assertive">{copy.body}</Notice>
      <div><ActionButton onClick={onRetry} data-testid={`${testId}-retry`}>Retry read</ActionButton></div>
    </div>
  );
}

export function StartupChooser({ onInspectSeat, onOpenRig }: StartupChooserProps) {
  const ops = useRecoveryOperations();
  const { selection, startup } = ops;
  const scope: OperatorInstanceScope = selection.state === "local" ? LOCAL_OPERATOR_INSTANCE
    : { kind: "remote-instance", hostId: selection.state === "remote" ? selection.hostId : "unknown-selection" };
  const prerequisites = useStartupPrerequisites(scope);
  const rigs = useRigSummary();
  const rigQuery = useStartupRig(selection.state === "local" ? startup.chooser.rigId : null, scope);

  return (
    <div data-testid="startup-chooser" className="mx-auto w-full max-w-6xl px-3 py-4 sm:px-6">
      <SurfaceHeader
        testId="startup-chooser"
        eyebrow="Recovery · connected instance"
        title="Seat startup"
        description={<>Choose one seat and one action. Resume or Start follows the seat&apos;s served history; Fresh is a separate,
          confirmed choice. Bulk Launch and Restore on the rig page are unchanged and act on whole rigs.</>}
      >
        <p data-testid="startup-instance-label" className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface">
          Connected instance · {selection.state === "unknown" ? "reading" : selection.instanceName ?? "name not reported"}
        </p>
        <DisplayZoneNote testId="startup-zone-note" />
      </SurfaceHeader>

      {selection.state !== "unknown" && selection.stale ? (
        <Notice tone="warning" title="Host selection not re-read" testId="startup-selection-stale" live="polite">
          The last host-selection read succeeded, but the latest refresh failed{selection.error ? ` (${selection.error.message})` : ""}.
          Retained facts stay visible; no new startup effect is sent until the selection reads again.
        </Notice>
      ) : null}
      {selection.state === "unknown" ? (
        <Notice tone="neutral" title="Reading host selection" testId="startup-selection-unknown" live="polite">
          {selection.error ? `Host selection could not be read: ${selection.error.message}. ` : ""}
          Startup reads and actions wait until the selection is known to be the connected local instance.
        </Notice>
      ) : selection.state === "remote" ? (
        <Notice tone="warning" title="Remote host selected · startup unavailable" testId="startup-remote-scope" live="polite">
          Topology is viewing <ExactId value={selection.hostId} />. Startup routes act only on the connected instance and are not forwarded.
          Select the local host to inspect seats here; no local data is shown under a remote label.
        </Notice>
      ) : (
        <div className="grid gap-5">
          <InstancePreparation prerequisites={prerequisites} />
          <div className="grid gap-5 lg:grid-cols-[minmax(13rem,17rem)_minmax(0,1fr)]">
            <RigList rigs={rigs} />
            <RigDetail rigQuery={rigQuery} onInspectSeat={onInspectSeat} onOpenRig={onOpenRig} />
          </div>
          <StartupHelp />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------- instance preparation

function InstancePreparation({ prerequisites }: { prerequisites: ReturnType<typeof useStartupPrerequisites> }) {
  const { startup, refusal: scopeRefusal } = useRecoveryOperations();
  const [refusal, setRefusal] = useState<string | null>(null);
  const blocked = startup.operationPending || !!scopeRefusal;
  const prepRecords = startup.records.filter(row => row.attempt.kind === "terminal" || row.attempt.kind === "kernel");
  const submit = (request: Parameters<typeof startup.submit>[0]) => {
    const outcome = startup.submit(request);
    setRefusal(outcome.ok ? null : outcome.reason);
  };
  return (
    <section aria-labelledby="startup-prep-label" data-testid="startup-preparation" className="grid gap-3 border border-outline-variant p-3">
      <SectionLabel id="startup-prep-label">Instance preparation</SectionLabel>
      <div className="flex flex-wrap items-center gap-2" data-testid="startup-prerequisites">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">Runtime prerequisites</span>
        {prerequisites.data ? (
          <>
            <Badge tone={prerequisites.data.codex === "ok" ? "success" : "warning"} testId="startup-prereq-codex">codex · {prerequisites.data.codex}</Badge>
            <Badge tone={prerequisites.data.claudeCode === "ok" ? "success" : "warning"} testId="startup-prereq-claude">claude code · {prerequisites.data.claudeCode}</Badge>
            <span className="text-xs text-on-surface-variant">“unavailable” is one served fact; it does not distinguish install from login.</span>
          </>
        ) : prerequisites.isError ? null : <span className="text-xs text-on-surface-variant" role="status">Reading…</span>}
      </div>
      {prerequisites.isError ? <ReadProblem error={prerequisites.error} onRetry={() => void prerequisites.refetch()} testId="startup-prereq-error" /> : null}
      <div className="flex flex-wrap gap-2">
        <ActionButton data-testid="startup-terminal-service" disabled={blocked} onClick={() => submit({ kind: "terminal" })}>
          Start terminal service
        </ActionButton>
        <ActionButton data-testid="startup-kernel-codex" disabled={blocked} onClick={() => submit({ kind: "kernel", runtime: "codex" })}>
          Prepare kernel · codex
        </ActionButton>
        <ActionButton data-testid="startup-kernel-claude" disabled={blocked} onClick={() => submit({ kind: "kernel", runtime: "claude-code" })}>
          Prepare kernel · claude code
        </ActionButton>
      </div>
      <p className="text-xs text-on-surface-variant">
        The terminal service starts the tmux server only; it launches no seats. Kernel preparation creates or reuses topology only;
        its rig is selected afterward so you can inspect it and choose a seat.
      </p>
      {refusal ? <Notice tone="warning" title="Not sent" testId="startup-prep-refusal">{refusal}</Notice> : null}
      {prepRecords.slice(0, 2).map(record => <AttemptReceipt key={record.id} record={record} compact />)}
    </section>
  );
}

// ----------------------------------------------------------------- rig list

function RigList({ rigs }: { rigs: ReturnType<typeof useRigSummary> }) {
  const { startup } = useRecoveryOperations();
  const { chooser, updateChooser } = startup;
  // Placeholder rows belong to a previously selected host; they never authorize startup here.
  const trusted = rigs.isPlaceholderData ? undefined : rigs.data;
  const filter = chooser.rigFilter.trim().toLowerCase();
  const rows = (trusted ?? []).filter(rig => !filter || `${rig.name ?? ""} ${rig.id}`.toLowerCase().includes(filter));
  const { ref: scroller, onScroll } = useRetainedScroll<HTMLUListElement>(chooser.rigScroll, top => updateChooser({ rigScroll: top }), trusted ? "rigs" : null);

  return (
    <section aria-labelledby="startup-rigs-label" data-testid="startup-rig-list" className="grid content-start gap-2">
      <SectionLabel id="startup-rigs-label">Rigs</SectionLabel>
      <label className="grid gap-1 text-xs text-on-surface-variant">
        Filter rigs
        <input
          data-testid="startup-rig-filter"
          value={chooser.rigFilter}
          onChange={event => updateChooser({ rigFilter: event.target.value })}
          className="border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[11px] text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
        />
      </label>
      {!trusted ? (
        rigs.isError ? <Notice tone="error" title="Rig discovery unavailable" testId="startup-rigs-error" live="assertive">{rigs.error.message} No rig list is inferred.</Notice>
          : <p role="status" className="text-xs text-on-surface-variant">Reading rigs from the connected instance…</p>
      ) : trusted.length === 0 ? (
        <Notice title="No rigs on this instance" testId="startup-rigs-empty">Prepare a kernel above to create topology, then choose a seat.</Notice>
      ) : (
        <ul ref={scroller} onScroll={onScroll} data-testid="startup-rig-scroll" className="max-h-[22rem] overflow-y-auto border border-outline-variant divide-y divide-outline-variant lg:max-h-[32rem]">
          {rows.map(rig => {
            const selected = rig.id === chooser.rigId;
            return (
              <li key={rig.id}>
                <button
                  type="button"
                  data-testid={`startup-rig-${rig.id}`}
                  aria-pressed={selected}
                  onClick={() => updateChooser({ rigId: rig.id, nodeId: selected ? chooser.nodeId : null, seatScroll: selected ? chooser.seatScroll : 0 })}
                  className={cn("w-full px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface",
                    selected ? "border-l-2 border-l-on-surface bg-inverse-surface/[0.06]" : "border-l-2 border-l-transparent hover:bg-surface-low")}
                >
                  <span className="block break-words font-mono text-[11px] text-on-surface">{rig.name || <span className="text-on-surface-variant">name not served</span>}</span>
                  <span className="block break-words font-mono text-[9px] text-on-surface-variant [overflow-wrap:anywhere]">
                    {rig.id}{typeof rig.nodeCount === "number" ? ` · ${rig.nodeCount} node${rig.nodeCount === 1 ? "" : "s"}` : ""}{rig.lifecycleState ? ` · ${rig.lifecycleState}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
          {rows.length === 0 ? <li className="px-3 py-2 text-xs text-on-surface-variant">No rig matches “{chooser.rigFilter}”.</li> : null}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- rig detail

function RigDetail({ rigQuery, onInspectSeat, onOpenRig }: { rigQuery: ReturnType<typeof useStartupRig> } & StartupChooserProps) {
  const { startup } = useRecoveryOperations();
  const { chooser, updateChooser } = startup;
  const rig = rigQuery.data;
  const seatFilter = chooser.seatFilter.trim().toLowerCase();
  const seats = (rig?.seats ?? []).filter(seat => !seatFilter || `${seat.logicalId} ${seat.nodeId} ${seat.runtime ?? ""} ${seat.observed.sessionName}`.toLowerCase().includes(seatFilter));
  const selectedSeat = rig?.seats.find(seat => seat.nodeId === chooser.nodeId) ?? null;
  // Keyed by the exact rig: a new rig starts at its own retained position (0 when chosen).
  const { ref: scroller, onScroll } = useRetainedScroll<HTMLUListElement>(chooser.seatScroll, top => updateChooser({ seatScroll: top }), rig ? rig.rigId : null);

  if (!chooser.rigId) {
    return <section data-testid="startup-rig-detail"><Notice title="Choose a rig" testId="startup-no-rig">Select a rig to read its served seats.</Notice></section>;
  }
  return (
    <section aria-labelledby="startup-rig-label" data-testid="startup-rig-detail" className="grid min-w-0 content-start gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel id="startup-rig-label">Seats · {rig ? rig.rigName : <ExactId value={chooser.rigId} />}</SectionLabel>
        <div className="flex flex-wrap gap-2">
          <ActionButton variant="quiet" data-testid="startup-rig-refresh" disabled={rigQuery.isFetching} onClick={() => void rigQuery.refetch()}>
            {rigQuery.isFetching ? "Reading…" : "Refresh rig"}
          </ActionButton>
          {onOpenRig ? <ActionButton variant="quiet" data-testid="startup-open-rig" onClick={() => onOpenRig(chooser.rigId!)}>Rig page · bulk actions</ActionButton> : null}
        </div>
      </div>
      {rigQuery.isError ? <ReadProblem error={rigQuery.error} onRetry={() => void rigQuery.refetch()} testId="startup-rig-error" />
        : !rig ? <p role="status" className="text-xs text-on-surface-variant">Reading the exact rig <ExactId value={chooser.rigId} />…</p>
        : null}
      {rig ? (
        <>
          {rigQuery.isError ? <p className="text-xs text-warning">Showing the last successful read; it may no longer be current.</p> : null}
          <label className="grid gap-1 text-xs text-on-surface-variant">
            Filter seats
            <input
              data-testid="startup-seat-filter"
              value={chooser.seatFilter}
              onChange={event => updateChooser({ seatFilter: event.target.value })}
              className="border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[11px] text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
            />
          </label>
          {rig.seats.length === 0 ? <Notice title="This rig serves no seats" testId="startup-no-seats">The startup projection lists no seats for this rig.</Notice> : (
            <ul ref={scroller} onScroll={onScroll} data-testid="startup-seat-scroll" className="max-h-[20rem] overflow-y-auto border border-outline-variant divide-y divide-outline-variant">
              {seats.map(seat => <SeatRow key={seat.nodeId} seat={seat} selected={seat.nodeId === chooser.nodeId} onSelect={() => updateChooser({ nodeId: seat.nodeId })} />)}
              {seats.length === 0 ? <li className="px-3 py-2 text-xs text-on-surface-variant">No seat matches “{chooser.seatFilter}”.</li> : null}
            </ul>
          )}
          {chooser.nodeId && !selectedSeat ? (
            <Notice tone="warning" title="Selected seat no longer served" testId="startup-seat-gone">
              Node <ExactId value={chooser.nodeId} /> is absent from the latest read of this rig. Choose a served seat.
            </Notice>
          ) : null}
          {selectedSeat ? <SeatDetail key={selectedSeat.nodeId} rig={rig} seat={selectedSeat} refreshing={rigQuery.isFetching} onInspectSeat={onInspectSeat} /> : null}
        </>
      ) : null}
      <RigAttempts rigId={chooser.rigId} />
    </section>
  );
}

function SeatRow({ seat, selected, onSelect }: { seat: StartupSeat; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid={`startup-seat-${seat.nodeId}`}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn("grid w-full gap-1 px-3 py-2 text-left sm:grid-cols-[minmax(0,1fr)_auto] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-on-surface",
          selected ? "border-l-2 border-l-on-surface bg-inverse-surface/[0.06]" : "border-l-2 border-l-transparent hover:bg-surface-low")}
      >
        <span className="min-w-0">
          <span className="block break-words font-mono text-[11px] text-on-surface">{seat.logicalId}</span>
          <span className="block font-mono text-[9px] text-on-surface-variant">
            {seat.runtime ? <>runtime {seat.runtime}</> : <span className="text-warning">runtime unconfigured</span>}
            {" · "}{seat.hasHistory ? "history present" : "no history"}{seat.contextPending ? " · context pending" : ""}
          </span>
        </span>
        <span className="flex flex-wrap items-start gap-1">
          <Badge tone={observedTone[seat.observed.state]}>{observedLabel[seat.observed.state]}</Badge>
        </span>
      </button>
    </li>
  );
}

// --------------------------------------------------------------- seat detail

function SeatDetail({ rig, seat, refreshing, onInspectSeat }: { rig: StartupRig; seat: StartupSeat; refreshing: boolean; onInspectSeat?: StartupChooserProps["onInspectSeat"] }) {
  const { startup, refusal: scopeRefusal } = useRecoveryOperations();
  const [freshDraft, setFreshDraft] = useState<StartupSelection | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const current = useMemo(() => { try { return selectStartupSeat(rig, seat.nodeId); } catch { return null; } }, [rig, seat.nodeId]);
  const draftValid = !!freshDraft && !!current && sameStartupSelection(freshDraft, current);
  const busy = startup.operationPending || !!scopeRefusal;
  const primary = seat.hasHistory ? "resume" as const : "start" as const;

  const submit = (action: "resume" | "start" | "continue" | "fresh", selection: StartupSelection) => {
    const outcome = startup.submit({ kind: "seat", input: action === "fresh"
      ? { selection, action, consent: consentToFreshStartup(selection) }
      : { selection, action } });
    setRefusal(outcome.ok ? null : outcome.reason);
    if (outcome.ok) setFreshDraft(null);
  };

  return (
    <article data-testid="startup-seat-detail" aria-labelledby="startup-seat-title" className="grid gap-3 border border-outline-variant p-3">
      <header className="grid gap-1">
        <h3 id="startup-seat-title" className="break-words font-mono text-sm text-on-surface">{seat.logicalId}</h3>
        <p className="text-xs text-on-surface-variant">Node <ExactId value={seat.nodeId} /></p>
      </header>
      <FactList testId="startup-seat-facts">
        <Fact label="Runtime" testId="startup-fact-runtime">{seat.runtime ?? <span className="text-warning">Unconfigured — no startup runtime is configured for this seat</span>}</Fact>
        <Fact label="Model">{seat.model ?? "not served"}</Fact>
        <Fact label="Observed" testId="startup-fact-observed">
          <Badge tone={observedTone[seat.observed.state]}>{observedLabel[seat.observed.state]}</Badge>
          {seat.observed.detail ? <span className="ml-2">{seat.observed.detail}</span> : null}
        </Fact>
        <Fact label="Session" testId="startup-fact-session"><ExactId value={seat.observed.sessionName} /></Fact>
        <Fact label="History">{seat.hasHistory ? "present — Resume continues it" : "none — Start begins this seat"}</Fact>
        <Fact label="Forecast" testId="startup-fact-intended">{seat.intendedAction}{seat.reason ? ` · ${seat.reason}` : ""}</Fact>
        <Fact label="Resume token">{seat.tokenState}</Fact>
        <Fact label="Fresh required">{seat.freshRequired ? "yes" : "no"}</Fact>
        <Fact label="Context pending" testId="startup-fact-context">{seat.contextPending === undefined ? "not served" : seat.contextPending ? "yes — startup context was not delivered" : "no"}</Fact>
        <Fact label="Fresh allowed">{seat.freshAllowed === undefined ? "not served" : seat.freshAllowed ? "yes" : "no"}</Fact>
        {seat.prerequisite ? <Fact label="Prerequisite" testId="startup-fact-prerequisite">{seat.prerequisite}</Fact> : null}
      </FactList>
      <Evidence summary="Source evidence · revision and provenance" testId="startup-seat-evidence">
        <FactList>
          <Fact label="Revision"><ExactId value={seat.revision} testId="startup-fact-revision" /></Fact>
          <Fact label="Occupant session">{seat.occupantSessionId ? <ExactId value={seat.occupantSessionId} /> : "none served"}</Fact>
          <Fact label="Provenance">{seat.provenance ?? "none served"}</Fact>
          <Fact label="Last verified">{seat.lastVerified ?? "none served"}</Fact>
          {seat.runtimePrompt ? <Fact label="Runtime prompt"><span className="whitespace-pre-wrap">{seat.runtimePrompt}</span></Fact> : null}
        </FactList>
        <p className="mt-2 text-xs text-on-surface-variant">The revision is consent/version evidence for this seat, not a native conversation ID.</p>
      </Evidence>

      {seat.observed.state === "attention_required" || seat.contextPending ? (
        <Notice tone="warning" title="Native attention" testId="startup-native-attention">
          Resolve trust, login or permission prompts in the native session itself; this page never answers them.
          {seat.contextPending ? " After the native session is ready, Continue sends the saved startup context once for this exact seat." : ""}
        </Notice>
      ) : null}

      <div className="grid gap-2" data-testid="startup-seat-actions">
        {!current ? (
          <Notice tone="warning" title="No startup action for this seat" testId="startup-null-runtime">
            This seat has no configured runtime, so no startup selection can be made. Its facts and sibling seats remain available.
          </Notice>
        ) : (
          <div className="flex flex-wrap gap-2">
            <ActionButton variant="primary" data-testid="startup-action-primary" disabled={busy || refreshing} onClick={() => submit(primary, current)}>
              {actionLabel[primary]}
            </ActionButton>
            {seat.contextPending ? (
              <ActionButton data-testid="startup-action-continue" disabled={busy || refreshing} onClick={() => submit("continue", current)}>Continue</ActionButton>
            ) : null}
            <ActionButton variant="danger" data-testid="startup-action-fresh" aria-expanded={!!freshDraft}
              disabled={busy || refreshing || seat.freshAllowed === false} onClick={() => { setRefusal(null); setFreshDraft(current); }}>
              Choose fresh start…
            </ActionButton>
          </div>
        )}
        {onInspectSeat ? (
          <div>
            <ActionButton variant="quiet" data-testid="startup-inspect-session"
              onClick={() => onInspectSeat({ rigId: rig.rigId, logicalId: seat.logicalId, sessionName: seat.observed.sessionName })}>
              Inspect native session
            </ActionButton>
          </div>
        ) : null}
        {seat.freshAllowed === false ? <p className="text-xs text-on-surface-variant">The daemon reports fresh start is not allowed for this seat.</p> : null}
        {scopeRefusal ? <p data-testid="startup-scope-refusal" className="text-xs text-warning">{scopeRefusal}</p> : null}
        {startup.operationPending ? <p role="status" data-testid="startup-busy" className="text-xs text-on-surface-variant">An action is awaiting its exact result. Help, Back and inspection remain available; leaving does not cancel accepted work.</p> : null}
        {refusal ? <Notice tone="warning" title="Not sent" testId="startup-action-refusal">{refusal}</Notice> : null}
      </div>

      {freshDraft ? (
        <div data-testid="startup-fresh-confirmation" role="group" aria-labelledby="startup-fresh-title" className="grid gap-2 border border-tertiary p-3">
          <p id="startup-fresh-title" className="font-mono text-[10px] uppercase tracking-[0.14em] text-tertiary">Confirm fresh start</p>
          <p className="text-sm text-on-surface">A fresh start does not resume existing history. It applies only to this exact seat, runtime and revision:</p>
          <FactList testId="startup-fresh-identity">
            <Fact label="Rig"><ExactId value={freshDraft.rigId} /></Fact>
            <Fact label="Seat"><ExactId value={freshDraft.logicalId} /></Fact>
            <Fact label="Node"><ExactId value={freshDraft.nodeId} /></Fact>
            <Fact label="Runtime"><ExactId value={freshDraft.runtime} /></Fact>
            <Fact label="Session"><ExactId value={freshDraft.sessionName} /></Fact>
            <Fact label="Revision"><ExactId value={freshDraft.revision} /></Fact>
          </FactList>
          {!draftValid ? (
            <Notice tone="warning" title="Seat changed since this choice" testId="startup-fresh-stale" live="polite">
              The served seat, runtime, session or revision no longer matches. This fresh choice cannot be sent; decline and inspect again.
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <ActionButton variant="danger" data-testid="startup-fresh-confirm" disabled={!draftValid || busy || refreshing} onClick={() => submit("fresh", freshDraft)}>
              Confirm fresh start
            </ActionButton>
            <ActionButton data-testid="startup-fresh-decline" onClick={() => setFreshDraft(null)}>Decline · send nothing</ActionButton>
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ------------------------------------------------------------ attempt receipts

function RigAttempts({ rigId }: { rigId: string }) {
  const { startup } = useRecoveryOperations();
  const rows = startup.records.filter(row => row.attempt.kind === "seat" && row.attempt.selection?.rigId === rigId);
  if (!rows.length) return null;
  return (
    <section aria-labelledby="startup-attempts-label" data-testid="startup-attempts" className="grid gap-2">
      <SectionLabel id="startup-attempts-label">Attempts this session · {rows.length}</SectionLabel>
      {rows.map((record, index) => index === 0 ? <AttemptReceipt key={record.id} record={record} />
        : <Evidence key={record.id} summary={`${record.attempt.payload.action as string} · ${record.attempt.selection?.logicalId} · ${record.status.replace("_", " ")}`}><AttemptReceipt record={record} compact /></Evidence>)}
    </section>
  );
}

const statusTone: Record<StartupAttemptRecord["status"], RecoveryTone> = { pending: "info", succeeded: "success", rejected: "warning", outcome_unknown: "error" };
const statusLabel: Record<StartupAttemptRecord["status"], string> = { pending: "awaiting result", succeeded: "daemon ok", rejected: "refused before effect", outcome_unknown: "outcome unknown" };

function attemptTitle(record: StartupAttemptRecord): string {
  const { attempt } = record;
  if (attempt.kind === "seat") return `${actionLabel[attempt.payload.action as keyof typeof actionLabel] ?? String(attempt.payload.action)} · ${attempt.selection?.logicalId}`;
  if (attempt.kind === "kernel") return `Prepare kernel · ${String(attempt.payload.runtime)}`;
  return "Start terminal service";
}

export function AttemptReceipt({ record, compact = false }: { record: StartupAttemptRecord; compact?: boolean }) {
  const { startup, connectionKey } = useRecoveryOperations();
  const [rereadRefusal, setRereadRefusal] = useState<string | null>(null);
  const { attempt, error, receipt, readback } = record;
  const foreign = record.connectionKey !== connectionKey;
  const selection = attempt.selection;
  return (
    <div data-testid="startup-receipt" data-status={record.status} className={cn("grid gap-2 border p-3", record.status === "outcome_unknown" ? "border-tertiary" : "border-outline-variant")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-on-surface">{attemptTitle(record)}</span>
        <Badge tone={statusTone[record.status]} testId="startup-receipt-status">{statusLabel[record.status]}</Badge>
        <span className="font-mono text-[9px] text-on-surface-variant">
          submitted <RecoveryStamp iso={record.submittedAt} testId="startup-receipt-submitted" />
          {record.settledAt ? <> · settled <RecoveryStamp iso={record.settledAt} testId="startup-receipt-settled" /></> : null}
        </span>
      </div>
      {foreign ? (
        <Notice tone="warning" title="Sent to a different connected instance" testId="startup-receipt-foreign">
          This attempt was submitted to <ExactId value={record.connectionKey} />. It is kept for inspection and is not read back against the current instance.
        </Notice>
      ) : null}
      {selection && !compact ? (
        <FactList testId="startup-receipt-identity">
          <Fact label="Rig"><ExactId value={selection.rigId} /></Fact>
          <Fact label="Seat"><ExactId value={selection.logicalId} /></Fact>
          <Fact label="Node"><ExactId value={selection.nodeId} /></Fact>
          <Fact label="Runtime"><ExactId value={selection.runtime} /></Fact>
          <Fact label="Session"><ExactId value={selection.sessionName} /></Fact>
          <Fact label="Revision"><ExactId value={selection.revision} /></Fact>
        </FactList>
      ) : null}
      {record.status === "pending" ? (
        <p role="status" className="text-sm text-on-surface">Submitted once. Waiting for the daemon&apos;s exact result; navigating away does not cancel it.</p>
      ) : null}
      {record.status === "succeeded" && receipt ? (
        <p className="text-sm text-on-surface" data-testid="startup-receipt-ok">
          Daemon returned ok{receipt.result.code ? <> · <ExactId value={receipt.result.code} /></> : null}{receipt.result.message ? ` — ${receipt.result.message}` : ""}.
          {attempt.kind === "kernel" && typeof receipt.result.rigId === "string" ? <> Kernel rig <ExactId value={receipt.result.rigId} /> is selected for inspection{receipt.result.reused ? " (existing kernel reused)" : ""}.</> : null}
        </p>
      ) : null}
      {record.status === "rejected" && error ? (
        <Notice tone="warning" title={error.serverCode === "selection_changed" || error.serverCode === "binding_changed" ? "Seat changed before effect" : "Refused before effect"} testId="startup-receipt-rejected">
          {error.message}
          <span className="mt-1 block font-mono text-[10px] text-on-surface-variant">{error.serverCode ? `code ${error.serverCode}` : `code ${error.code}`}{error.status ? ` · HTTP ${error.status}` : ""}</span>
          {error.serverCode === "selection_changed" || error.serverCode === "binding_changed" ? <span className="mt-1 block">The rig was read again. Inspect the current seat and make a new choice; the old choice is not resent.</span> : null}
        </Notice>
      ) : null}
      {record.status === "outcome_unknown" ? (
        <Notice tone="error" title="Outcome unknown · not retried" testId="startup-receipt-unknown" live="assertive">
          {error?.message ?? "The response was lost."} The daemon may already have started the native process (for example one now waiting on
          trust, login or context). This attempt is retained as submitted; nothing is resent and Fresh is never chosen automatically.
          {error?.serverCode || error?.status ? <span className="mt-1 block font-mono text-[10px] text-on-surface-variant">{error.serverCode ? `code ${error.serverCode}` : ""}{error.status ? ` · HTTP ${error.status}` : ""}</span> : null}
        </Notice>
      ) : null}
      {readback ? <Readback record={record} /> : null}
      {attempt.kind === "seat" && record.status !== "pending" ? (
        <div className="grid gap-1">
          <div><ActionButton variant="quiet" data-testid="startup-receipt-reread" disabled={readback?.state === "reading" || foreign}
            onClick={() => { const outcome = startup.reread(record.id); setRereadRefusal(outcome.ok ? null : outcome.reason); }}>Read back exact seat</ActionButton></div>
          {rereadRefusal ? <p className="text-xs text-warning" data-testid="startup-reread-refusal">{rereadRefusal}</p> : null}
        </div>
      ) : null}
      {!compact && (receipt || error?.details !== undefined) ? (
        <Evidence summary="Served response body">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-on-surface">{JSON.stringify(receipt?.result ?? error?.details, null, 2)}</pre>
        </Evidence>
      ) : null}
    </div>
  );
}

function Readback({ record }: { record: StartupAttemptRecord }) {
  const readback = record.readback!;
  if (readback.state === "reading") return <p role="status" className="text-xs text-on-surface-variant">Reading the exact seat back…</p>;
  if (readback.state === "failed") return <Notice tone="warning" title="Readback unavailable" testId="startup-readback-failed">{readback.message} The attempt outcome remains as shown.</Notice>;
  if (readback.state === "deferred") {
    return (
      <Notice tone="warning" title="Readback not taken" testId="startup-readback-deferred">
        {readback.reason} The seat is read back only from the instance this attempt was sent to; the receipt above is unchanged.
      </Notice>
    );
  }
  const selection = record.attempt.selection!;
  return (
    <div data-testid="startup-readback" className="grid gap-1 border-l-2 border-outline-variant pl-3 text-sm">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">Seat now · read <RecoveryStamp iso={readback.at} testId="startup-readback-at" /></p>
      {!readback.seat ? (
        <p data-testid="startup-readback-absent" className="text-warning">Node <ExactId value={selection.nodeId} /> is absent from rig {readback.rigName}.</p>
      ) : (
        <>
          <p><Badge tone={observedTone[readback.seat.observed.state]}>{observedLabel[readback.seat.observed.state]}</Badge>{readback.seat.observed.detail ? ` ${readback.seat.observed.detail}` : ""}</p>
          {readback.selectionChanged ? <p data-testid="startup-readback-changed" className="text-warning">Seat identity or revision changed since submission. A new action requires a new inspected choice.</p>
            : <p className="text-on-surface-variant">Seat identity and revision unchanged.</p>}
          {readback.seat.contextPending ? <p data-testid="startup-readback-context">Context pending — after resolving native prompts, Continue is available for this exact seat.</p> : null}
        </>
      )}
    </div>
  );
}

function StartupHelp() {
  return (
    <Evidence summary="Help · how startup actions behave" testId="startup-help">
      <ul className="grid list-disc gap-1 pl-4 text-sm text-on-surface">
        <li>Resume continues served history; Start begins a seat without history. Neither falls back to Fresh.</li>
        <li>Fresh is confirmed against the exact seat, runtime, session and revision. Any change invalidates the confirmation; declining sends nothing.</li>
        <li>Continue appears only when the daemon serves pending startup context, and sends it once.</li>
        <li>An unknown outcome (lost response, 409 attention) may follow native effects. Read the seat back before choosing again.</li>
        <li>Leaving this page does not cancel accepted daemon work. The browser cannot start a stopped daemon; use the CLI on its host.</li>
      </ul>
    </Evidence>
  );
}
