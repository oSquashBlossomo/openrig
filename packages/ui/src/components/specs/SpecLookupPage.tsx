// Kind/name library lookup (`spec <name>`, `running <spec>`): resolves exact
// served kind+name (optional version) on one exact origin. One openable match
// forwards to its review (replace, so Back skips the lookup); several require
// a choice; none is "unavailable". Never name-as-ID, never first-match.

import { useEffect } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "../WorkspacePage.js";
import { WorkflowHeader } from "../WorkflowScaffold.js";
import { useSpecLibrary } from "../../hooks/useSpecLibrary.js";
import { candidateFacts, classifyLibraryReadError, isSpecKind, readAge, resolveSpec } from "./library-model.js";
import { LibraryEntryLink, originLabel, useHostSelectionState, useLibraryEntryHref } from "./library-reads.js";
import { ObservedSeatsPanel } from "./SpecConsumers.js";

export interface SpecLookupPageProps {
  /** Route params, once-decoded by the router. */
  kind: string;
  name: string;
  /** Raw `?version=` (exact served version bytes). */
  version?: string;
  /** Raw `?source=`: exact origin. Absent → the KNOWN selected host. */
  source?: string;
}

const NOTE = "text-sm leading-relaxed text-on-surface-variant";

export function SpecLookupPage({ kind, name, version, source }: SpecLookupPageProps) {
  const hosts = useHostSelectionState({ active: source === undefined });
  const validKind = isSpecKind(kind);
  // Explicit origin wins; otherwise only a KNOWN selection is an origin.
  const origin = source !== undefined ? source : hosts.state === "known" ? hosts.selected : null;
  const catalog = useSpecLibrary(validKind ? kind : undefined, { sourceHostId: validKind && origin ? origin : null });
  const resolution = validKind && catalog.data ? resolveSpec(catalog.data, { kind, name, ...(version !== undefined ? { version } : {}) }) : null;
  const router = useRouter();
  const entryHref = useLibraryEntryHref();
  const forwardTo = resolution?.state === "exact" && origin ? entryHref(resolution.entry.id, origin) : null;
  useEffect(() => {
    if (forwardTo) router.history.replace(forwardTo);
  }, [forwardTo, router]);

  const title = `${kind} ${name}${version !== undefined ? ` v${version}` : ""}`;
  const back = (
    <Button variant="outline" size="sm" onClick={() => router.history.back()} data-testid="spec-lookup-back">Back</Button>
  );
  const catalogLink = (
    <Link to="/specs" search={{ q: name, ...(validKind ? { kind } : {}) } as never} className="underline" data-testid="spec-lookup-catalog">
      search the library for “{name}”
    </Link>
  );

  let body;
  if (!validKind) {
    body = <p className={NOTE} data-testid="spec-lookup-bad-kind">“{kind}” is not a library spec kind (rig, agent or workflow). Open the Library and {catalogLink}.</p>;
  } else if (origin === null) {
    body = hosts.state === "failed"
      ? <p role="alert" className={`${NOTE} text-red-800`} data-testid="spec-lookup-hosts-failed">The host selection could not be read ({hosts.error.message}), so no library was chosen.</p>
      : <p className={NOTE} data-testid="spec-lookup-hosts-pending">Waiting for the host selection before reading a library…</p>;
  } else if (catalog.data === undefined) {
    body = catalog.error
      ? (
        <p role="alert" className={`${NOTE} text-red-800`} data-testid="spec-lookup-failed">
          The {originLabel(origin)} library is unavailable: {classifyLibraryReadError(catalog.error).message}. The spec may still exist.{" "}
          <button type="button" className="underline" onClick={() => void catalog.refetch()}>Retry</button>
        </p>
      )
      : <p className={NOTE}>Reading the {originLabel(origin)} library…</p>;
  } else if (resolution!.state === "exact") {
    body = (
      <p className={NOTE} data-testid="spec-lookup-exact">
        Opening <LibraryEntryLink entryId={resolution!.entry.id} sourceHostId={origin} className="underline">{candidateFacts(resolution!.entry)}</LibraryEntryLink>…
      </p>
    );
  } else if (resolution!.state === "unavailable") {
    body = (
      <p className={NOTE} data-testid="spec-lookup-unavailable">
        No {kind} spec named “{name}”{version !== undefined ? ` at version ${version}` : ""} is in the {originLabel(origin)} library
        (read {readAge(catalog.dataUpdatedAt)}). You can {catalogLink}.
      </p>
    );
  } else {
    const candidates = resolution!.state === "ambiguous" ? resolution!.candidates : resolution!.candidates;
    body = (
      <div className="space-y-2" data-testid={resolution!.state === "ambiguous" ? "spec-lookup-ambiguous" : "spec-lookup-invalid"}>
        <p className={NOTE}>
          {resolution!.state === "ambiguous"
            ? `${candidates.length} entries in the ${originLabel(origin)} library match. Choose the exact one:`
            : "The matching library file is invalid and cannot be opened:"}
        </p>
        <ul className="divide-y divide-outline-variant border border-outline-variant">
          {candidates.map((entry) => (
            <li key={entry.id} className="px-3 py-2 font-mono text-xs" data-testid="spec-lookup-candidate">
              {entry.status === "error" ? (
                <span className="text-red-800">{candidateFacts(entry)} · invalid: {entry.errorMessage ?? "unparseable"}</span>
              ) : (
                <LibraryEntryLink entryId={entry.id} sourceHostId={origin} className="underline decoration-dotted">
                  <span className="font-bold">{entry.name}</span> · {candidateFacts(entry)}
                </LibraryEntryLink>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <WorkspacePage>
      <div data-testid="spec-lookup" className="space-y-4">
        <WorkflowHeader eyebrow="Library lookup" title={title} description={`Exact ${validKind ? kind : "spec"} name lookup${origin ? ` on ${originLabel(origin)}` : ""}.`} actions={back} />
        {catalog.data && catalog.error ? (
          <p className="text-xs text-amber-800" data-testid="spec-lookup-stale">The latest library refresh failed; using the list read {readAge(catalog.dataUpdatedAt)}.</p>
        ) : null}
        {body}
        {validKind && kind === "agent" && origin && resolution?.state !== "exact" && (
          <ObservedSeatsPanel hostId={origin} name={name} version={version} agentEntries={catalog.data} />
        )}
      </div>
    </WorkspacePage>
  );
}
