// Selected-agent workspace for the 3D topology (Night Atelier).
//
// Selecting an exact seat opens ONE live terminal here immediately — no
// "open terminal" gate — beside its served state: identity, a compact work
// summary, and Work / Evidence / Relationships tabs. Contract:
// docs/plans/spatial-redesign-terminal-contract.md.
//
// Terminal admission (spatial-terminal-admission.ts): a CURRENT node-detail
// read must confirm the exact host/rig/node/logical id/canonical session, an
// actual tmux attachment with a registered pane and no applicable native
// identity failure before the viewer mounts. The admitted pane is pinned. A
// later failed read, identity/pane change or failed reconnect check closes the
// viewer and refuses until the operator retries (a fresh read) or reselects;
// every open after the first — socket reconnect or cap Reconnect — re-reads
// through FocusedTerminal's beforeConnect seam, so a stale check never connects. The viewer is keyed by that admitted identity and
// takes one slot of the shared live-terminal cap: a seat switch, a source
// change, an observed identity change or closing the workspace closes the old
// socket and frees the slot first. Opening sends nothing — no text, keys,
// Enter, launch or restore; the operator types into the pane themselves.
// Remote sources stay read-only with an explanation. All content is served
// state; anything unknown says so.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { hashKey, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, Crosshair, RotateCcw, X } from "lucide-react";
import { FocusedTerminal } from "../../terminal/FocusedTerminal.js";
import { useLiveTerminal } from "../../terminal/LiveTerminalProvider.js";
import { RuntimeMark } from "../../graphics/RuntimeMark.js";
import { DisplayTime } from "../../time/DisplayTime.js";
import { readNodeDetail } from "../../../lib/node-library-reads.js";
import { formatRuntimeModel, runtimeBrand } from "../../../lib/runtime-brand.js";
import { shortQitemTail } from "../../../lib/activity-visuals.js";
import type { SpatialAgent, SpatialModel, SpatialSeatStatus } from "../../../lib/spatial-topology.js";
import type { TopologyScope } from "../../../lib/topology-location.js";
import { cn } from "../../../lib/utils.js";
import { TopologyLink, topologyTarget } from "../topology-navigation.js";
import { hslCss, type SpatialPalette } from "./spatial-palette.js";
import {
  admittedSeatKey,
  changedSeatRefusal,
  precheckSeat,
  revalidateAdmittedSeat,
  sameAdmittedSeat,
  verifySeatDetail,
  type AdmissionVerdict,
  type AdmittedSeat,
} from "./spatial-terminal-admission.js";

/** Structural view of the shared activity state (lib/spatial-activity.ts,
 *  SpatialTrafficState): only what the workspace reads. */
export interface WorkspaceTrafficRecord {
  id: string;
  sourceKey: string;
  targetKey: string;
  type: string;
  label: string;
  occurredAt: number;
  qitemId?: string;
}
export interface WorkspaceActivity {
  records: readonly WorkspaceTrafficRecord[];
  connected: boolean;
  reconnecting: boolean;
  unavailableReason: string | null;
  unplacedCount: number;
}

const MAX_EVENTS = 12;

export interface SpatialAgentWorkspaceProps {
  agent: SpatialAgent;
  model: SpatialModel;
  status: SpatialSeatStatus;
  palette: SpatialPalette;
  /** The selected (source) host the model was read from. */
  hostId: string;
  isRemote: boolean;
  linkSource: string | null;
  from: TopologyScope;
  canFocus: boolean;
  onFocus: (key: string) => void;
  onSelect: (key: string) => void;
  onClose: () => void;
  /** Observed traffic and feed status, when the activity feed is composed. */
  activity?: WorkspaceActivity | null;
  /** side = beside the scene (wide); stacked = under it (phone / tablet). */
  layout: "side" | "stacked";
}

/** Current canonical detail for this exact selection: a fresh read on every
 *  selection (not the 30s graph cache), kept current while open. The read
 *  SeatLiveTerminal admits from; shared with the phone graph's terminal. */
export function useSeatDetailQuery(agent: SpatialAgent, hostId: string) {
  const detailKey = useMemo(
    () => ["spatial", "seat-detail", hostId, agent.rigId, agent.logicalId, agent.nodeId] as const,
    [hostId, agent.rigId, agent.logicalId, agent.nodeId],
  );
  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => readNodeDetail(agent.rigId, agent.logicalId, hostId, { signal }),
    enabled: agent.logicalId !== null,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchInterval: 30_000,
    retry: false,
    placeholderData: undefined,
  });
  return { detailKey, detailQuery };
}

export function SpatialAgentWorkspace(props: SpatialAgentWorkspaceProps) {
  const { agent, model, status, palette, hostId, isRemote, layout } = props;
  const tone = hslCss(palette.tones[status.tone]);
  const pod = agent.podKey ? model.podsByKey.get(agent.podKey) ?? null : null;

  const { detailKey, detailQuery } = useSeatDetailQuery(agent, hostId);
  const detail = detailQuery.data as Record<string, unknown> | undefined;

  const [detailsOpen, setDetailsOpen] = useState(layout === "side");
  const detailsId = useId();
  const stacked = layout === "stacked";

  const qitems = agent.currentQitems;
  const contextKnown = typeof agent.contextUsedPercentage === "number";

  return (
    <section
      data-testid="spatial-workspace"
      data-layout={layout}
      data-agent-key={agent.key}
      aria-label={`Selected seat ${agent.displayName}`}
      className="spatial-workspace flex min-w-0 flex-col"
    >
      {/* Compact identity band (~120px): portrait, name, runtime/role,
          rig/pod, one status line and the seat actions, so the live terminal
          starts above the fold. Full status evidence is in Evidence. */}
      <header data-testid="spatial-workspace-header" className="flex items-start gap-3 px-4 pb-2 pt-3">
        <div data-testid="spatial-workspace-portrait" className="spatial-portrait flex h-10 w-10 shrink-0 items-center justify-center" title={agent.nodeKind === "infrastructure" ? "Infrastructure seat" : runtimeLabel(agent)}>
          <RuntimeMark runtime={agent.nodeKind === "infrastructure" ? "terminal" : agent.runtime} size="md" title={agent.nodeKind === "infrastructure" ? "Infrastructure" : runtimeLabel(agent)} />
        </div>
        <div className="min-w-0 flex-1">
          <h2
            data-testid="spatial-inspector-name"
            tabIndex={-1}
            className="truncate font-headline text-lg font-bold leading-tight text-on-surface outline-none focus-visible:underline"
            title={agent.logicalId ?? agent.nodeId}
          >
            {agent.displayName}
          </h2>
          <div data-testid="spatial-workspace-context" className="truncate font-mono text-[10.5px] text-on-surface-variant">
            {agent.nodeKind === "infrastructure" ? "Infrastructure" : runtimeLabel(agent)}
            {agent.role ? ` · ${agent.role}` : ""}
            {" · "}{agent.rigName} / {pod?.label ?? agent.podNamespace ?? "no pod"}
            {isRemote ? <span> · {hostId} (remote, read-only)</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {agent.logicalId ? (
            <TopologyLink
              data-testid="spatial-open-seat"
              target={topologyTarget({ scope: { kind: "seat", rigId: agent.rigId, logicalId: agent.logicalId }, sourceHost: props.linkSource })}
              from={props.from}
              unavailableTitle="This seat's identity cannot be represented in a link."
              title="Open the seat page"
              className="spatial-hud-button touch-target !h-8 !px-2"
            >
              Open <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
            </TopologyLink>
          ) : null}
          <button
            type="button"
            data-testid="spatial-focus-seat"
            aria-label="Focus the camera on this seat"
            title="Focus the camera on this seat"
            disabled={!props.canFocus}
            onClick={() => props.onFocus(agent.key)}
            className="spatial-hud-button touch-target !w-8 !px-0"
          >
            <Crosshair aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="spatial-workspace-close"
            aria-label="Close seat workspace"
            title="Close (the agent keeps running)"
            onClick={props.onClose}
            className="spatial-hud-button touch-target !w-8 !px-0"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div
        data-testid="spatial-inspector-status"
        className="mx-4 flex min-w-0 items-center gap-2 border-l-2 py-0.5 pl-2 font-mono text-[10.5px]"
        style={{ borderColor: tone }}
        title={`${status.label} · ${status.live ? "current" : "not live"} · ${status.evidence}`}
      >
        <span aria-hidden="true" data-tone={status.tone} className={cn("spatial-mark", status.stale && "is-stale")} style={{ "--spatial-tone": tone } as React.CSSProperties} />
        <span className="shrink-0 text-on-surface">{status.label}</span>
        {status.problems.length > 0 ? <span className="shrink-0 text-tertiary">{status.problems.length} problem{status.problems.length === 1 ? "" : "s"}</span> : null}
        <span className="min-w-0 truncate text-on-surface-variant">
          {status.live ? "current · " : "not live · "}
          {status.evidence}
          {status.sampleAge ? ` · sample ${status.sampleAge} old` : status.live ? " · sample time not reported" : ""}
        </span>
      </div>

      {status.problems.length > 0 ? (
        // Problems (identity mismatch, failed startup) stay in view, above the terminal.
        <ul data-testid="spatial-inspector-problems" className="mx-4 mt-1.5 space-y-1">
          {status.problems.map((p) => <li key={p} className="spatial-problem px-2 py-1 font-mono text-[10px]">{p}</li>)}
        </ul>
      ) : null}

      {/* Keyed by the selected graph entry: a reselection starts admission over. */}
      <SeatLiveTerminal key={`${hostId}|${agent.rigId}|${agent.nodeId}`} agent={agent} hostId={hostId} isRemote={isRemote} detailKey={detailKey} detailQuery={detailQuery} layout={layout} />

      <dl data-testid="spatial-workspace-summary" className="mx-4 mt-3 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] border border-outline-variant font-mono text-[11px]">
        <SummaryCell label="Queue">
          {agent.pendingWorkCount > 0 ? `${agent.pendingWorkCount} queued` : agent.hasAssignedWork ? "assigned" : "none queued"}
        </SummaryCell>
        <SummaryCell label="Context">
          {contextKnown ? `${Math.round(agent.contextUsedPercentage!)}%${agent.contextFresh ? "" : " (stale)"}` : "not reported"}
        </SummaryCell>
        <SummaryCell label="Current task" wide>
          {qitems[0] ? <span title={qitems[0].qitemId}>{qitems[0].bodyExcerpt || `…${shortQitemTail(qitems[0].qitemId)}`}</span> : "none in progress"}
        </SummaryCell>
      </dl>

      <div className="mx-4 mb-4 mt-3 border border-outline-variant">
        <button
          type="button"
          data-testid="spatial-workspace-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
          className="flex min-h-11 w-full items-center gap-2 px-3 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface"
        >
          <ChevronDown aria-hidden="true" className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", !detailsOpen && "-rotate-90")} />
          Details
        </button>
        <div id={detailsId} hidden={!detailsOpen}>
          {detailsOpen ? (
            <WorkspaceTabs
              agent={agent}
              model={model}
              status={status}
              detail={detail}
              detailError={detailQuery.error}
              activity={props.activity}
              isRemote={isRemote}
              onSelect={props.onSelect}
              compact={stacked}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Runtime as served: a known brand's label, otherwise the supplied runtime
 *  string itself (e.g. the first-class "stub" runtime) under the neutral mark;
 *  "not reported" only when no runtime was served. Never inferred from the
 *  model or a label. */
function runtimeLabel(agent: SpatialAgent): string {
  const brand = runtimeBrand(agent.runtime);
  if (brand.id !== "unknown") return brand.label;
  const supplied = agent.runtime?.trim();
  return supplied ? supplied : "Runtime not reported";
}

function SummaryCell({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn("min-w-0 border-outline-variant px-3 py-2 [&:not(:first-child)]:border-l", wide && "col-span-full sm:col-span-1")}>
      <dt className="text-[9px] uppercase tracking-[0.14em] text-on-surface-variant">{label}</dt>
      <dd className="mt-0.5 truncate text-on-surface">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live terminal dock
// ---------------------------------------------------------------------------

type DetailQuery = Pick<UseQueryResult<unknown>, "data" | "error" | "status" | "dataUpdatedAt" | "errorUpdatedAt" | "errorUpdateCount" | "refetch">;
type Refusal = Extract<AdmissionVerdict, { ok: false }>;

/** Dock admission state for ONE selected graph entry (the dock is keyed by
 *  host/rig/node, so reselection starts over).
 *  - pending: waiting for a current read outcome.
 *  - admitted: one viewer pinned to this exact attachment (pane included).
 *  - refused: `sticky` once anything was admitted for this selection — an
 *    observed change, a failed current read or a revoked reconnect is never
 *    silently re-admitted by a later automatic refresh; only the operator's
 *    Retry (which evaluates its own fresh read) or reselection can admit. */
type DockState =
  | { kind: "pending"; retrying: boolean }
  | { kind: "admitted"; seat: AdmittedSeat; id: number }
  | { kind: "refused"; refusal: Refusal; sticky: boolean };

/** Outcome of a CURRENT read: a failed latest read refuses even when an older
 *  successful payload is still cached for informational display. */
function readOutcome(agent: SpatialAgent, hostId: string, result: { status: string; data: unknown; error: unknown }): AdmissionVerdict | null {
  if (result.status === "error") {
    const message = result.error instanceof Error ? result.error.message : "read failed";
    return { ok: false, kind: "unreadable", reason: `The current seat detail could not be read (${message}), so the seat's identity cannot be confirmed.` };
  }
  if (result.data === undefined) return null;
  return verifySeatDetail(agent, hostId, result.data);
}

interface DockMachine {
  dock: DockState;
  /** Stamp of the last automatic outcome applied (read result + identity). */
  stamp: string;
  everAdmitted: boolean;
  nextId: number;
}

function resultStampOf(r: { status: string; dataUpdatedAt: number; errorUpdatedAt: number; errorUpdateCount: number }): string {
  return `${r.status}:${r.dataUpdatedAt}:${r.errorUpdatedAt}:${r.errorUpdateCount}`;
}

function identityStampOf(agent: SpatialAgent): string {
  return `${agent.hostId}|${agent.rigId}|${agent.nodeId}|${agent.logicalId ?? ""}|${agent.canonicalSessionName ?? ""}`;
}

/** Pure transition for one current outcome (see DockState rules). */
function transition(m: DockMachine, outcome: AdmissionVerdict | null, explicit: boolean): DockMachine {
  const prev = m.dock;
  if (outcome === null) return m;
  if (prev.kind === "refused" && prev.sticky && !explicit) return m;
  if (prev.kind === "pending" && prev.retrying && !explicit) return m;
  if (!outcome.ok) {
    if (prev.kind === "refused" && prev.sticky === m.everAdmitted && prev.refusal.kind === outcome.kind && prev.refusal.reason === outcome.reason) return m;
    return { ...m, dock: { kind: "refused", refusal: outcome, sticky: m.everAdmitted } };
  }
  if (prev.kind === "admitted") {
    if (sameAdmittedSeat(prev.seat, outcome.seat)) return m;
    if (!explicit) return { ...m, dock: { kind: "refused", refusal: changedSeatRefusal(prev.seat, outcome.seat), sticky: true } };
  }
  return { ...m, everAdmitted: true, nextId: m.nextId + 1, dock: { kind: "admitted", seat: outcome.seat, id: m.nextId } };
}

export function SeatLiveTerminal({ agent, hostId, isRemote, detailKey, detailQuery, layout }: {
  agent: SpatialAgent;
  hostId: string;
  isRemote: boolean;
  detailKey: readonly unknown[];
  detailQuery: DetailQuery;
  layout: "side" | "stacked";
}) {
  const precheck = precheckSeat(agent, hostId, isRemote);
  const [machine, setMachine] = useState<DockMachine>({ dock: { kind: "pending", retrying: false }, stamp: "", everAdmitted: false, nextId: 1 });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Automatic outcomes — every new current read result and every identity
  // change of the selected entry (a refreshed graph reporting another
  // session) — are applied during render, so the commit that delivers a
  // failed read or a changed pane is the commit that closes the viewer.
  // Read the cache's CURRENT state (what the dispatch listener below also
  // sees), never a lagging observer snapshot: an older result must not be
  // re-applied over a newer admission.
  const queryClient = useQueryClient();
  const detailHash = hashKey(detailKey);
  const cached = queryClient.getQueryState(detailKey);
  const latest = cached
    ? { status: cached.status, data: cached.data, error: cached.error, dataUpdatedAt: cached.dataUpdatedAt, errorUpdatedAt: cached.errorUpdatedAt, errorUpdateCount: cached.errorUpdateCount }
    : { status: "pending", data: undefined, error: null, dataUpdatedAt: 0, errorUpdatedAt: 0, errorUpdateCount: 0 };
  const stamp = precheck ? "" : `${resultStampOf(latest)}#${identityStampOf(agent)}`;
  let current = machine;
  if (stamp && machine.stamp !== stamp) {
    current = { ...transition(machine, readOutcome(agent, hostId, latest), false), stamp };
    setMachine(current);
  }
  const state = current.dock;

  const agentRef = useRef(agent);
  agentRef.current = agent;
  const precheckRef = useRef(precheck);
  precheckRef.current = precheck;

  // The query cache dispatches a settled read synchronously; observers are
  // notified on a later tick. Applying the dispatch here means a failed or
  // changed current read closes the viewer immediately, not one tick later.
  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryHash !== detailHash) return;
    if (event.action.type !== "success" && event.action.type !== "error") return;
    if (precheckRef.current || !mountedRef.current) return;
    const st = event.query.state;
    const next = `${resultStampOf({ status: st.status, dataUpdatedAt: st.dataUpdatedAt, errorUpdatedAt: st.errorUpdatedAt, errorUpdateCount: st.errorUpdateCount })}#${identityStampOf(agentRef.current)}`;
    setMachine((m) => (m.stamp === next ? m : { ...transition(m, readOutcome(agentRef.current, hostId, st), false), stamp: next }));
  }), [queryClient, detailHash, hostId]);

  /** Operator Retry: a fresh read whose own result decides admission. */
  const retry = useCallback(async () => {
    setMachine((m) => ({ ...m, dock: { kind: "pending", retrying: true } }));
    const result = await detailQuery.refetch();
    if (!mountedRef.current) return;
    const outcome = readOutcome(agentRef.current, hostId, result)
      ?? { ok: false as const, kind: "unreadable" as const, reason: "The current seat detail could not be read." };
    setMachine((m) => transition(m, outcome, true));
  }, [detailQuery, hostId]);

  /** A reconnect/resume check found the admitted attachment no longer
   *  current: close the viewer and refuse until the operator retries. Only
   *  the admission that issued the check may revoke. */
  const revoke = useCallback((id: number, refusal: Refusal) => {
    if (!mountedRef.current) return;
    setMachine((m) => (m.dock.kind === "admitted" && m.dock.id === id ? { ...m, dock: { kind: "refused", refusal, sticky: true } } : m));
  }, []);

  const seat = !precheck && state.kind === "admitted" ? state.seat : null;
  const refusal: Refusal | null = precheck && !precheck.ok ? precheck : state.kind === "refused" ? state.refusal : null;
  const canRetry = !precheck && refusal !== null;

  return (
    <div data-testid="spatial-terminal-dock" className="mx-4 mt-2 border border-outline-variant bg-[hsl(var(--spatial-terminal-ground))]">
      <div className="flex items-center gap-2 border-b border-outline-variant px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">
        <span className="min-w-0 flex-1 truncate">Live terminal · {agent.displayName}</span>
        {seat ? <span className="truncate normal-case tracking-normal" title={`${seat.session} ${seat.pane}`}>{seat.session}</span> : null}
      </div>
      {seat && state.kind === "admitted" ? (
        <AdmittedTerminal
          key={state.id}
          seat={seat}
          agent={agent}
          layout={layout}
          onRevoked={(r) => revoke(state.id, r)}
        />
      ) : !refusal ? (
        <p data-testid="spatial-terminal-state" data-state="verifying" role="status" className="px-3 py-6 font-mono text-[11px] text-on-surface-variant">
          Verifying this seat&apos;s identity and tmux attachment…
        </p>
      ) : (
        <div data-testid="spatial-terminal-state" data-state={refusal.kind} role={refusal.kind === "unreadable" || refusal.kind === "changed" ? "alert" : "status"} className="px-3 py-4 font-mono text-[11px] leading-relaxed text-on-surface-variant">
          <p>{refusal.kind === "remote" ? "Live terminal unavailable for a remote source." : "Live terminal unavailable."}</p>
          <p className="mt-1 text-on-surface">{refusal.reason}</p>
          {canRetry ? (
            <button type="button" data-testid="spatial-terminal-retry" onClick={() => void retry()} className="spatial-hud-button mt-2 !h-8 !px-3">
              <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /> Retry
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AdmittedTerminal({ seat, agent, layout, onRevoked }: {
  seat: AdmittedSeat;
  agent: SpatialAgent;
  layout: "side" | "stacked";
  onRevoked: (refusal: Refusal) => void;
}) {
  const live = useLiveTerminal();
  const key = admittedSeatKey(seat);
  const [evicted, setEvicted] = useState(false);
  const [epoch, setEpoch] = useState(0);

  // One slot of the shared cap per admitted attachment. Leaving (switch,
  // close, refusal, unmount) frees it; another terminal taking it reverts
  // this dock to an honest "released" state instead of a dead pane.
  useEffect(() => {
    if (evicted) return undefined;
    live.requestLive(key, () => setEvicted(true));
    return () => live.release(key);
  }, [live, key, evicted, epoch]);

  // Latest values for the async admission check (never a remount trigger).
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const onRevokedRef = useRef(onRevoked);
  onRevokedRef.current = onRevoked;
  // The admission read that created this viewer is current for its FIRST
  // connect only. Every later open — socket reconnect, cap Reconnect — reads
  // current detail again, however recent the admission was.
  const initialConnectUsedRef = useRef(false);
  const beforeConnect = useCallback(async ({ reconnect }: { reconnect: boolean }): Promise<true | { refuse: string }> => {
    if (!reconnect && !initialConnectUsedRef.current) {
      initialConnectUsedRef.current = true;
      return true;
    }
    const current = agentRef.current;
    const revokeWith = (refusal: Refusal) => { onRevokedRef.current(refusal); return { refuse: refusal.reason }; };
    if (!current.logicalId) return revokeWith({ ok: false, kind: "no-logical-id", reason: "The seat no longer has a logical id; select it again." });
    let fresh: unknown;
    try {
      fresh = await readNodeDetail(seat.rigId, current.logicalId, seat.hostId);
    } catch (err) {
      return revokeWith({ ok: false, kind: "unreadable", reason: `The current seat detail could not be read (${err instanceof Error ? err.message : "read failed"}), so the viewer was not reopened.` });
    }
    const verdict = revalidateAdmittedSeat(seat, current, fresh);
    if (verdict === true) return true;
    return revokeWith({ ok: false, kind: "changed", reason: verdict.refuse });
  }, [seat]);
  // The server ended this viewer for good (session terminated, broker
  // failure): free the slot and refuse until the operator retries, instead
  // of keeping a dead pane that still holds a live-terminal slot.
  const onClosed = useCallback((reason: string) => {
    onRevokedRef.current({ ok: false, kind: "closed", reason: `The terminal connection was closed (${reason}). Retry reads the seat again before reattaching.` });
  }, []);

  if (evicted) {
    return (
      <div data-testid="spatial-terminal-state" data-state="released" role="status" className="px-3 py-4 font-mono text-[11px] leading-relaxed text-on-surface-variant">
        <p>This live viewer was released because another terminal took the shared live-terminal slot. The agent is unaffected.</p>
        <button
          type="button"
          data-testid="spatial-terminal-reconnect"
          onClick={() => { setEvicted(false); setEpoch((n) => n + 1); }}
          className="spatial-hud-button mt-2 !h-8 !px-3"
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /> Reconnect
        </button>
      </div>
    );
  }
  return (
    <div
      data-testid="spatial-terminal-live"
      data-terminal-key={key}
      data-terminal-pane={seat.pane}
      className={cn("spatial-terminal-frame min-w-0", layout === "stacked" ? "spatial-terminal-frame--stacked" : "spatial-terminal-frame--side")}
    >
      <FocusedTerminal
        key={epoch}
        sessionName={seat.session}
        fit="contain"
        autoFocus={false}
        beforeConnect={beforeConnect}
        onClosed={onClosed}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Work / Evidence / Relationships
// ---------------------------------------------------------------------------

const TABS = [
  { id: "work", label: "Work" },
  { id: "evidence", label: "Evidence" },
  { id: "relationships", label: "Relationships" },
] as const;
type TabId = typeof TABS[number]["id"];

function WorkspaceTabs({ agent, model, status, detail, detailError, activity, isRemote, onSelect, compact }: {
  agent: SpatialAgent;
  model: SpatialModel;
  status: SpatialSeatStatus;
  detail: Record<string, unknown> | undefined;
  detailError: unknown;
  activity: WorkspaceActivity | null | undefined;
  isRemote: boolean;
  onSelect: (key: string) => void;
  compact: boolean;
}) {
  const [tab, setTab] = useState<TabId>("work");
  const baseId = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    setTab(TABS[next]!.id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  };
  return (
    <div className="border-t border-outline-variant">
      <div role="tablist" aria-label="Seat details" onKeyDown={onKeyDown} className="flex border-b border-outline-variant">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${baseId}-${t.id}`}
            data-testid={`spatial-workspace-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-${t.id}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={cn(
              "min-h-11 flex-1 border-b-2 px-2 font-mono text-[11px] text-on-surface-variant",
              tab === t.id ? "border-[hsl(var(--primary))] text-on-surface" : "border-transparent hover:text-on-surface",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-${tab}-panel`} aria-labelledby={`${baseId}-${tab}`} className={cn("px-3 py-3", compact && "text-[11px]")}>
        {tab === "work" ? <WorkPanel agent={agent} detail={detail} /> : null}
        {tab === "evidence" ? <EvidencePanel agent={agent} model={model} status={status} detail={detail} detailError={detailError} activity={activity} isRemote={isRemote} /> : null}
        {tab === "relationships" ? <RelationshipsPanel agent={agent} model={model} onSelect={onSelect} /> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1">
      <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-[11px] text-on-surface">{children}</dd>
    </div>
  );
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function WorkPanel({ agent, detail }: { agent: SpatialAgent; detail: Record<string, unknown> | undefined }) {
  const contextKnown = typeof agent.contextUsedPercentage === "number";
  return (
    <div data-testid="spatial-workspace-work">
      <dl>
        <Field label="Runtime">
          {runtimeBrand(agent.runtime).id === "unknown" && agent.runtime
            ? `${agent.runtime}${agent.model ? ` / ${agent.model}` : ""}`
            : agent.runtime || agent.model ? formatRuntimeModel(agent.runtime, agent.model) : "not reported"}
        </Field>
        {agent.role ? <Field label="Role">{agent.role}</Field> : null}
        <Field label="Logical id">{agent.logicalId ?? `none (graph node ${agent.nodeId})`}</Field>
        <Field label="Session">{agent.canonicalSessionName ?? "none recorded"}</Field>
        <Field label="Session state">{agent.sessionStatus ?? "unknown"}</Field>
        <Field label="Startup">{agent.startupStatus ?? "unknown"}</Field>
        <Field label="Context">{contextKnown ? `${Math.round(agent.contextUsedPercentage!)}% used${agent.contextFresh ? "" : " · stale sample"}` : "not reported"}</Field>
        <Field label="Queue">{agent.pendingWorkCount > 0 ? `${agent.pendingWorkCount} pending` : agent.hasAssignedWork ? "assigned" : "none queued"}</Field>
        {str(detail?.cwd) ? <Field label="Working dir">{str(detail?.cwd)}</Field> : null}
      </dl>
      <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">In progress</div>
      {agent.currentQitems.length === 0 ? (
        <p className="mt-1 font-mono text-[10px] italic text-on-surface-variant">No queue items in progress.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {agent.currentQitems.map((q) => (
            <li key={q.qitemId} className="font-mono text-[11px] text-on-surface" title={q.qitemId}>
              <span className="text-on-surface-variant">…{shortQitemTail(q.qitemId)}</span> {q.bodyExcerpt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EvidencePanel({ agent, model, status, detail, detailError, activity, isRemote }: {
  agent: SpatialAgent;
  model: SpatialModel;
  status: SpatialSeatStatus;
  detail: Record<string, unknown> | undefined;
  detailError: unknown;
  activity: WorkspaceActivity | null | undefined;
  isRemote: boolean;
}) {
  const observed = useMemo(
    () => (activity?.records ?? [])
      .filter((r) => r.sourceKey === agent.key || r.targetKey === agent.key)
      .slice()
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, MAX_EVENTS),
    [activity, agent.key],
  );
  const served = Array.isArray(detail?.recentEvents)
    ? (detail!.recentEvents as Array<{ type?: unknown; createdAt?: unknown }>)
      .filter((e) => typeof e?.type === "string")
      .slice(0, MAX_EVENTS)
    : [];
  const latestError = str(detail?.latestError);
  const feedStatus = isRemote
    ? "Live traffic is not streamed from remote sources."
    : !activity
      ? "Live traffic feed is not connected in this view."
      : activity.unavailableReason
        ? `Live traffic unavailable: ${activity.unavailableReason}`
        : activity.reconnecting
          ? "Live traffic feed reconnecting — no pulses until it is back."
          : activity.connected
            ? "Live traffic feed connected."
            : "Live traffic feed not connected.";
  return (
    <div data-testid="spatial-workspace-evidence" className="space-y-3">
      <div>
        <div className="font-mono text-[11px] text-on-surface">{status.label}{status.stale ? " · stale sample" : ""}</div>
        <div className="font-mono text-[10px] text-on-surface-variant">
          {status.live ? "current · " : "not live · "}{status.evidence}
          {status.sampleAge ? ` · sample ${status.sampleAge} old` : status.live ? " · sample time not reported" : ""}
        </div>
      </div>
      {latestError ? <p className="spatial-problem px-2 py-1 font-mono text-[10px]">Latest error: {latestError}</p> : null}

      <section aria-label="Observed traffic">
        <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">Observed traffic</div>
        <p data-testid="spatial-workspace-feed-status" className="mt-1 font-mono text-[10px] text-on-surface-variant">
          {feedStatus}
          {activity && activity.unplacedCount > 0 ? ` ${activity.unplacedCount} event${activity.unplacedCount === 1 ? "" : "s"} could not be placed on a seat in this scope.` : ""}
        </p>
        {observed.length > 0 ? (
          <ul data-testid="spatial-workspace-traffic" className="mt-1 space-y-1">
            {observed.map((r) => {
              const outgoing = r.sourceKey === agent.key;
              const peer = model.agentsByKey.get(outgoing ? r.targetKey : r.sourceKey);
              return (
                <li key={r.id} className="font-mono text-[10px] text-on-surface">
                  <span aria-hidden="true" className="text-on-surface-variant">{outgoing ? "→" : "←"} </span>
                  <span className="sr-only">{outgoing ? "to" : "from"} </span>
                  {peer?.displayName ?? "seat outside this scope"} · {r.label}
                  {r.qitemId ? <span className="text-on-surface-variant"> · …{shortQitemTail(r.qitemId)}</span> : null}
                  <span className="block text-on-surface-variant">
                    <DisplayTime iso={Number.isFinite(r.occurredAt) ? new Date(r.occurredAt).toISOString() : null} />
                  </span>
                </li>
              );
            })}
          </ul>
        ) : activity && !isRemote ? (
          <p className="mt-1 font-mono text-[10px] italic text-on-surface-variant">No observed traffic for this seat in the retained window.</p>
        ) : null}
      </section>

      <section aria-label="Recent seat events">
        <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">Recent seat events</div>
        {detail === undefined ? (
          <p className="mt-1 font-mono text-[10px] italic text-on-surface-variant">
            {detailError ? "Seat detail could not be read." : agent.logicalId ? "Reading seat detail…" : "No logical id: seat detail unavailable."}
          </p>
        ) : served.length === 0 ? (
          <p className="mt-1 font-mono text-[10px] italic text-on-surface-variant">No recent events served for this seat.</p>
        ) : (
          <ul data-testid="spatial-workspace-events" className="mt-1 space-y-1">
            {served.map((e, i) => (
              <li key={`${String(e.type)}-${i}`} className="font-mono text-[10px] text-on-surface">
                {String(e.type)}
                <span className="block text-on-surface-variant"><DisplayTime iso={typeof e.createdAt === "string" ? e.createdAt : null} /></span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RelationshipsPanel({ agent, model, onSelect }: { agent: SpatialAgent; model: SpatialModel; onSelect: (key: string) => void }) {
  const outgoing = model.edges.filter((e) => e.sourceKey === agent.key);
  const incoming = model.edges.filter((e) => e.targetKey === agent.key);
  return (
    <div data-testid="spatial-workspace-relationships">
      <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
        {outgoing.length} out · {incoming.length} in
      </div>
      {outgoing.length + incoming.length === 0 ? (
        <p className="mt-1 font-mono text-[10px] italic text-on-surface-variant">No recorded relationships.</p>
      ) : (
        <ul data-testid="spatial-inspector-relationships" className="mt-1">
          {[...outgoing.map((e) => ({ e, dir: "→", peer: e.targetKey })), ...incoming.map((e) => ({ e, dir: "←", peer: e.sourceKey }))].map(({ e, dir, peer }) => {
            const peerAgent = model.agentsByKey.get(peer);
            return (
              <li key={`${e.key}${dir}`}>
                <button
                  type="button"
                  onClick={() => onSelect(peer)}
                  className="flex min-h-11 w-full min-w-0 items-center gap-2 text-left font-mono text-[11px] text-on-surface hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
                >
                  <span aria-hidden="true" className="text-on-surface-variant">{dir}</span>
                  <span className="shrink-0 text-on-surface-variant">{e.kind}</span>
                  <span className="min-w-0 truncate">{peerAgent?.displayName ?? "unknown seat"}</span>
                  {e.crossPod ? <span className="shrink-0 text-[9px] text-on-surface-variant">cross-pod</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seat switcher (stacked layouts): fast tap-to-switch between seats, filtered
// by the view's search. Exact keys; same-named seats show their rig.
// ---------------------------------------------------------------------------

export function SpatialSeatSwitcher({ model, selectedKey, matchKeys, statusByKey, palette, onSelect }: {
  model: SpatialModel;
  selectedKey: string | null;
  matchKeys: ReadonlySet<string> | null;
  statusByKey: ReadonlyMap<string, SpatialSeatStatus>;
  palette: SpatialPalette;
  onSelect: (key: string) => void;
}) {
  const agents = useMemo(() => model.rigs.flatMap((r) => r.agents).filter((a) => matchKeys === null || matchKeys.has(a.key)), [model, matchKeys]);
  const nameCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of agents) m.set(a.displayName, (m.get(a.displayName) ?? 0) + 1);
    return m;
  }, [agents]);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Keep the selected chip visible by scrolling the STRIP only — never the
  // page (this also runs on an initial URL restore, which must not move it).
  useEffect(() => {
    const list = listRef.current;
    const chip = list?.querySelector<HTMLElement>("[aria-pressed='true']");
    if (!list || !chip) return;
    const left = chip.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft || left + chip.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, left - (list.clientWidth - chip.offsetWidth) / 2);
    }
  }, [selectedKey]);
  if (agents.length === 0) {
    return <p data-testid="spatial-seat-switcher-empty" className="px-4 py-2 font-mono text-[10px] text-on-surface-variant">No seats match the search.</p>;
  }
  return (
    <div
      ref={listRef}
      role="group"
      aria-label="Switch seat"
      data-testid="spatial-seat-switcher"
      className="spatial-switcher flex gap-1.5 overflow-x-auto px-4 py-2"
      onKeyDown={(e) => {
        // Roving focus between seats, like the full index's arrow keys.
        const chips = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-testid='spatial-seat-chip']"));
        const index = chips.indexOf(e.target as HTMLElement);
        if (index < 0) return;
        const next = e.key === "ArrowRight" ? chips[index + 1] : e.key === "ArrowLeft" ? chips[index - 1]
          : e.key === "Home" ? chips[0] : e.key === "End" ? chips[chips.length - 1] : undefined;
        if (!next) return;
        e.preventDefault();
        next.focus();
      }}
    >
      {agents.map((a) => {
        const st = statusByKey.get(a.key);
        const dup = (nameCount.get(a.displayName) ?? 0) > 1;
        return (
          <button
            key={a.key}
            type="button"
            data-testid="spatial-seat-chip"
            data-spatial-key={a.key}
            aria-pressed={a.key === selectedKey}
            onClick={() => onSelect(a.key)}
            className="spatial-hud-button touch-target !h-9 shrink-0 !normal-case !tracking-normal"
          >
            {st ? <span aria-hidden="true" data-tone={st.tone} className={cn("spatial-mark", st.stale && "is-stale")} style={{ "--spatial-tone": hslCss(palette.tones[st.tone]) } as React.CSSProperties} /> : null}
            <span className="max-w-[10rem] truncate text-[11px]">{a.displayName}</span>
            {dup ? <span className="max-w-[6rem] truncate text-[9px] text-on-surface-variant">{a.rigName}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
