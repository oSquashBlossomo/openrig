// Seat spec provenance (`spec-of <agent>`): the seat's launched binding, its
// authored reference as written, and the CURRENT library candidates on the same
// exact origin — kept as separate facts. No hash, source or adoption is inferred
// from a name match; an ambiguous or missing library entry is stated as such.

import type { ReactNode } from "react";
import type { NodeDetailData } from "../../hooks/useNodeDetail.js";
import { useLibraryReview, useSpecLibrary, type LibraryAgentReview, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { candidateFacts, classifyLibraryReadError, readAge, resolveSpec } from "./library-model.js";
import { LibraryEntryLink, originLabel } from "./library-reads.js";
import { shortHash } from "./SpecConsumers.js";

export type SeatSpecFacts = Pick<NodeDetailData,
  "rigId" | "rigName" | "logicalId" | "runtime" | "model" | "agentRef" | "profile"
  | "resolvedSpecName" | "resolvedSpecVersion" | "resolvedSpecHash">;

export interface SeatSpecProvenanceProps {
  /** Exact origin that served `seat` (the seat route's admitted source host).
   *  null = unknown: the binding is shown, no library read happens. */
  hostId: string | null;
  seat: SeatSpecFacts;
  /** Optional rendering of the exact resolved review (e.g. AgentSpecDisplay /
   *  AgentPluginsList). Called only for a single unambiguous current entry. */
  renderReview?: (review: LibraryAgentReview, entry: SpecLibraryEntry) => ReactNode;
}

const LABEL = "font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant";
const ROW = "grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2 px-3 py-1 text-xs";

function Fact({ label, value, testId, title }: { label: string; value: ReactNode; testId?: string; title?: string }) {
  return (
    <div className={ROW}>
      <dt className={LABEL}>{label}</dt>
      <dd className="min-w-0 break-words font-mono text-on-surface" data-testid={testId} title={title}>{value}</dd>
    </div>
  );
}

/** `/specs/agent/<name>?version=&source=` — the kind/name resolver route. */
export function specLookupHref(kind: string, name: string, options: { version?: string | null; source?: string | null } = {}): string {
  const search = new URLSearchParams();
  if (options.version) search.set("version", options.version);
  if (options.source) search.set("source", options.source);
  const query = search.toString();
  return `/specs/${encodeURIComponent(kind)}/${encodeURIComponent(name)}${query ? `?${query}` : ""}`;
}

export function SeatSpecProvenance({ hostId, seat, renderReview }: SeatSpecProvenanceProps) {
  const name = seat.resolvedSpecName;
  const catalog = useSpecLibrary("agent", { sourceHostId: name ? hostId : null });
  const entries = catalog.data ?? [];
  const resolution = name ? resolveSpec(entries, { kind: "agent", name, ...(seat.resolvedSpecVersion ? { version: seat.resolvedSpecVersion } : {}) }) : null;
  const otherVersions = name && seat.resolvedSpecVersion
    ? entries.filter((entry) => entry.kind === "agent" && entry.name === name && entry.version !== seat.resolvedSpecVersion)
    : [];
  const exact = resolution?.state === "exact" ? resolution.entry : null;
  const review = useLibraryReview(exact && renderReview ? exact.id : null, { sourceHostId: hostId });

  return (
    <section data-testid="seat-spec-provenance" aria-label="Spec provenance" className="space-y-3">
      <div className="border border-outline-variant/60">
        <div className="border-b border-outline-variant bg-background px-3 py-2"><span className={LABEL}>Launched binding</span></div>
        <dl className="py-1">
          <Fact label="Spec" value={name ?? "not recorded"} testId="seat-spec-name" />
          <Fact label="Version" value={seat.resolvedSpecVersion ?? "not recorded"} testId="seat-spec-version" />
          <Fact label="Profile" value={seat.profile ?? "not recorded"} testId="seat-spec-profile" />
          <Fact label="Hash" value={seat.resolvedSpecHash ?? "not served"} testId="seat-spec-hash" />
          <Fact label="Runtime · model" value={`${seat.runtime ?? "unknown"} · ${seat.model ?? "not recorded"}`} />
          <Fact label="Authored ref" value={seat.agentRef ?? "not recorded"} testId="seat-spec-agent-ref" />
        </dl>
        <p className="px-3 pb-2 text-xs leading-relaxed text-on-surface-variant">
          Recorded when this seat launched. Editing or removing the library file does not change it.
        </p>
      </div>

      <div className="border border-outline-variant/60" data-testid="seat-spec-library">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-outline-variant bg-background px-3 py-2">
          <span className={LABEL}>Current library · {originLabel(hostId)}</span>
          {catalog.data && <span className={LABEL}>read {readAge(catalog.dataUpdatedAt)}</span>}
        </div>
        <SeatLibraryState
          hostId={hostId}
          name={name}
          catalog={catalog}
          resolution={resolution}
          otherVersions={otherVersions}
          launchedHash={seat.resolvedSpecHash ?? null}
        />
      </div>

      {exact && renderReview && review.data && review.data.kind === "agent" && review.data.libraryEntryId === exact.id
        ? renderReview(review.data as LibraryAgentReview, exact)
        : null}
      {exact && renderReview && review.error ? (
        <p role="alert" className="text-xs text-red-800" data-testid="seat-spec-review-error">
          Library review unavailable: {(review.error as Error).message}
        </p>
      ) : null}
    </section>
  );
}

function SeatLibraryState({ hostId, name, catalog, resolution, otherVersions, launchedHash }: {
  hostId: string | null;
  name: string | null;
  catalog: ReturnType<typeof useSpecLibrary>;
  resolution: ReturnType<typeof resolveSpec> | null;
  otherVersions: SpecLibraryEntry[];
  launchedHash: string | null;
}) {
  const note = "px-3 py-2 text-xs leading-relaxed";
  if (!name) return <p className={`${note} text-on-surface-variant`} data-testid="seat-spec-unbound">This seat has no recorded spec binding, so no library entry is matched.</p>;
  if (hostId === null) return <p className={`${note} text-on-surface-variant`} data-testid="seat-spec-origin-unknown">The seat's origin is unknown, so no library was read.</p>;
  if (catalog.data === undefined) {
    if (!catalog.error) return <p className={`${note} text-on-surface-variant`}>Reading the library…</p>;
    return (
      <p role="alert" className={`${note} text-red-800`} data-testid="seat-spec-library-failed">
        Library unavailable: {classifyLibraryReadError(catalog.error).message}. Whether the source still exists is unknown.{" "}
        <button type="button" className="underline" onClick={() => void catalog.refetch()}>Retry</button>
      </p>
    );
  }
  const stale = catalog.error ? (
    <p className={`${note} text-amber-800`} data-testid="seat-spec-library-stale">
      The latest library refresh failed; showing the list read {readAge(catalog.dataUpdatedAt)}.
    </p>
  ) : null;
  const drift = otherVersions.length > 0 ? (
    <p className={`${note} text-on-surface-variant`} data-testid="seat-spec-other-versions">
      The library also has {otherVersions.map((entry) => `v${entry.version}`).join(", ")} of {name}; this seat still runs the launched version.
    </p>
  ) : null;
  const hashNote = (
    <p className={`${note} text-on-surface-variant`}>
      The library does not serve a source hash, so whether the current file still matches launched hash {shortHash(launchedHash)} is not asserted.
    </p>
  );
  if (!resolution) return null;
  switch (resolution.state) {
    case "exact":
      return (
        <>
          {stale}
          <div className={note} data-testid="seat-spec-library-exact">
            <LibraryEntryLink entryId={resolution.entry.id} sourceHostId={hostId} className="font-mono font-bold text-on-surface underline decoration-dotted" testId="seat-spec-library-link">
              {resolution.entry.name}
            </LibraryEntryLink>
            <span className="font-mono text-[10px] text-on-surface-variant"> · {candidateFacts(resolution.entry)}</span>
          </div>
          {hashNote}
          {drift}
        </>
      );
    case "ambiguous":
      return (
        <>
          {stale}
          <div className={note} data-testid="seat-spec-library-ambiguous">
            <p className="text-amber-800">{resolution.candidates.length} library entries share this name and version; the binding cannot tell which file was launched.</p>
            <ul className="mt-1 space-y-0.5">
              {resolution.candidates.map((entry) => (
                <li key={entry.id}>
                  {entry.status === "error" ? (
                    <span className="font-mono text-[10px] text-red-800">{candidateFacts(entry)} · invalid: {entry.errorMessage ?? "unparseable"}</span>
                  ) : (
                    <LibraryEntryLink entryId={entry.id} sourceHostId={hostId} className="font-mono text-[10px] underline decoration-dotted">{candidateFacts(entry)}</LibraryEntryLink>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {drift}
        </>
      );
    case "invalid":
      return <>{stale}<p className={`${note} text-red-800`} data-testid="seat-spec-library-invalid">The matching library file is invalid: {resolution.candidates.map((entry) => entry.errorMessage ?? "unparseable").join("; ")}</p></>;
    case "unavailable":
      return (
        <>
          {stale}
          <p className={`${note} text-on-surface-variant`} data-testid="seat-spec-library-missing">
            No current library entry is named {name}{resolution.lookup.version ? ` v${resolution.lookup.version}` : ""}. The source may have been
            removed, renamed or never added to the library; the launched binding above is unchanged.
          </p>
          {drift}
        </>
      );
  }
}
