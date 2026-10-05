// Connections context: exact inbound seat, bounded per-human request sample
// and rig/spec/work destinations (TUI connections-model.ts:91–123).
//
// All reads are GETs against the connected instance (LOCAL_OPERATOR_INSTANCE /
// sourceHost "local"); a remote topology selection never retargets them.
// Nothing here contacts Slack or runs readiness/verify/enable.

import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { usePulse } from "../../hooks/usePulse.js";
import { useSpecLibrary } from "../../hooks/useSpecLibrary.js";
import { hasShape, isText, LOCAL_OPERATOR_INSTANCE, operatorRead, operatorScopeKey, OPERATOR_QUERY_OPTIONS, type OperatorReadError } from "../../lib/operator-read.js";
import { MAX_PULSE_RIGS, type PulseRead } from "../../lib/recent-pulse-contracts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { freshTopologyVisitState, topologyTarget } from "../topology/topology-navigation.js";
import { CopyButton, DetailSection, Tag, Timestamp } from "./OperatorPrimitives.js";
import {
  humanRequestSample, inventoryGap, matchAuthoredSpec, resolveInbound, rigContexts, REQUEST_SAMPLE,
  type InventorySeat, type RigContext, type SpecMatch,
} from "./connections-model.js";

export interface ConnectionsContextData {
  pulse: PulseRead | undefined;
  /** True while the first bounded read is in flight. */
  reading: boolean;
  /** Whole-read failure (not per-source); per-source states live in `pulse`. */
  error: OperatorReadError | Error | null;
  readAt: number | null;
  refetch: () => void;
}

export function useConnectionsContext(): ConnectionsContextData {
  const pulse = usePulse(LOCAL_OPERATOR_INSTANCE);
  return {
    pulse: pulse.current,
    reading: pulse.current === undefined && !pulse.error,
    error: pulse.error ?? null,
    readAt: pulse.current?.readAt ?? null,
    refetch: () => void pulse.refetch(),
  };
}

const linkClass = "underline decoration-dotted underline-offset-2 hover:text-on-surface";

function SeatLink({ seat, testId }: { seat: InventorySeat; testId: string }) {
  const target = seat.logicalId ? topologyTarget({ scope: { kind: "seat", rigId: seat.rigId, logicalId: seat.logicalId }, sourceHost: LOCAL_HOST_ID }) : null;
  const label = <><span className="font-mono">{seat.session}</span> · rig <span className="font-mono">{seat.rigName}</span>{seat.podNamespace ? <> · pod <span className="font-mono">{seat.podNamespace}</span></> : null}</>;
  if (!target) return <span data-testid={`${testId}-text`}>{label} <span className="text-on-surface-variant">(no seat page: served logical ID absent)</span></span>;
  return (
    <Link to={target.to} params={target.params as never} search={target.search as never} state={freshTopologyVisitState} data-testid={testId} className={linkClass}>
      {label} → seat
    </Link>
  );
}

/** "New inbound" with its exact seat on the connected instance, or why not. */
export function InboundDestination({ destination, context }: { destination: string | null; context: ConnectionsContextData }) {
  const target = resolveInbound(destination, context.pulse, context.reading);
  return (
    <span data-testid="connections-inbound" data-state={target.kind} className="block">
      <span className="font-mono text-xs">{destination ?? "missing"}</span>
      {target.kind === "matched" ? <span className="mt-0.5 block text-xs"><SeatLink seat={target.seat} testId="connections-inbound-seat" /></span> : null}
      {target.kind === "ambiguous" ? (
        <span className="mt-0.5 block text-xs text-warning" data-testid="connections-inbound-ambiguous">
          {target.seats.length} served seats report this exact session; none is chosen:
          {target.seats.map((seat, i) => <span key={`${seat.rigId}-${seat.logicalId}-${i}`} className="block"><SeatLink seat={seat} testId="connections-inbound-candidate" /></span>)}
        </span>
      ) : null}
      {target.kind === "not-found" ? <span className="mt-0.5 block text-xs text-on-surface-variant" data-testid="connections-inbound-not-found">No seat in the connected instance's complete inventory reports this session; the address stays inspectable as text.</span> : null}
      {target.kind === "unknown" ? <span className="mt-0.5 block text-xs text-warning" data-testid="connections-inbound-unknown">Seat unknown: {target.reason}. No seat is guessed.</span> : null}
      {target.kind === "reading" ? <span className="mt-0.5 block text-xs text-on-surface-variant">Resolving seat…</span> : null}
    </span>
  );
}

/** Up to three open requests addressed to this human, from loaded windows. */
export function HumanRequests({ address, context }: { address: string; context: ConnectionsContextData }) {
  if (!context.pulse) {
    return (
      <DetailSection title="Open requests to this address" testId="connections-human-requests">
        <p data-testid="connections-human-requests-state" className="text-sm text-on-surface-variant">
          {context.reading ? "Reading queue windows…" : `Requests unknown: queue windows could not be read${context.error ? ` (${context.error.message})` : ""}.`}
        </p>
      </DetailSection>
    );
  }
  const sample = humanRequestSample(address, context.pulse);
  return (
    <DetailSection title="Open requests to this address" testId="connections-human-requests"
      note={<>Joined by the exact address <span className="font-mono">{address}</span> across loaded queue windows (read <Timestamp iso={context.readAt ? new Date(context.readAt).toISOString() : null} />). A sample, not a total.</>}>
      {sample.unknown ? (
        <p data-testid="connections-human-requests-state" data-state="unknown" className="text-sm text-warning">Requests unknown: no queue window could be read. This is not zero.</p>
      ) : sample.rows.length === 0 ? (
        <p data-testid="connections-human-requests-state" data-state={sample.unavailableWindows.length || sample.boundedWindows.length ? "partial-empty" : "empty"} className="text-sm text-on-surface-variant">
          No pending, in-progress or blocked request to this address in the loaded windows{sample.unavailableWindows.length || sample.boundedWindows.length ? "; other requests may exist (see coverage)" : ""}.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="connections-human-request-list">
          {sample.rows.map((row) => (
            <li key={row.qitemId} data-testid="connections-human-request" className="border border-outline-variant px-3 py-1.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={row.state === "blocked" ? "warn" : "neutral"}>{row.state}</Tag>
                <span className="font-mono text-xs">{row.qitemId}</span>
                <span className="text-xs text-on-surface-variant">from <span className="font-mono">{row.sourceSession}</span></span>
              </div>
              {row.summary ? <p className="mt-0.5 break-words text-xs text-on-surface [overflow-wrap:anywhere]">{row.summary}</p> : null}
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                <Link to="/for-you" search={{ view: "attention", item: `queue:${row.qitemId}` }} className={linkClass} data-testid="connections-human-request-open">Open in Attention →</Link>
                <CopyButton value={`rig queue show ${row.qitemId} --full`} label="Copy inspect command" />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p data-testid="connections-human-requests-coverage" className="mt-1 text-xs text-on-surface-variant">
        {sample.matchedInWindows > REQUEST_SAMPLE ? `Showing ${REQUEST_SAMPLE} of ${sample.matchedInWindows} matched in loaded windows. ` : ""}
        Windows read: {sample.readWindows.join(", ") || "none"}.
        {sample.boundedWindows.length ? ` At their bound (more may exist): ${sample.boundedWindows.join(", ")}.` : ""}
        {sample.unavailableWindows.length ? ` Unavailable: ${sample.unavailableWindows.map((w) => `${w.name} (${w.message})`).join("; ")}.` : ""}
      </p>
    </DetailSection>
  );
}

function SpecCell({ rig, specName, specError, match }: { rig: RigContext; specName: string | null; specError: string | null; match: SpecMatch | null }) {
  if (specError) return <span className="text-warning" data-testid={`connections-rig-spec-error-${rig.rigId}`}>authored spec unavailable ({specError})</span>;
  if (specName === null) return <span className="text-on-surface-variant">reading authored spec…</span>;
  const entryLink = (id: string, label: string, testId: string) => (
    <Link to="/specs/library/$entryId" params={{ entryId: id }} search={{ source: LOCAL_HOST_ID } as never} data-testid={testId} className={linkClass}>{label}</Link>
  );
  return (
    <span data-testid={`connections-rig-spec-${rig.rigId}`} data-state={match?.kind ?? "pending"}>
      authored spec <span className="font-mono">{specName}</span>
      {match?.kind === "matched" ? <> · {entryLink(match.entry.id, `v${match.entry.version} in the connected library →`, "connections-rig-spec-link")}</> : null}
      {match?.kind === "absent" ? <span className="text-on-surface-variant"> · not in the connected library</span> : null}
      {match?.kind === "unavailable" ? (
        <span className="text-warning" data-testid="connections-rig-spec-unavailable"> · library unavailable ({match.message})
          {match.retained && match.retained.kind !== "absent" ? (
            <span className="block text-on-surface-variant" data-testid="connections-rig-spec-retained">
              Earlier read at <Timestamp iso={match.retainedAt ? new Date(match.retainedAt).toISOString() : null} />, not current:{" "}
              {(match.retained.kind === "matched" ? [match.retained.entry] : match.retained.entries).map((entry) => (
                <span key={entry.id} className="mr-2 inline-block">{entryLink(entry.id, `v${entry.version} · ${entry.relativePath}`, "connections-rig-spec-retained-link")}</span>
              ))}
            </span>
          ) : match.retained ? <span className="block text-on-surface-variant">The earlier read listed no entry with this name; current presence is unknown.</span> : null}
        </span>
      ) : null}
      {match?.kind === "pending" ? <span className="text-on-surface-variant"> · reading library…</span> : null}
      {match?.kind === "ambiguous" ? (
        <span className="block text-warning" data-testid="connections-rig-spec-ambiguous">
          {match.entries.length} library entries share this name; none is chosen:
          {match.entries.map((entry) => (
            <span key={entry.id} className="block text-on-surface">
              {entryLink(entry.id, `v${entry.version} · ${entry.sourceType} · ${entry.relativePath}`, "connections-rig-spec-candidate")}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** Rig lifecycle, seat evidence, authored spec and work destinations. */
export function WorkAndConfiguration({ context }: { context: ConnectionsContextData }) {
  const rigs = rigContexts(context.pulse).slice(0, MAX_PULSE_RIGS);
  const library = useSpecLibrary("rig", { sourceHostId: LOCAL_HOST_ID });
  const specs = useQueries({
    queries: rigs.map((rig) => ({
      ...OPERATOR_QUERY_OPTIONS, refetchInterval: false as const, staleTime: 60_000,
      queryKey: [...operatorScopeKey(LOCAL_OPERATOR_INSTANCE), "connections", "rig-spec", rig.rigId],
      queryFn: ({ signal }: { signal: AbortSignal }) => operatorRead(LOCAL_OPERATOR_INSTANCE, `/api/rigs/${encodeURIComponent(rig.rigId)}/spec.json`,
        (v): v is { name: string } => hasShape(v, { name: isText }), { signal }),
    })),
  });
  const gap = inventoryGap(context.pulse);
  return (
    <section data-testid="connections-work" aria-label="Work and configuration" className="mt-6 border-t border-outline-variant pt-4">
      <h2 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface">Work and configuration · connected instance</h2>
      {library.error ? (
        // Passive retry of the SAME connected-instance library read (existing
        // query; no new reader/key/polling, no Slack contact or mutation).
        // Retained dated links below stay until a read actually succeeds.
        <div role="alert" data-testid="connections-library-error" className="mb-2 flex flex-wrap items-center gap-2 border border-outline-variant bg-surface-lowest px-3 py-1.5 text-xs text-on-surface">
          <span>Spec library read failed ({library.error.message}); authored-spec matches below are not current.</span>
          <button
            type="button" data-testid="connections-library-retry" onClick={() => void library.refetch()} disabled={library.isFetching}
            className="border border-on-surface px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-low disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface"
          >
            {library.isFetching ? "Retrying library read…" : "Retry library read"}
          </button>
        </div>
      ) : null}
      {!context.pulse ? (
        <p data-testid="connections-work-state" className="text-sm text-on-surface-variant">{context.reading ? "Reading rigs…" : `Rig inventory unavailable${context.error ? ` (${context.error.message})` : ""}.`}</p>
      ) : context.pulse.inventory.state === "unavailable" ? (
        <p data-testid="connections-work-state" className="text-sm text-warning">Rig inventory unavailable ({context.pulse.inventory.error.message}); rigs are unknown, not absent.</p>
      ) : rigs.length === 0 ? (
        <p data-testid="connections-work-state" className="text-sm text-on-surface-variant">No rigs on the connected instance.</p>
      ) : (
        <ul className="divide-y divide-outline-variant border border-outline-variant">
          {rigs.map((rig, i) => {
            const spec = specs[i];
            const specName = spec?.data?.name ?? null;
            const target = topologyTarget({ scope: { kind: "rig", rigId: rig.rigId }, sourceHost: LOCAL_HOST_ID });
            return (
              <li key={rig.rigId} data-testid={`connections-rig-${rig.rigId}`} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  {target ? (
                    <Link to={target.to} params={target.params as never} search={target.search as never} state={freshTopologyVisitState} className={`font-mono ${linkClass}`} data-testid="connections-rig-link">{rig.rigName} →</Link>
                  ) : <span className="font-mono">{rig.rigName}</span>}
                  <Tag tone={rig.lifecycle === "running" ? "neutral" : "warn"}>{rig.lifecycle ?? "lifecycle unknown"}</Tag>
                  <span data-testid={`connections-rig-seats-${rig.rigId}`} className="text-xs text-on-surface-variant">
                    {rig.seatsState === "read" ? `${rig.seatCount} seats` : rig.seatsState === "unavailable" ? "seat inventory unavailable" : "seats not read (beyond the rig read bound)"}
                  </span>
                </div>
                <div className="mt-0.5 text-xs">
                  <SpecCell rig={rig} specName={specName} specError={spec?.error ? spec.error.message : null}
                    match={specName ? matchAuthoredSpec(specName, library.data, library.error, library.dataUpdatedAt || null) : null} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {gap && context.pulse ? <p data-testid="connections-work-gap" className="mt-1 text-xs text-warning">Inventory incomplete: {gap}.</p> : null}
      <nav aria-label="Related destinations" className="mt-3 flex flex-wrap gap-2 font-mono text-[10px] uppercase">
        <Link to="/project/catalog" className="border border-outline-variant px-2 py-1 hover:bg-surface-low" data-testid="connections-open-work">Open work →</Link>
        <Link to="/workflows" className="border border-outline-variant px-2 py-1 hover:bg-surface-low" data-testid="connections-open-workflows">Workflows →</Link>
        <Link to="/for-you" search={{ view: "attention" }} className="border border-outline-variant px-2 py-1 hover:bg-surface-low" data-testid="connections-open-requests">Human requests and waits →</Link>
        <button type="button" onClick={() => window.history.back()} className="border border-outline-variant px-2 py-1 uppercase hover:bg-surface-low" data-testid="connections-back">← Return to previous view</button>
      </nav>
    </section>
  );
}
