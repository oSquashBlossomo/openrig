// Pure presentation joins over the exact project reads. Mirrors the TUI mission
// execution story (packages/tui/src/execution/execution-model.ts): declared
// status, native outcome judgments, the legacy delivery ladder, live work and
// lifecycle packets stay SEPARATE facts. Nothing here upgrades a receipt,
// checkbox, proof pairing or legacy PASS into accepted outcome.

import type {
  CanonicalMissionScope, CanonicalSliceScope, ExecutionCare, ExecutionDocument, ExecutionLadder, ExecutionLane,
  ExecutionPark, ExecutionRung, ExecutionSequence, ScopeReadiness,
} from "../../../lib/project-read.js";
import type { WorkflowLifecycleExecution, WorkflowLifecyclePacket } from "../../../lib/workflow-contracts.js";
import type { Tone } from "./evidence-ui.js";

export const INDETERMINATE = "INDETERMINATE";

// ------------------------------------------------------------ native outcomes

export interface OutcomeSummary {
  served: boolean; configured: boolean; state: string | null; total: number;
  accepted: number; pending: number; rejected: number; withdrawn: number; unknown: number;
  complete: boolean; label: string; tone: Tone;
}

/** Only a configured native policy whose every item is currently accepted is complete. */
export function outcomeSummary(readiness: ScopeReadiness | null | undefined): OutcomeSummary {
  const base = { accepted: 0, pending: 0, rejected: 0, withdrawn: 0, unknown: 0 };
  if (!readiness) return { ...base, served: false, configured: false, state: null, total: 0, complete: false, label: "native outcomes not served", tone: "muted" };
  for (const item of readiness.items) base[item.state] += 1;
  const total = readiness.items.length;
  const complete = readiness.configured && readiness.state === "ready" && total > 0 && base.accepted === total;
  const summary = { ...base, served: true, configured: readiness.configured, state: readiness.state, total, complete };
  if (!readiness.configured) return { ...summary, label: "no native outcome policy", tone: "muted" };
  if (complete) return { ...summary, label: `${total}/${total} outcomes accepted`, tone: "good" };
  if (base.withdrawn || base.rejected) return { ...summary, label: `reopened · ${base.accepted}/${total} accepted`, tone: "bad" };
  if (readiness.state === "unknown" || base.unknown) return { ...summary, label: `undetermined · ${base.accepted}/${total} accepted`, tone: "warn" };
  return { ...summary, label: `${base.accepted}/${total} outcomes accepted`, tone: "neutral" };
}

export function itemStateTone(state: ScopeReadiness["items"][number]["state"]): Tone {
  return state === "accepted" ? "good" : state === "rejected" || state === "withdrawn" ? "bad" : state === "unknown" ? "warn" : "neutral";
}

// --------------------------------------------------------------- legacy ladder

export const RUNGS = ["locked", "built", "reviewed", "folded", "adopted"] as const;
export type Rung = (typeof RUNGS)[number];
export const RUNG_WORD: Record<Rung, string> = { locked: "spec locked", built: "built", reviewed: "reviewed", folded: "merged", adopted: "live" };
export interface RungCell { rung: Rung; state: "yes" | "no" | "undetermined" | "not applicable"; basis: string; detail: string | null }

export function rungCell(ladder: ExecutionLadder, rung: Rung): RungCell {
  if (rung === "built") {
    const sha = ladder.built.candidate_sha;
    const known = sha !== INDETERMINATE && sha !== "";
    return { rung, state: known ? "yes" : "undetermined", basis: ladder.built.basis, detail: known ? sha : null };
  }
  const cell = ladder[rung] as ExecutionRung;
  const state = cell.value === "NOT_APPLICABLE" ? "not applicable" : cell.value === true ? "yes" : cell.value === false ? "no" : "undetermined";
  return { rung, state, basis: cell.basis, detail: null };
}

/** Legacy code evidence never paints success: it is not outcome acceptance. */
export function rungTone(cell: RungCell): Tone {
  return cell.state === "yes" ? "info" : cell.state === "no" ? "neutral" : cell.state === "undetermined" ? "warn" : "muted";
}

// ------------------------------------------------------------------ slices

export interface SliceRow {
  /** Exact slice directory (the addressable identity). */
  dir: string;
  /** Served slice id (may equal another slice's in a different mission/project). */
  id: string;
  name: string;
  order: number;
  scope: CanonicalSliceScope | null;
  readiness: ScopeReadiness | null;
  ladder: ExecutionLadder | null;
  sequencing: ExecutionSequence | null;
  care: ExecutionCare | null;
  lanes: ExecutionLane[];
  parks: ExecutionPark[];
  dependsOnReadiness: string[];
}

const sameSlice = (dir: string, id: string | null) => (candidate: { slice_id?: string; dir?: string }) =>
  candidate.dir === dir || (id !== null && candidate.slice_id === id);

/** Every slice any projection names appears exactly once (by directory), in plan order. */
export function sliceRows(doc: ExecutionDocument | null, mission: CanonicalMissionScope | null): SliceRow[] {
  const dirs: string[] = [];
  const add = (dir: string | undefined) => { if (dir && !dirs.includes(dir)) dirs.push(dir); };
  doc?.q2_sequencing.forEach((s) => add(s.dir));
  doc?.q4_ladder.forEach((l) => add(l.dir));
  doc?.readiness?.slices.forEach((s) => add(s.scope));
  mission?.slices.forEach((s) => add(s.dirName));
  return dirs.map((dir, index) => {
    const scope = mission?.slices.find((s) => s.dirName === dir) ?? null;
    const nativeSlice = doc?.readiness?.slices.find((s) => s.scope === dir) ?? null;
    const ladder = doc?.q4_ladder.find((l) => l.dir === dir) ?? null;
    const sequencing = doc?.q2_sequencing.find((s) => s.dir === dir) ?? null;
    const id = ladder?.slice_id ?? sequencing?.slice_id ?? nativeSlice?.id ?? scope?.id ?? dir;
    const care = doc?.q3_care.find((c) => c.slice_id === id) ?? null;
    const lanes = doc?.q1_lanes.filter((l) => l.slice === id || l.slice === dir) ?? [];
    const parks = doc?.q5_park.filter((p) => lanes.some((l) => l.qitem_id === p.qitem_id) || sequencing?.work_rows.some((w) => w.qitem_id === p.qitem_id)) ?? [];
    const seqIndex = doc?.q2_sequencing.findIndex(sameSlice(dir, null)) ?? -1;
    return {
      dir, id, order: seqIndex >= 0 ? seqIndex : 10_000 + index,
      name: (scope?.displayName ?? dir).replace(/^slice\s+\d+\s*[—–-]\s*/i, "").trim() || dir,
      scope, readiness: nativeSlice?.readiness ?? scope?.readiness ?? null, ladder, sequencing, care, lanes, parks,
      dependsOnReadiness: nativeSlice?.dependsOn ?? [],
    };
  }).sort((a, b) => a.order - b.order);
}

export function declaredStatus(row: SliceRow): string {
  return row.scope?.status?.trim().toLowerCase() || "no declared status";
}

/** A live problem on the slice from served lane/sequencing/park facts, or null. */
export function problemText(row: SliceRow): string | null {
  for (const lane of row.lanes) {
    if (lane.activity.activity !== INDETERMINATE && "needs_input" in lane.activity && lane.activity.needs_input.count > 0)
      return `needs input: ${lane.activity.needs_input.reason ?? `${lane.activity.needs_input.count} request(s)`}`;
  }
  const blocked = row.sequencing?.blocked_on_rows[0];
  if (blocked) return `waits on ${blocked.blocked_on}`;
  const park = row.parks.find((p) => p.pickup_state !== "working");
  if (park) return `${park.pickup_state}${park.age_minutes !== null ? ` ${park.age_minutes} min` : ""}`;
  return null;
}

export function sliceState(row: SliceRow): string {
  const problem = problemText(row);
  if (problem) return problem.startsWith("needs input") ? "needs input" : problem.startsWith("waits on") ? "blocked" : "waiting";
  if (row.lanes.some((l) => l.activity.activity === "working")) return "working";
  const work = row.sequencing?.work_rows ?? [];
  if (work.length) return work.some((w) => w.state === "blocked") ? "waiting" : "assigned";
  const outcome = outcomeSummary(row.readiness);
  if (outcome.complete) return "outcomes accepted";
  if (outcome.withdrawn || outcome.rejected) return "reopened";
  if (outcome.configured) return "outcomes pending";
  const declared = declaredStatus(row);
  if (declared === "retired" || row.scope?.stage?.toLowerCase() === "retired") return "retired";
  if (declared === "deferred" || declared === "closed-deferred") return "deferred";
  return declared === "done" ? "declared done" : "planned";
}

export function sliceStateTone(state: string): Tone {
  if (state === "working" || state === "assigned") return "info";
  if (state === "needs input" || state === "blocked" || state === "waiting") return "warn";
  if (state === "reopened") return "bad";
  if (state === "outcomes accepted") return "good";
  return "muted";
}

export function owners(row: SliceRow): string[] {
  return [...new Set((row.sequencing?.work_rows ?? []).map((w) => w.seat).concat(row.lanes.map((l) => l.seat)).filter(Boolean))];
}

export function plannedOwners(row: SliceRow): string[] {
  return [...new Set((row.sequencing?.planned_owners ?? []).map((p) => p.owner))];
}

/** Only when the projection itself says so. */
export function nextText(row: SliceRow): string | null {
  const seq = row.sequencing;
  if (!seq || outcomeSummary(row.readiness).complete || seq.work_rows.length) return null;
  if (seq.next_up === true) return "ready to start";
  if (seq.blocked_on_rows.length) return null;
  if (Array.isArray(seq.depends_on) && seq.depends_on.length) return `after ${seq.depends_on.join(", ")}`;
  return null;
}

export function waveOf(row: SliceRow): string {
  const wave = row.care?.build_wave;
  return wave && wave !== INDETERMINATE ? wave : "No wave declared";
}

export function waveGroups(rows: readonly SliceRow[]): Array<{ wave: string; rows: SliceRow[] }> {
  const groups = new Map<string, SliceRow[]>();
  for (const row of rows) groups.set(waveOf(row), [...(groups.get(waveOf(row)) ?? []), row]);
  return [...groups.entries()].map(([wave, members]) => ({ wave, rows: members }));
}

// ------------------------------------------------------------- mission story

export interface MissionStory {
  rows: SliceRow[];
  now: SliceRow[];
  next: SliceRow | null;
  nextLabel: string;
  accepted: number;
  withoutNativePolicy: number;
  needsInput: SliceRow[];
  gatedPackets: Array<{ instance: WorkflowLifecycleExecution; packet: WorkflowLifecyclePacket }>;
  lifecycleStatus: string;
}

export function missionStory(doc: ExecutionDocument | null, mission: CanonicalMissionScope | null): MissionStory {
  const rows = sliceRows(doc, mission);
  const now = rows.filter((r) => (r.sequencing?.work_rows.length ?? 0) > 0 || r.lanes.length > 0 || problemText(r) !== null);
  const accepted = rows.filter((r) => outcomeSummary(r.readiness).complete).length;
  const allAccepted = rows.length > 0 && accepted === rows.length;
  const next = rows.find((r) => nextText(r) === "ready to start") ?? null;
  const nextLabel = next ? `${next.id} · ready to start (${next.sequencing?.next_up_basis ?? "basis not served"})`
    : allAccepted ? "Every slice outcome is accepted; release and publication are separate decisions."
    : now.length ? "Current work is open; the projection names no further ready slice."
    : "The projection names no ready slice; eligibility is not determined.";
  const gatedPackets = (doc?.lifecycle_instances ?? []).flatMap((instance) => instance.frontier_packets
    .filter((packet) => packet.gate !== null && packet.queue_state !== "done")
    .map((packet) => ({ instance, packet })));
  return {
    rows, now, next, nextLabel, accepted,
    withoutNativePolicy: rows.filter((r) => !r.readiness?.configured).length,
    needsInput: rows.filter((r) => problemText(r)?.startsWith("needs input")),
    gatedPackets,
    lifecycleStatus: doc?.readiness?.historicalStatus ?? "not recorded",
  };
}

/** Group shared basis gaps: the FIRST undetermined rung per slice plus indeterminate activity. */
export function evidenceGaps(doc: ExecutionDocument, rows: readonly SliceRow[]): Array<{ where: string; basis: string; members: string[] }> {
  const groups = new Map<string, { where: string; basis: string; members: string[] }>();
  const add = (where: string, member: string, basis: string) => {
    const key = `${where}|${basis}`;
    const group = groups.get(key) ?? { where, basis, members: [] };
    if (!group.members.includes(member)) group.members.push(member);
    groups.set(key, group);
  };
  for (const row of rows) {
    if (!row.ladder) continue;
    const first = RUNGS.map((r) => rungCell(row.ladder!, r)).find((c) => c.state === "undetermined");
    if (first) add(RUNG_WORD[first.rung], row.id, first.basis);
  }
  for (const lane of doc.q1_lanes) if (lane.activity.activity === INDETERMINATE && "basis" in lane.activity) add("activity", lane.slice, lane.activity.basis);
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length);
}

export function packetTone(packet: WorkflowLifecyclePacket): Tone {
  if (packet.queue_state === "blocked") return "warn";
  if (packet.wake?.unconsumed) return "warn";
  if (packet.queue_state === "in-progress") return "info";
  return "neutral";
}

export function lifecycleTone(status: string): Tone {
  return status === "failed" ? "bad" : status === "waiting" ? "warn" : status === "active" ? "info" : "muted";
}
