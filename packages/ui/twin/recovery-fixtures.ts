// TEST-ONLY sanitized fixtures for seat startup, connected fleet restore and the
// independent terminal catalog.
//
// Every identifier, name, host and session below is fictional demo data. Nothing
// is read from a live daemon, instance database, native history, credential or
// settings file. Shapes are typed against the exported contracts (and the guards
// accept them; see test/recovery-fixtures.test.ts), so a contract change breaks
// the build instead of drifting. Used by packages/ui/test/startup-chooser,
// fleet-restore-panel and terminal-catalog tests, and available to the twin
// fetch stub through its owner.

import type { HostsResponse } from "../src/hooks/useHosts.js";
import type { RigSummary } from "../src/hooks/useRigSummary.js";
import type { FleetRestoreRow, FleetRestoreStatus, StartupPrerequisites, StartupRig, StartupSeat } from "../src/lib/startup-contracts.js";
import type { TerminalPreviewDto, TerminalPreviewPane, TerminalViewsResponse } from "../src/lib/terminal-read.js";

export const recoveryHostsLocal: HostsResponse = { ownName: "demo-instance", selected: "local", hosts: [] };
export const recoveryHostsRemote: HostsResponse = {
  ownName: "demo-instance", selected: "edge-demo",
  hosts: [{ id: "edge-demo", transport: "ssh", target: "demo@edge.example.invalid", selected: true, status: "reachable" }],
};

export const recoveryRigSummaries: RigSummary[] = [
  { id: "rig_demo_alpha", name: "alpha", nodeCount: 4, latestSnapshotAt: null, latestSnapshotId: null, lifecycleState: "recoverable" },
  { id: "rig_demo_beta/with-slash", name: "beta", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null, lifecycleState: "stopped" },
];

export const startupPrerequisitesFixture: StartupPrerequisites = { codex: "ok", claudeCode: "unavailable" };

const seat = (overrides: Partial<StartupSeat> & Pick<StartupSeat, "logicalId" | "nodeId">): StartupSeat => ({
  runtime: "codex", model: null, revision: `rev-${overrides.nodeId}-1`, hasHistory: false, intendedAction: "fresh-primed", freshRequired: false,
  tokenState: "missing", observed: { state: "stopped", detail: "", sessionName: `${overrides.logicalId}@alpha` },
  contextPending: false, freshAllowed: true, ...overrides,
});

export const startupSeatOrchestrator = seat({
  logicalId: "orch.lead", nodeId: "node_orch_lead", hasHistory: true, intendedAction: "resume-original", tokenState: "present",
  model: "demo-model", reason: "resume token present",
});
/** Served with runtime:null — inventory facts only; it cannot form a startup selection. */
export const startupSeatUnconfigured = seat({ logicalId: "scratch.pad", nodeId: "node_scratch_pad", runtime: null, freshAllowed: undefined, contextPending: undefined });
/** A configured custom runtime string stays served; the daemon adapter owns availability. */
export const startupSeatCustomRuntime = seat({ logicalId: "custom.helper", nodeId: "node_custom_helper", runtime: "acme-agent" });
export const startupSeatAttention = seat({
  logicalId: "build.worker", nodeId: "node_build_worker", runtime: "claude-code", hasHistory: true, intendedAction: "awaiting-decision",
  tokenState: "unverified", contextPending: true,
  observed: { state: "attention_required", detail: "native trust prompt is waiting", sessionName: "build.worker@alpha" },
});

export const startupRigAlpha: StartupRig = {
  rigId: "rig_demo_alpha", rigName: "alpha",
  seats: [startupSeatOrchestrator, startupSeatUnconfigured, startupSeatCustomRuntime, startupSeatAttention],
};

/** The same rig after another writer changed the orchestrator seat's revision. */
export const startupRigAlphaRevised: StartupRig = {
  ...startupRigAlpha,
  seats: startupRigAlpha.seats.map(row => row.nodeId === startupSeatOrchestrator.nodeId ? { ...row, revision: "rev-node_orch_lead-2" } : row),
};

// ---------------------------------------------------------------- fleet

const counts = (sequence: FleetRestoreRow[]) => ({
  fully_restored: sequence.filter(r => r.outcome === "fully_restored").length,
  partially_restored: sequence.filter(r => r.outcome === "partially_restored").length,
  failed: sequence.filter(r => r.outcome === "failed").length,
  not_attempted: sequence.filter(r => r.outcome === "not_attempted").length,
});
function verdict(sequence: FleetRestoreRow[]): FleetRestoreStatus["verdict"] {
  const c = counts(sequence); const total = sequence.length;
  return !total || c.not_attempted === total ? "none_attempted" : c.fully_restored === total ? "all_fully_restored" : c.failed === total ? "all_failed" : "mixed";
}
export function fleetStatus(sequence: FleetRestoreRow[], flags: { done?: boolean; cancelled?: boolean } = {}): FleetRestoreStatus {
  return {
    done: flags.done ?? false, cancelled: flags.cancelled ?? false, verdict: verdict(sequence),
    rollup: { counts: counts(sequence), sequence, attention_required: sequence.flatMap(row => row.attention ?? []) },
  };
}
export const fleetRowKernel: FleetRestoreRow = { rigId: "rig_demo_kernel", outcome: "fully_restored", receiptRef: "receipt-demo-001" };
export const fleetRowAttention: FleetRestoreRow = {
  rigId: "rig_demo_alpha", outcome: "partially_restored", reason: "one seat is waiting on a native prompt",
  attention: [{ rigId: "rig_demo_alpha", seat: "build.worker", need: "trust prompt" }],
};
export const fleetRowNoSnapshot: FleetRestoreRow = {
  rigId: "rig_demo_beta/with-slash", outcome: "not_attempted", reason: "no restore-usable snapshot",
  remediation: "Capture a snapshot or start this rig deliberately.",
};
export const fleetRowFailed: FleetRestoreRow = { rigId: "rig_demo_gamma", outcome: "failed", reason: "launch refused" };

export const fleetRunningEmpty = fleetStatus([]);
export const fleetRunningPartial = fleetStatus([fleetRowKernel, fleetRowAttention]);
export const fleetCancelledRunning = fleetStatus([fleetRowKernel], { cancelled: true });
export const fleetDoneMixed = fleetStatus([fleetRowKernel, fleetRowAttention, fleetRowNoSnapshot], { done: true });
export const fleetDoneCancelled = fleetStatus([fleetRowKernel], { done: true, cancelled: true });
export const fleetDoneAllFailed = fleetStatus([fleetRowFailed], { done: true });
export const fleetDoneNoneAttempted = fleetStatus([fleetRowNoSnapshot], { done: true });

// ------------------------------------------------------------- terminals

/** "alpha" is both a saved view name and a rig name: the tokens stay distinct. */
export const terminalViewsFixture: TerminalViewsResponse = {
  saved: [
    { id: "sv-alpha-pair", name: "alpha", members: [{ seat: "orch.lead@alpha", label: "lead" }, { seat: "build.worker@alpha", readOnly: true }] },
    { id: "sv-wall", name: "wide wall", members: Array.from({ length: 17 }, (_, i) => ({ seat: `w${String(i + 1).padStart(2, "0")}.agent@alpha` })) },
    { id: "sv-mixed", name: "mixed hosts", members: [
      { seat: "orch.lead@alpha", readOnly: false },
      { seat: "remote.watch@edge", host: "edge-demo", tmuxSession: "remote.watch@edge", readOnly: true },
    ] },
  ],
  rigs: ["alpha", "beta"],
};
export const terminalViewsSavedOnly: TerminalViewsResponse = { saved: terminalViewsFixture.saved, rigs: [] };
export const terminalViewsEmpty: TerminalViewsResponse = { saved: [], rigs: [] };

function layout(count: number): { columns: number; rows: number; blanks: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count))); const rows = Math.max(1, Math.ceil(count / columns));
  return { columns, rows, blanks: columns * rows - count };
}
/** Pages follow the provider page size served by the daemon (16 for herdr here);
 * the UI never computes it. */
export function terminalPreviewFixture(view: string, provider: string, seats: readonly string[], options: {
  planId?: string; available?: boolean; perPage?: number; readOnly?: (seat: string) => boolean; ssh?: (seat: string) => boolean;
  absent?: TerminalPreviewDto["composed"]["absent"]; degraded?: TerminalPreviewDto["composed"]["degraded"];
} = {}): TerminalPreviewDto {
  const perPage = options.perPage ?? 16;
  const opened: TerminalPreviewPane[] = seats.map(seat => ({ seat, label: seat.split("@")[0]!, readOnly: options.readOnly?.(seat) ?? false,
    paneCommand: options.ssh?.(seat) ? `ssh demo@edge.example.invalid tmux attach -r -t ${seat}` : `tmux attach -t ${seat}` }));
  const pages: TerminalPreviewPane[][] = [];
  for (let i = 0; i < opened.length; i += perPage) pages.push(opened.slice(i, i + perPage));
  return {
    provider, view, planId: options.planId ?? `plan-${view}-${provider}-${seats.length}`, status: { available: options.available ?? true },
    composed: { id: view, opened, pages, absent: options.absent ?? [], degraded: options.degraded ?? [] },
    grids: pages.map(page => layout(page.length)),
  };
}
