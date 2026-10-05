// OPR.0.4.6.WF4 (C4) Option B — the operational WORKFLOWS altitude.
//
// ZOOM-ADDRESSED like /agents (arch drift-killer 4 — deliberately not in any
// nav rail; pm/founder confirmed addressable-not-in-nav for v1, no rail icon):
// reached from NEEDS-YOU workflow rows, instance deep-links, and the Library
// page. One glance answers: what is running, where each instance is, what needs
// attention — attention FIRST, in the blessed NEEDS-YOU-first reading order.
//
// FR-4 parity: composed CLIENT-side over the same GET /api/workflow/list +
// /api/workflow/specs reads the WF-3 CLI composes its status rollup from
// (commands/workflow.ts defers a daemon rollup endpoint to a named future
// trigger; this page does arithmetic over daemon-classified rows only, Q4).

import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "../WorkspacePage.js";
import { WorkflowHeader } from "../WorkflowScaffold.js";
import {
  useWorkflowInstances,
  useWorkflowSpecs,
  type WorkflowInstanceWithDeadline,
} from "../../hooks/useWorkflow.js";
import { WorkflowInstanceRow, instanceAttentionRank } from "./WorkflowInstancesBand.js";
import { useSpecLibrary } from "../../hooks/useSpecLibrary.js";
import { CONNECTED_SPEC_SOURCE, matchWorkflowSpec, specReadFreshness, useOpenLibraryEntry, type SpecReadFreshness, type WorkflowSpecMatch } from "./workflow-spec-identity.js";
import { Timestamp } from "../project/catalog/evidence-ui.js";

/** Where spec links come from and how current that read is. A failed refresh
 * of a warm catalog keeps its exact matches only as the last successful read,
 * dated by that read; a cold failure disables links; nothing is borrowed from
 * the selected topology host. */
function SpecCatalogStatus({ catalog, onRetry }: { catalog: SpecReadFreshness; onRetry: () => void }) {
  const retry = (
    <button type="button" data-testid="workflows-spec-catalog-retry" disabled={catalog.fetching} onClick={onRetry}
      className="ml-2 border border-outline-variant px-2 py-0.5 uppercase hover:bg-surface-low disabled:opacity-50">
      {catalog.fetching ? "Refreshing…" : "Retry"}
    </button>
  );
  if (!catalog.retained && catalog.error) {
    return (
      <div role="alert" data-testid="workflows-spec-catalog-unavailable" className="border border-tertiary px-3 py-2 font-mono text-[11px]">
        <span className="text-tertiary">Workflow library unavailable on the connected instance</span>
        <span className="ml-2 text-on-surface-variant">{catalog.error.message}. Spec links are disabled; no other host&apos;s library is used.</span>
        {retry}
      </div>
    );
  }
  if (!catalog.retained) {
    return <p role="status" data-testid="workflows-spec-catalog-pending" className="font-mono text-[10px] text-on-surface-variant">Reading the connected instance&apos;s workflow library for spec links…</p>;
  }
  const readAt = <Timestamp iso={catalog.readAt} testId="workflows-spec-catalog-read-at" />;
  if (catalog.error) {
    return (
      <div role="alert" data-testid="workflows-spec-catalog-stale" className="border border-warning px-3 py-2 font-mono text-[11px]">
        <span className="text-warning">Workflow library refresh failed · spec links use the last successful catalog read</span>
        <span className="ml-2 text-on-surface-variant">{catalog.error.message}. Last successful read {readAt}; links may no longer match the library. No other host&apos;s library is used.</span>
        {retry}
      </div>
    );
  }
  return <p data-testid="workflows-spec-catalog-current" className="font-mono text-[10px] text-on-surface-variant">Spec links: the connected instance&apos;s workflow library · catalog read {readAt}</p>;
}

/** Unambiguous (name, version) key: a colon in either part cannot collide. */
const tupleKey = (name: string, version: string) => JSON.stringify([name, version]);

function specLinkTitle(match: WorkflowSpecMatch, catalog: SpecReadFreshness): string {
  const stale = catalog.retained && catalog.error !== null;
  switch (match.kind) {
    case "matched": return stale
      ? `Library entry ${match.entry.id} on the connected instance, from the last successful catalog read (${catalog.readAt ?? "time not recorded"}); the latest refresh failed`
      : `Library entry ${match.entry.id} on the connected instance`;
    case "pending": return "Reading the connected instance's workflow library…";
    case "unavailable": return "The connected instance's workflow library could not be read";
    case "absent": return stale
      ? `No exact entry in the last successful catalog read (${catalog.readAt ?? "time not recorded"}); the latest refresh failed`
      : "No library entry on the connected instance matches this name and version exactly";
    case "ambiguous": return `${match.entries.length} library entries match exactly; none is chosen`;
  }
}

function groupByWorkflow(
  rows: WorkflowInstanceWithDeadline[],
): Array<{ key: string; name: string; version: string; rows: WorkflowInstanceWithDeadline[] }> {
  const byKey = new Map<string, WorkflowInstanceWithDeadline[]>();
  for (const r of rows) {
    const key = tupleKey(r.workflowName, r.workflowVersion);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  const groups = [...byKey.entries()].map(([key, groupRows]) => ({
    key,
    name: groupRows[0]!.workflowName,
    version: groupRows[0]!.workflowVersion,
    rows: groupRows.sort((a, b) => instanceAttentionRank(a) - instanceAttentionRank(b)),
  }));
  // Attention-first between groups too: a group ranks by its hottest row.
  groups.sort((a, b) => instanceAttentionRank(a.rows[0]!) - instanceAttentionRank(b.rows[0]!));
  return groups;
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const { data: instances, isLoading, error, refetch } = useWorkflowInstances();
  const { data: specsData } = useWorkflowSpecs();
  // Spec links resolve the exact served entry from the same connected
  // instance as the instance list; IDs are never built from name/version.
  const specCatalog = useSpecLibrary("workflow", { sourceHostId: CONNECTED_SPEC_SOURCE });
  const openLibraryEntry = useOpenLibraryEntry();
  const catalogRead = specReadFreshness(specCatalog);
  const catalogStale = catalogRead.retained && catalogRead.error !== null;
  const specMatch = (name: string, version: string): WorkflowSpecMatch => specCatalog.data === undefined && specCatalog.error
    ? { kind: "unavailable", error: specCatalog.error } : matchWorkflowSpec(specCatalog.data, name, version);

  const rows = instances ?? [];
  const groups = groupByWorkflow(rows);
  const attention = rows.filter((r) => instanceAttentionRank(r) <= 1).length;
  const live = rows.filter((r) => r.status === "active" || r.status === "waiting").length;
  const closed = rows.filter((r) => r.status === "completed").length;
  const aborted = rows.filter((r) => r.status === "aborted").length;
  const unread = error !== null && instances === undefined;

  const instantiatedNames = new Set(rows.map((r) => tupleKey(r.workflowName, r.workflowVersion)));
  const idleSpecs = (specsData?.specs ?? []).filter((s) => !instantiatedNames.has(tupleKey(s.name, s.version)));

  return (
    <WorkspacePage>
      <div data-testid="workflows-page" className="space-y-6">
        <WorkflowHeader
          eyebrow="Workflows"
          title="Deterministic Runs"
          description={
            isLoading
              ? "Loading instances…"
              : unread
                ? "Instances unavailable — the list could not be read"
                : `${rows.length} instance${rows.length === 1 ? "" : "s"} · ${attention} need attention · ${live} live · ${closed} completed${aborted ? ` · ${aborted} aborted` : ""} — computed from /api/workflow/list`
          }
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>
              Workflow Library
            </Button>
          }
        />

        {error ? (
          <div role="alert" data-testid={unread ? "workflows-error" : "workflows-stale"} className="border border-tertiary px-3 py-2 font-mono text-[11px]">
            <span className="text-tertiary">{unread ? "Workflow instances unavailable" : "Refresh failed — showing the last successful read"}</span>
            <span className="ml-2 text-on-surface-variant">{error.message}</span>
            <button type="button" onClick={() => void refetch()} className="ml-2 border border-outline-variant px-2 py-0.5 uppercase hover:bg-surface-low">Retry</button>
          </div>
        ) : null}

        <SpecCatalogStatus catalog={catalogRead} onRetry={() => void specCatalog.refetch()} />

        {rows.length === 0 && !isLoading && !unread ? (
          <p data-testid="workflows-empty" className="font-mono text-[11px] text-on-surface-variant">
            0 instances — instantiate one from a library spec (rig workflow instantiate) and it appears here
            with its live position.
          </p>
        ) : null}

        {groups.map((g) => {
          const gAttention = g.rows.filter((r) => instanceAttentionRank(r) <= 1).length;
          const gLive = g.rows.filter((r) => r.status === "active" || r.status === "waiting").length;
          const gSpec = specMatch(g.name, g.version);
          return (
            <section key={g.key} data-testid={`workflows-group-${g.name}`} className="space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`workflows-group-spec-${g.name}`}
                  data-spec={gSpec.kind}
                  data-stale={catalogStale ? "true" : "false"}
                  disabled={gSpec.kind !== "matched"}
                  title={specLinkTitle(gSpec, catalogRead)}
                  onClick={() => { if (gSpec.kind === "matched") openLibraryEntry(gSpec.entry.id); }}
                  className="font-mono text-[11px] font-bold text-on-surface underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline"
                >
                  {g.name} v{g.version}
                </button>
                <span className="font-mono text-[10px] text-on-surface-variant">
                  {g.rows.length} instance{g.rows.length === 1 ? "" : "s"} · {gLive} live
                  {gAttention > 0 ? ` · ▲ ${gAttention}` : ""}
                </span>
              </div>
              <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
                {g.rows.map((i) => (
                  <WorkflowInstanceRow key={i.instanceId} instance={i} />
                ))}
              </ul>
            </section>
          );
        })}

        {idleSpecs.length > 0 ? (
          <section data-testid="workflows-idle-specs" className="space-y-2">
            <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">
              Cached Specs — No Instances
            </div>
            <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
              {idleSpecs.map((s) => {
                const sSpec = specMatch(s.name, s.version);
                return (
                <li key={tupleKey(s.name, s.version)}>
                  <button
                    type="button"
                    data-testid={`workflows-idle-spec-${s.name}`}
                    data-spec={sSpec.kind}
                    data-stale={catalogStale ? "true" : "false"}
                    disabled={sSpec.kind !== "matched"}
                    title={specLinkTitle(sSpec, catalogRead)}
                    onClick={() => { if (sSpec.kind === "matched") openLibraryEntry(sSpec.entry.id); }}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-variant/50 disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="font-mono text-[11px] text-on-surface-variant" aria-hidden>
                      ◌
                    </span>
                    <span className="font-mono text-[11px] text-on-surface">
                      {s.name} v{s.version}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-on-surface-variant">
                      {s.purpose ?? ""}
                    </span>
                    <span className="font-mono text-[10px] text-on-surface-variant">
                      {s.isBuiltIn ? "built-in" : "user file"} · 0 instances
                    </span>
                  </button>
                </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </WorkspacePage>
  );
}
