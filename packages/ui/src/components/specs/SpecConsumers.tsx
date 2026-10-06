// Declared-by rigs and observed seats for an agent spec, as separate facts.
//
// Declared: a catalog rig spec whose authored `local:` member reference
// resolves exactly to this agent spec's served source file. Observed: a seat in
// an inventory read whose daemon-served EFFECTIVE binding names this spec.
// Neither implies the other. Absence is claimed only from complete, current,
// successful reads; pending/failed/partial/stale reads are unknown coverage.

import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { LibraryRigReview, SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { readLibraryReview } from "../../lib/node-library-reads.js";
import { TopologyLink, topologyTarget } from "../topology/topology-navigation.js";
import {
  candidateFacts, observedSeatsForSpec, readAge, resolveAuthoredAgentRef, sameBindingEntries, type ListRead, type ObservedSeat,
} from "./library-model.js";
import { LibraryEntryLink, originLabel, useOriginInventory } from "./library-reads.js";

const PANEL = "border border-outline-variant/60 bg-surface-lowest/[0.08]";
const PANEL_HEAD = "flex flex-wrap items-baseline justify-between gap-2 border-b border-outline-variant bg-background px-3 py-2";
const LABEL = "font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant";
const NOTE = "px-3 py-2 text-xs leading-relaxed text-on-surface-variant";

export function shortHash(hash: string | null): string {
  if (!hash) return "not served";
  return hash.length > 16 ? `${hash.slice(0, 12)}…` : hash;
}

function observationNote(seat: ObservedSeat): string | null {
  const { observation } = seat;
  if (observation.kind === "retained") return `from the inventory read ${readAge(observation.at)}; its refresh failed`;
  if (observation.kind === "partial") {
    return `from a partial inventory received ${readAge(observation.at)} (${observation.rejectedCount} record${observation.rejectedCount === 1 ? "" : "s"} rejected)`;
  }
  return null;
}

function SeatRow({ seat }: { seat: ObservedSeat }) {
  const target = topologyTarget({ scope: { kind: "seat", rigId: seat.rigId, logicalId: seat.logicalId }, sourceHost: seat.hostId });
  const note = observationNote(seat);
  return (
    <li className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]" data-testid="observed-seat" data-rig={seat.rigId}
      data-logical={seat.logicalId} data-observation={seat.observation.kind}>
      <div className="min-w-0">
        <TopologyLink target={target} from={null} className="font-mono font-bold text-on-surface underline decoration-dotted" data-testid="observed-seat-link">
          {seat.rigName} · {seat.logicalId}
        </TopologyLink>
        <div className="mt-0.5 font-mono text-[10px] text-on-surface-variant">
          {seat.canonicalSessionName ?? "no session name"} · {seat.runtime ?? "runtime unknown"} · profile {seat.profile ?? "not served"}
        </div>
        {note && <div className="mt-0.5 font-mono text-[10px] text-amber-800" data-testid="observed-seat-observation">{note}</div>}
      </div>
      <div className="font-mono text-[10px] text-on-surface-variant sm:text-right">
        <div data-testid="observed-seat-lifecycle">{seat.lifecycleState ?? "lifecycle not served"}</div>
        <div>
          launched {seat.resolvedSpecName} {seat.resolvedSpecVersion !== null ? `v${seat.resolvedSpecVersion}` : "(version not served)"} ·{" "}
          <span title={seat.resolvedSpecHash ?? undefined} data-testid="observed-seat-hash">hash {shortHash(seat.resolvedSpecHash)}</span>
        </div>
      </div>
    </li>
  );
}

/** `running <spec>` / observed consumers on one exact origin. */
export function ObservedSeatsPanel({ hostId, name, version, agentEntries }: {
  hostId: string | null;
  name: string;
  /** Exact served version bytes; omitted = every served version of `name`. */
  version?: string;
  /** Same-origin agent catalog, to disclose when a binding is ambiguous. */
  agentEntries?: readonly SpecLibraryEntry[];
}) {
  const inventory = useOriginInventory(hostId);
  const spec = version === undefined ? { name } : { name, version };
  // Each observation stays separate: a newer partial response and an older
  // successful read of the same rig are both shown, never spliced.
  const seats = hostId === null ? [] : inventory.rigs.flatMap((rig) => [
    ...(rig.partial ? observedSeatsForSpec(hostId, rig.partial.rows, spec, { kind: "partial", at: rig.partial.receivedAt, rejectedCount: rig.partial.rejectedCount }) : []),
    ...observedSeatsForSpec(hostId, rig.rows, spec, { kind: rig.status === "ok" ? "current" : "retained", at: rig.updatedAt }),
  ]);
  const failed = inventory.rigs.filter((rig) => rig.status === "failed");
  const pending = inventory.rigs.filter((rig) => rig.status === "pending");
  const stale = inventory.rigs.filter((rig) => rig.status === "stale");
  const partial = inventory.rigs.filter((rig) => rig.status === "partial");
  const running = seats.filter((seat) => seat.lifecycleState === "running").length;
  const sameBinding = agentEntries ? sameBindingEntries(agentEntries, name, version) : [];
  const complete = inventory.complete;
  const bindingLabel = version === undefined ? `${name} (any served version)` : `${name} v${version}`;

  return (
    <section className={PANEL} data-testid="observed-seats" aria-label="Observed seats">
      <header className={PANEL_HEAD}>
        <span className={LABEL}>Observed seats · effective binding {bindingLabel}</span>
        <span className={LABEL} data-testid="observed-seats-count" data-complete={complete ? "true" : "false"}>
          {complete ? `${seats.length} seats · ${running} running` : `${seats.length} found · coverage incomplete`}
        </span>
      </header>
      <p className={NOTE}>
        Seats on {originLabel(hostId)} whose launched binding names this spec. The binding records name, version and hash at
        launch; it does not identify which library file was used, and later library edits do not change it.
      </p>
      {sameBinding.length > 1 && (
        <p className={`${NOTE} text-amber-800`} data-testid="observed-seats-ambiguous">
          {sameBinding.length} library entries share this {version === undefined ? "name" : "name and version"} ({sameBinding.map(candidateFacts).join("; ")}),
          so these seats cannot be attributed to one of them.
        </p>
      )}
      {hostId === null ? (
        <p className={NOTE} data-testid="observed-seats-unknown-origin">The origin is unknown, so no inventory was read.</p>
      ) : inventory.summary.status === "failed" ? (
        <p role="alert" className={`${NOTE} text-red-800`} data-testid="observed-seats-summary-failed">
          Rig list unavailable: {inventory.summary.error?.message}. Consumers are unknown, not zero.{" "}
          <button type="button" className="underline" onClick={inventory.summary.retry}>Retry</button>
        </p>
      ) : inventory.summary.status === "pending" ? (
        <p className={NOTE}>Reading rigs…</p>
      ) : (
        <>
          {seats.length > 0 ? (
            <ul className="divide-y divide-outline-variant/60">
              {seats.map((seat) => <SeatRow key={`${seat.observation.kind}\u0000${seat.rigId}\u0000${seat.logicalId}`} seat={seat} />)}
            </ul>
          ) : complete ? (
            <p className={NOTE} data-testid="observed-seats-none">No seat in {inventory.rigs.length} rigs is bound to this spec.</p>
          ) : null}
          {!complete && (
            <ul className={`${NOTE} space-y-0.5`} data-testid="observed-seats-coverage">
              {inventory.summary.status === "stale" && (
                <li className="text-amber-800">
                  Rig list refresh failed ({inventory.summary.error?.message}); using the list read {readAge(inventory.summary.updatedAt)}.{" "}
                  <button type="button" className="underline" onClick={inventory.summary.retry}>Retry</button>
                </li>
              )}
              {failed.map((rig) => (
                <li key={rig.rig.id} className="text-red-800">{rig.rig.name ?? rig.rig.id}: inventory unavailable ({rig.error?.message}) — its seats are unknown.</li>
              ))}
              {partial.map((rig) => (
                <li key={rig.rig.id} className="text-amber-800">
                  {rig.rig.name ?? rig.rig.id}: latest inventory rejected {rig.partial!.rejectedCount} record{rig.partial!.rejectedCount === 1 ? "" : "s"};
                  only its verified rows (received {readAge(rig.partial!.receivedAt)}) are shown{rig.updatedAt ? `, separately from the complete read ${readAge(rig.updatedAt)}` : ""}.
                </li>
              ))}
              {stale.map((rig) => (
                <li key={rig.rig.id} className="text-amber-800">{rig.rig.name ?? rig.rig.id}: showing inventory read {readAge(rig.updatedAt)}; the latest refresh failed.</li>
              ))}
              {pending.length > 0 && <li>Still reading {pending.length} rig{pending.length === 1 ? "" : "s"}…</li>}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Authored `declared-by` rigs: read on request, because it reads every rig
 * review in the same origin's catalog. Absence is claimed only after a
 * current rig list and every rig review were read successfully. */
export function DeclaredByPanel({ hostId, agent, rigCatalog }: {
  hostId: string | null;
  agent: { name: string; sourcePath: string };
  /** The same origin's rig-spec list with its read state. */
  rigCatalog: ListRead<SpecLibraryEntry>;
}) {
  const [requested, setRequested] = useState(false);
  const rigs = (rigCatalog.entries ?? []).filter((entry) => entry.kind === "rig" && entry.status !== "error");
  const reviews = useQueries({
    queries: rigs.map((rig) => ({
      queryKey: ["spec-library", "review", rig.id, hostId],
      queryFn: ({ signal }: { signal: AbortSignal }) => readLibraryReview(rig.id, hostId!, { signal }),
      enabled: requested && hostId !== null,
      retry: false,
      placeholderData: undefined,
    })),
  });
  const agentDir = agent.sourcePath.replace(/\/agent\.ya?ml$/, "");
  const declarations = rigs.flatMap((rig, index) => {
    const review = reviews[index]!.data as LibraryRigReview | undefined;
    if (!review || review.kind !== "rig") return [];
    const members = (review.pods ?? []).flatMap((pod) => pod.members.map((member) => ({ pod: pod.id, member })));
    return members
      .map(({ pod, member }) => ({ pod, member, ref: resolveAuthoredAgentRef(review.sourcePath, member.agentRef, []) }))
      .filter(({ ref }) => ref.state !== "nonstandard" && (ref.path === agentDir || ref.path === agent.sourcePath))
      .map(({ pod, member }) => ({ rig, pod, memberId: member.id, agentRef: member.agentRef }));
  });
  const failed = rigs.filter((_, index) => reviews[index]!.data === undefined && reviews[index]!.error);
  const staleReviews = rigs.filter((_, index) => reviews[index]!.data !== undefined && reviews[index]!.error);
  const pending = requested && hostId !== null ? rigs.filter((_, index) => reviews[index]!.data === undefined && !reviews[index]!.error) : [];
  const catalogKnown = rigCatalog.state === "ok" || rigCatalog.state === "stale";
  const complete = rigCatalog.state === "ok" && failed.length === 0 && pending.length === 0 && staleReviews.length === 0;

  return (
    <section className={PANEL} data-testid="declared-by" aria-label="Declared by rig specs">
      <header className={PANEL_HEAD}>
        <span className={LABEL}>Declared by rig specs</span>
        {requested && <span className={LABEL} data-testid="declared-by-count">{declarations.length} member declarations{complete ? "" : " · incomplete"}</span>}
      </header>
      <p className={NOTE}>
        Rig specs in this library whose authored member reference points at this agent spec file. A declaration is not a running
        seat.
      </p>
      {rigCatalog.state === "failed" ? (
        <p role="alert" className={`${NOTE} text-red-800`} data-testid="declared-by-catalog-failed">
          Rig spec list unavailable: {rigCatalog.error?.message}. Declarations are unknown, not absent.{" "}
          <button type="button" className="underline" onClick={rigCatalog.retry}>Retry</button>
        </p>
      ) : rigCatalog.state === "stale" ? (
        <p className={`${NOTE} text-amber-800`} data-testid="declared-by-catalog-stale">
          Rig spec list refresh failed; checking the list read {readAge(rigCatalog.updatedAt)}.
        </p>
      ) : null}
      {!requested ? (
        <div className="px-3 pb-3">
          <button type="button" onClick={() => setRequested(true)} disabled={hostId === null || !catalogKnown} data-testid="declared-by-check"
            className="border border-outline-variant px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hover:bg-surface-lowest/40 disabled:opacity-50">
            {catalogKnown ? `Check ${rigs.length} rig spec${rigs.length === 1 ? "" : "s"}` : rigCatalog.state === "failed" ? "Rig specs unavailable" : "Reading rig specs…"}
          </button>
        </div>
      ) : (
        <>
          {declarations.length > 0 && (
            <ul className="divide-y divide-outline-variant/60">
              {declarations.map((declaration) => (
                <li key={`${declaration.rig.id}\u0000${declaration.pod}\u0000${declaration.memberId}`} className="px-3 py-2 text-xs" data-testid="declared-by-row">
                  <LibraryEntryLink entryId={declaration.rig.id} sourceHostId={hostId ?? undefined} className="font-mono font-bold text-on-surface underline decoration-dotted">
                    {declaration.rig.name}
                  </LibraryEntryLink>
                  <span className="font-mono text-[10px] text-on-surface-variant"> · {declaration.pod}.{declaration.memberId} · {declaration.agentRef}</span>
                </li>
              ))}
            </ul>
          )}
          {complete && declarations.length === 0 && (
            <p className={NOTE} data-testid="declared-by-none">No rig spec in this library declares this agent spec.</p>
          )}
          {pending.length > 0 && <p className={NOTE}>Reading {pending.length} rig spec{pending.length === 1 ? "" : "s"}…</p>}
          {failed.length > 0 && (
            <ul className={`${NOTE} text-red-800`} data-testid="declared-by-failed">
              {failed.map((rig) => <li key={rig.id}>{rig.name}: review unavailable — not checked.</li>)}
            </ul>
          )}
          {staleReviews.length > 0 && (
            <ul className={`${NOTE} text-amber-800`} data-testid="declared-by-stale">
              {staleReviews.map((rig) => <li key={rig.id}>{rig.name}: checked against an earlier review; its refresh failed.</li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
