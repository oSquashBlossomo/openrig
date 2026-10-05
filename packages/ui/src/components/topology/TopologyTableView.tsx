// V1 attempt-3 Phase 3: Topology table view per topology-table-view.md + SC-25.
//
// Tanstack-backed table; row per agent across topology, scoped by URL.
//
// V1 attempt-3 Phase 5 P5-9 ship-gate bounce P0-1: rules-of-hooks fix.
// Previous shape used `scopedRigs.map((r) => useNodeInventory(r.id))` which
// calls hooks in a loop with variable count. When scopedRigs grew from 0
// (initial render before useRigSummary resolves) to N (after resolution),
// React detected the hook count change and threw "Cannot read properties
// of undefined (reading 'length')" downstream. This crashed /topology at
// 375x812 mobile because P5-9 mounts the table immediately at first
// render (graph view-mode degraded to table for narrow viewports) BEFORE
// rigs data is available. Switched to `useQueries` from React Query:
// single hook call regardless of array length.

import { memo, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useQueries } from "@tanstack/react-query";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import type { NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { VellumInput } from "../ui/vellum-input.js";
import { StatusPip } from "../ui/status-pip.js";
import { inferPodName } from "../../lib/display-name.js";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { useTopologyActivity } from "../../hooks/useTopologyActivity.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { NodeInventoryPartialReadError, readNodeInventory } from "../../lib/fleet-inventory-reads.js";
import {
  buildTopologySessionIndex,
  type TopologyActivityBaseline,
  type TopologyActivityVisual,
} from "../../lib/topology-activity.js";
import { ActivityRing } from "./ActivityRing.js";
import { TerminalPreviewPopover } from "./TerminalPreviewPopover.js";
import "./topology-table-shimmer.css";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../../lib/token-format.js";
import { contextUsageTextClass } from "../ContextUsageRing.js";
import { freshTopologyVisitState, topologyTarget, useKnownSelectedHost } from "./topology-navigation.js";

/** One rig's inventory as THIS table may present it. Each state is a single
 *  observation: a newer partial response and an older successful array are
 *  never spliced, and older rows are never relabelled as fresh. */
export type RigInventoryView =
  | { kind: "pending" }
  | { kind: "current"; rows: NodeInventoryEntry[]; at: number }
  /** A successful HTTP array with rejected (malformed/foreign/incomplete)
   *  records: only its validated same-rig rows, dated by receipt. Empty rows
   *  = all-invalid, which is not a successful empty inventory. */
  | { kind: "partial"; rows: NodeInventoryEntry[]; rejectedCount: number; at: number }
  /** The latest read failed (HTTP, non-array, timeout…); rows are the last
   *  successful array, dated by that success. */
  | { kind: "stale"; rows: NodeInventoryEntry[]; at: number; reason: string }
  | { kind: "unavailable"; reason: string };

const readFailure = (error: unknown) => (error instanceof Error ? error.message : "read failed");

export function rigInventoryView(
  query: { data?: NodeInventoryEntry[]; error: unknown; isError: boolean; dataUpdatedAt: number },
  source: { hostId: string; rigId: string },
): RigInventoryView {
  if (query.isError) {
    const partial = query.error instanceof NodeInventoryPartialReadError ? query.error.partial : null;
    // Evidence is admitted only for the exact source and rig being shown.
    if (partial && partial.hostId === source.hostId && partial.rigId === source.rigId) {
      return { kind: "partial", rows: partial.rows.filter((row) => row.rigId === source.rigId), rejectedCount: partial.rejectedCount, at: partial.receivedAt };
    }
    return query.data !== undefined
      ? { kind: "stale", rows: query.data, at: query.dataUpdatedAt, reason: readFailure(query.error) }
      : { kind: "unavailable", reason: readFailure(query.error) };
  }
  return query.data !== undefined ? { kind: "current", rows: query.data, at: query.dataUpdatedAt } : { kind: "pending" };
}

function ReadTime({ at }: { at: number }) {
  const date = new Date(at);
  return <time dateTime={date.toISOString()} title={date.toISOString()}>{date.toLocaleTimeString()}</time>;
}

interface AgentRow {
  rigId: string;
  rigName: string;
  podName: string;
  logicalId: string;
  sessionName: string;
  runtime: string;
  status: string;
  startupStatus: string | null;
  contextUsage?: NodeInventoryEntry["contextUsage"] | null;
  agentActivity?: TopologyActivityBaseline["agentActivity"];
  currentQitems?: TopologyActivityBaseline["currentQitems"];
  terminalActive?: boolean | null;
  hasAssignedWork?: boolean;
  pendingWorkCount?: number;
  activityRing?: TopologyActivityVisual;
  reducedMotion?: boolean;
  /** Which observation the row comes from (current, partial or stale). */
  inventoryState?: "current" | "partial" | "stale";
}

function statusToSemanticPip(s: string): "active" | "running" | "stopped" | "warning" | "error" | "info" {
  if (s === "running" || s === "ready") return "running";
  if (s === "active") return "active";
  if (s === "stopped") return "stopped";
  if (s === "attention_required" || s === "warning") return "warning";
  if (s === "failed" || s === "error") return "error";
  return "info";
}

function CmuxButton({ row }: { row: AgentRow }) {
  // V0.3.1 slice 14 walk-item 16: action column buttons stay visible
  // unconditionally (no hover/focus gate). Prior implementation used
  // `opacity-0` + `group-hover:!opacity-100` which hid the affordance
  // off-mouse — operators kept missing the cmux launcher.
  const cmuxLaunch = useCmuxLaunch();
  // OPR.0.4.1.31 part B — surface the mutation error. Previously the button
  // tracked only isPending, so a failed open-cmux (no current cmux workspace,
  // missing terminal bearer, etc.) failed SILENTLY = "the button never works."
  // Now a failure shows a visible, actionable message (TanStack isError/error)
  // and a click while errored resets + retries.
  const failed = cmuxLaunch.isError;
  const errorMessage = failed
    ? (cmuxLaunch.error instanceof Error ? cmuxLaunch.error.message : String(cmuxLaunch.error))
    : null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        data-testid={`topology-table-cmux-${row.logicalId}`}
        onClick={(e) => {
          e.stopPropagation();
          // OPR.0.4.1.31 part D — never POST open-cmux for a malformed row
          // (a null/empty logicalId would build /nodes/"null"/open-cmux).
          if (!row.logicalId) return;
          if (cmuxLaunch.isError) cmuxLaunch.reset();
          cmuxLaunch.mutate({ rigId: row.rigId, logicalId: row.logicalId });
        }}
        aria-busy={cmuxLaunch.isPending || undefined}
        aria-label={
          cmuxLaunch.isPending
            ? `Opening ${row.logicalId} in cmux`
            : failed
              ? `Open ${row.logicalId} in cmux failed: ${errorMessage}. Click to retry.`
              : `Open ${row.logicalId} in cmux`
        }
        title={
          cmuxLaunch.isPending
            ? "Opening in cmux"
            : failed
              ? `Failed: ${errorMessage} — click to retry`
              : "Open in cmux"
        }
        disabled={cmuxLaunch.isPending}
        data-error={failed || undefined}
        className={`inline-flex h-7 w-7 items-center justify-center border bg-surface-lowest/65 shadow-[1px_1px_0_rgba(46,52,46,0.12)] transition-colors focus:outline-none focus:ring-2 focus:ring-on-surface/20 disabled:cursor-wait disabled:opacity-60 ${
          failed
            ? "border-rose-400 text-rose-700 hover:bg-rose-50"
            : "border-outline-variant text-on-surface hover:bg-surface-low hover:text-on-surface"
        }`}
      >
        <ToolMark tool="cmux" size="sm" />
        <span className="sr-only">CMUX</span>
      </button>
      {failed ? (
        <span
          data-testid={`topology-table-cmux-error-${row.logicalId}`}
          role="alert"
          className="font-mono text-[9px] text-rose-700 max-w-[220px] leading-tight whitespace-normal break-words"
        >
          {errorMessage}
        </span>
      ) : null}
    </span>
  );
}

/** V0.3.1 slice 14 walk-item 15 — status label split. When the row's
 *  activity ring is in the `active` state the cell shows "active" with
 *  a subtle left-to-right shimmer; otherwise it shows "idle" (or the
 *  raw status string for non-running states like "starting" / "failed").
 *  Honors `prefers-reduced-motion: reduce` via CSS — see
 *  `topology-shimmer` in `topology-table-shimmer.css`.
 *
 *  V0.3.1 bug-fix slice topology-perf: memoized so that
 *  useTopologyActivity bumps (1s interval + per-stream-event) don't
 *  re-render every active-status cell across a large topology when
 *  only one row's activityState changed. */
const StatusCell = memo(function StatusCell({ status, activityState }: { status: string; activityState: string | undefined }) {
  const semantic = statusToSemanticPip(status);
  // Only split the "running" status into active/idle. Other statuses
  // (starting / stopped / failed / unknown) keep their raw label.
  const isRunning = status === "running" || status === "ready";
  const isActive = isRunning && activityState === "active";
  const isIdle = isRunning && !isActive;
  const label = isActive ? "active" : isIdle ? "idle" : status;
  const labelClass = isActive ? "topology-table-active-shimmer" : "";
  return (
    <span data-testid={`topology-table-status-${activityState ?? "unknown"}`} data-activity-state={activityState ?? null}>
      <StatusPip status={semantic} label={label} variant="pill" labelClassName={labelClass} />
    </span>
  );
});
StatusCell.displayName = "StatusCell";

/** V0.3.1 bug-fix slice topology-perf: memoized to skip re-render when
 *  the parent table rebuilds rows for a 1s activity bump but this
 *  row's context-usage payload didn't change. */
const ContextCell = memo(function ContextCell({ row }: { row: AgentRow }) {
  const usage = row.contextUsage;
  const known = usage?.availability === "known" && typeof usage.usedPercentage === "number";
  return (
    <span
      data-testid={`topology-table-context-${row.logicalId}`}
      className={`font-mono text-xs font-bold ${contextUsageTextClass(usage?.usedPercentage, usage?.fresh, usage?.availability)}`}
      title={
        known
          ? usage?.fresh === false
            ? "Context usage (stale sample)"
            : "Context usage (fresh)"
          : "Context sample unavailable"
      }
    >
      {known ? `${usage.usedPercentage}%` : "--"}
    </span>
  );
}, (prev, next) => {
  const a = prev.row.contextUsage;
  const b = next.row.contextUsage;
  return (
    prev.row.logicalId === next.row.logicalId &&
    a?.availability === b?.availability &&
    a?.usedPercentage === b?.usedPercentage &&
    a?.fresh === b?.fresh
  );
});
ContextCell.displayName = "ContextCell";

/** V0.3.1 bug-fix slice topology-perf: memoized; token cell content
 *  only depends on the (input, output) token pair which is stable
 *  across most bumps. */
const TokenCell = memo(function TokenCell({ row }: { row: AgentRow }) {
  const usage = row.contextUsage;
  const total = sumTokenCounts(usage?.totalInputTokens, usage?.totalOutputTokens);
  const tokenLabel = formatCompactTokenCount(total);
  const tokenTitle = formatTokenTotalTitle(usage?.totalInputTokens, usage?.totalOutputTokens);
  return (
    <span
      data-testid={`topology-table-tokens-${row.logicalId}`}
      className={`font-mono text-xs font-bold ${tokenLabel ? "text-on-surface-variant" : "text-on-surface-variant"}`}
      title={tokenTitle ?? "Token sample unavailable"}
    >
      {tokenLabel ?? "--"}
    </span>
  );
}, (prev, next) => {
  const a = prev.row.contextUsage;
  const b = next.row.contextUsage;
  return (
    prev.row.logicalId === next.row.logicalId &&
    a?.totalInputTokens === b?.totalInputTokens &&
    a?.totalOutputTokens === b?.totalOutputTokens
  );
});
TokenCell.displayName = "TokenCell";

function agentColumns(): ColumnDef<AgentRow>[] {
  return [
    { accessorKey: "rigName", header: "Rig", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
    { accessorKey: "podName", header: "Pod", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
    {
      accessorKey: "logicalId",
      header: "Agent",
      cell: ({ row }) => (
        <ActivityRing
          as="span"
          state={row.original.activityRing?.state ?? "idle"}
          flash={row.original.activityRing?.flash ?? null}
          reducedMotion={row.original.reducedMotion}
          testId={`topology-table-activity-ring-${row.original.logicalId}`}
          className="inline-flex rounded-sm"
          ringClassName="-inset-1"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs">
            <span className="truncate">{row.original.logicalId}</span>
          </span>
        </ActivityRing>
      ),
    },
    {
      accessorKey: "runtime",
      header: "Runtime",
      cell: ({ getValue }) => (
        <RuntimeBadge runtime={String(getValue() ?? "")} size="xs" compact variant="inline" />
      ),
    },
    {
      id: "context",
      header: "Context",
      sortingFn: (a, b) => (a.original.contextUsage?.usedPercentage ?? -1) - (b.original.contextUsage?.usedPercentage ?? -1),
      cell: ({ row }) => <ContextCell row={row.original} />,
    },
    {
      id: "tokens",
      header: "Tokens",
      sortingFn: (a, b) => {
        const left = sumTokenCounts(a.original.contextUsage?.totalInputTokens, a.original.contextUsage?.totalOutputTokens) ?? -1;
        const right = sumTokenCounts(b.original.contextUsage?.totalInputTokens, b.original.contextUsage?.totalOutputTokens) ?? -1;
        return left - right;
      },
      cell: ({ row }) => <TokenCell row={row.original} />,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ getValue, row }) => (
        <StatusCell
          status={String(getValue())}
          activityState={row.original.activityRing?.state}
        />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      // V0.3.1 slice 14 walk-item 16: action column shows cmux +
      // terminal-preview side-by-side, no hover gate. Both buttons
      // render at all times for predictable affordances.
      cell: ({ row }) => <TopologyActionsCell row={row.original} />,
    },
  ];
}

/** OPR.0.4.6.MH2 rev1-r2 B1 — cmux launch + terminal preview are LOCAL
 *  actions (bare local POST / local session reads); with a remote host
 *  selected the row data is the REMOTE host's, so the local affordances
 *  are gated behind an honest read-only marker (FR-7: no cross-host
 *  mutation offered on remote views). */
function TopologyActionsCell({ row }: { row: AgentRow }) {
  const isRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  if (isRemote) {
    return (
      <span
        data-testid={`topology-table-actions-${row.logicalId}`}
        data-remote-readonly="true"
        className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant"
      >
        read-only
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={`topology-table-actions-${row.logicalId}`}>
      <CmuxButton row={row} />
      {row.rigId ? (
        <TerminalPreviewPopover
          rigId={row.rigId}
          logicalId={row.logicalId}
          sessionName={row.sessionName ?? null}
          reducedMotion={false}
          testIdPrefix={`topology-table-${row.logicalId}`}
          buttonClassName="inline-flex h-7 w-7 items-center justify-center border border-outline-variant bg-surface-lowest/65 text-on-surface shadow-[1px_1px_0_rgba(46,52,46,0.12)] transition-colors hover:bg-surface-low hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-on-surface/20"
          progressive
        />
      ) : null}
    </span>
  );
}

export function TopologyTableView({ rigIdScope, podNameScope }: { rigIdScope?: string; podNameScope?: string }) {
  // V1 polish slice Phase 5.1 P5.1-7: row click navigates to seat-scope
  // center page (parity with graph node click + Explorer tree click +
  // Topology Tree details-icon-retired contract).
  const navigate = useNavigate();
  const hostId = useSelectedHostId();
  const linkSource = useKnownSelectedHost();
  const { data: rigs, isError: rigsFailed, error: rigsError } = useRigSummary();
  const reducedMotion = usePrefersReducedMotion();
  const scopedRigs = useMemo(
    () =>
      rigIdScope
        ? rigs?.filter((r) => r.id === rigIdScope) ?? []
        : rigs ?? [],
    [rigs, rigIdScope],
  );

  // P0-1 fix: useQueries replaces the .map(useNodeInventory) loop. Single
  // hook call regardless of scopedRigs length. React's hook order stays
  // stable across renders even when rigs grows from undefined to [N].
  const inventoryResults = useQueries({
    queries: scopedRigs.map((r) => ({
      queryKey: ["rig", r.id, "nodes", hostId] as const,
      // The shared bounded reader (deadline, cancellation, exact-rig guard):
      // same key/poll as useNodeInventory, no second transport or cache.
      queryFn: ({ signal }: { signal: AbortSignal }) => readNodeInventory(r.id, hostId, { signal }),
      refetchInterval: 30_000,
      retry: false,
      placeholderData: undefined,
    })),
    // Only the facts a view is derived from, structurally shared across
    // renders, so fetching-only changes do not rebuild rows (and the
    // activity index derived from them) on every render.
    combine: (results) => results.map((q) => ({ data: q.data, error: q.error, isError: q.isError, dataUpdatedAt: q.dataUpdatedAt })),
  });
  const inventoryViews = useMemo(
    () => scopedRigs.map((rig, i) => {
      const result = inventoryResults[i];
      return result ? rigInventoryView(result, { hostId, rigId: rig.id }) : ({ kind: "pending" } as const);
    }),
    [scopedRigs, inventoryResults, hostId],
  );

  const data: AgentRow[] = useMemo(() => {
    const rows: AgentRow[] = [];
    for (let i = 0; i < scopedRigs.length; i++) {
      const rig = scopedRigs[i];
      const view = inventoryViews[i];
      if (!rig || !view) continue;
      const nodes: NodeInventoryEntry[] = "rows" in view ? view.rows : [];
      const scopedNodes = podNameScope
        ? nodes.filter((n) => (n.podNamespace ?? n.podId) === podNameScope)
        : nodes;
      for (const n of scopedNodes) {
        rows.push({
          inventoryState: view.kind === "partial" || view.kind === "stale" ? view.kind : "current",
          rigId: rig.id,
          rigName: rig.name,
          podName: inferPodName(n.logicalId) ?? "default",
          logicalId: n.logicalId,
          sessionName: n.canonicalSessionName ?? n.logicalId,
          runtime: (n.runtime ?? "-") as string,
          status: (n.sessionStatus ?? "unknown") as string,
          startupStatus: (n.startupStatus ?? null) as string | null,
          contextUsage: n.contextUsage ?? null,
          agentActivity: n.agentActivity ?? null,
          currentQitems: n.currentQitems ?? [],
          terminalActive: n.terminalActive,
          hasAssignedWork: n.hasAssignedWork ?? false,
          pendingWorkCount: n.pendingWorkCount ?? 0,
        });
      }
    }
    return rows;
  }, [scopedRigs, inventoryViews, podNameScope]);

  const sessionIndex = useMemo(() => buildTopologySessionIndex(data.map((row) => ({
    nodeId: `${row.rigId}::${row.logicalId}`,
    rigId: row.rigId,
    rigName: row.rigName,
    logicalId: row.logicalId,
    canonicalSessionName: row.sessionName,
    agentActivity: row.agentActivity ?? null,
    currentQitems: row.currentQitems ?? null,
    startupStatus: row.startupStatus,
    terminalActive: row.terminalActive,
    hasAssignedWork: row.hasAssignedWork ?? false,
    pendingWorkCount: row.pendingWorkCount ?? 0,
  }))), [data]);
  const topologyActivity = useTopologyActivity(sessionIndex);
  const activityData = useMemo(() => data.map((row) => ({
    ...row,
    activityRing: topologyActivity.getNodeActivity(`${row.rigId}::${row.logicalId}`, row),
    reducedMotion,
  })), [data, topologyActivity, reducedMotion]);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState("");
  const columns = useMemo(() => agentColumns(), []);

  const table = useReactTable({
    data: activityData,
    columns,
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const q = String(filterValue ?? "").toLowerCase();
      if (!q) return true;
      const r = row.original;
      // OPR.0.4.1.13 (crash fix): NULL-SAFE every field. The table builds a row for
      // EVERY node and does NOT default rigName (rig.name) or logicalId (n.logicalId)
      // at build, so a malformed inventory entry (null name / null logicalId - a real
      // edge data shape) made `r.rigName.toLowerCase()` / `r.logicalId.toLowerCase()`
      // throw HERE during the filtered-row-model build, white-screening /topology
      // (no error boundary). `String(v ?? "")` is null-safe for all five fields.
      const hay = (v: unknown) => String(v ?? "").toLowerCase();
      return (
        hay(r.rigName).includes(q) ||
        hay(r.podName).includes(q) ||
        hay(r.logicalId).includes(q) ||
        hay(r.runtime).includes(q) ||
        hay(r.status).includes(q)
      );
    },
  });

  // A pending or failed read is not "no agents": say which it is, per rig.
  const rigLabel = (i: number) => scopedRigs[i]?.name ?? scopedRigs[i]?.id ?? "rig";
  const failedInventories = inventoryViews.flatMap((v, i) => (v.kind === "unavailable" ? [{ name: rigLabel(i), reason: v.reason }] : []));
  const partialInventories = inventoryViews.flatMap((v, i) => (v.kind === "partial" ? [{ name: rigLabel(i), view: v }] : []));
  const staleInventories = inventoryViews.flatMap((v, i) => (v.kind === "stale" ? [{ name: rigLabel(i), view: v }] : []));
  const inventoryPending = rigs === undefined
    ? !rigsFailed
    : inventoryViews.some((v) => v.kind === "pending");

  return (
    <div data-testid="topology-table-view" className="space-y-3 mt-4">
      {rigsFailed ? (
        <div data-testid="topology-table-inventory-error" role="alert" className="font-mono text-[10px] text-error">
          {rigs === undefined
            ? `Rig inventory unavailable: ${rigsError instanceof Error ? rigsError.message : "read failed"}.`
            : "Rig inventory refresh failed; rows below are from the last successful read."}
        </div>
      ) : null}
      {failedInventories.length > 0 ? (
        <div data-testid="topology-table-rig-errors" role="alert" className="font-mono text-[10px] text-error">
          Agents not listed for {failedInventories.length} rig{failedInventories.length === 1 ? "" : "s"} whose inventory could not be read:{" "}
          {failedInventories.slice(0, 6).map((f) => `${f.name} (${f.reason})`).join(", ")}
          {failedInventories.length > 6 ? ", …" : ""}.
        </div>
      ) : null}
      {partialInventories.map(({ name, view }) => (
        <div key={`partial-${name}`} data-testid="topology-table-inventory-partial" role="status" className="font-mono text-[10px] text-tertiary">
          {view.rows.length > 0
            ? <>{name}: partial inventory — {view.rows.length} verified agent{view.rows.length === 1 ? "" : "s"} shown; {view.rejectedCount} record{view.rejectedCount === 1 ? "" : "s"} rejected as malformed or foreign (read <ReadTime at={view.at} />).</>
            : <>{name}: inventory read at <ReadTime at={view.at} /> had no valid agent records ({view.rejectedCount} rejected) — agents not listed.</>}
        </div>
      ))}
      {staleInventories.map(({ name, view }) => (
        <div key={`stale-${name}`} data-testid="topology-table-inventory-stale" role="status" className="font-mono text-[10px] text-on-surface-variant">
          {name}: refresh failed ({view.reason}); its rows are from the last successful read at <ReadTime at={view.at} />.
        </div>
      ))}
      <div className="flex items-center gap-2">
        <VellumInput
          placeholder="Filter agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          testId="topology-table-search"
        />
        <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant ml-auto">
          {table.getFilteredRowModel().rows.length} of {activityData.length}
        </span>
      </div>
      <div className="border border-outline-variant overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-background border-b border-outline-variant">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant cursor-pointer select-none"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: " ↑", desc: " ↓" }[h.column.getIsSorted() as string] ?? null}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center font-mono text-xs text-on-surface-variant">
                  {activityData.length === 0 && inventoryPending
                    ? "Reading agents…"
                    : activityData.length === 0 && (rigsFailed || failedInventories.length > 0 || partialInventories.some((p) => p.view.rows.length === 0))
                      ? "No agents could be read."
                      : "No agents match."}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`topology-table-row-${row.original.logicalId}`}
                  data-inventory-state={row.original.inventoryState}
                  onClick={() => {
                    // OPR.0.4.1.31 part D — guard malformed rows: a null/empty
                    // logicalId would build /seat/$rigId/"null"
                    // (encodeURIComponent(null) === "null"). Skip navigation for
                    // such rows instead of routing to a bogus seat URL.
                    if (!row.original.logicalId) return;
                    // Raw params through the shared builder (router encodes once).
                    const target = topologyTarget({
                      scope: { kind: "seat", rigId: row.original.rigId, logicalId: row.original.logicalId },
                      sourceHost: linkSource,
                    });
                    if (target) {
                      navigate({ to: target.to, params: target.params, search: target.search, state: freshTopologyVisitState } as never);
                    }
                  }}
                  className="group border-b border-outline-variant last:border-b-0 hover:bg-surface-low focus-within:bg-surface-low cursor-pointer"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
