import type { NodeInventoryEntry } from "../hooks/useNodeInventory.js";
import type { NeedsInputSeatEntry } from "../hooks/useNeedsInputSeats.js";
import type { PsEntry } from "../hooks/usePsEntries.js";
import { getActivityStateWithSource, identityVerdictDownranksRunning } from "./activity-visuals.js";
import { boundedJsonRead } from "./bounded-json-read.js";
import { isNodeInventoryEntry, isPsEntry } from "./fleet-inventory-reads.js";
import { OperatorReadError, hasShape, isText, isInteger, nullable, oneOf } from "./operator-read.js";

export interface NeedsInputTaxonomy {
  activity: "working" | "idle-at-prompt" | "unknown";
  display: "working" | "idle" | "needs-input" | "unknown";
  needsInput: { count: number; reason: string | null };
  decidedBy: string | null;
  seq: number;
  lastSwap: { generation: string; at: string } | null;
}
export interface NeedsInputNode extends NodeInventoryEntry { activityState?: NeedsInputTaxonomy | null }
export interface NeedsInputSourceError { rigId: string; rowIndex?: number; error: Error }
export interface NeedsInputRigSource {
  rig: PsEntry;
  state: "available" | "partial" | "unavailable" | "omitted";
  nodes: NeedsInputNode[];
}
export interface NeedsInputUnknownSeat {
  rigId: string;
  logicalId: string;
  node: NeedsInputNode;
}
export interface NeedsInputCoverage {
  complete: boolean;
  discoveredRigCount: number;
  inspectedRigCount: number;
  inspectedSeatCount: number;
  unknownSeatCount: number;
  rejectedRowCount: number;
}
export interface NeedsInputRead {
  seats: NeedsInputSeatEntry[];
  coverage: NeedsInputCoverage;
  sources: NeedsInputRigSource[];
  sourceErrors: NeedsInputSourceError[];
  unknownSeats: NeedsInputUnknownSeat[];
  omittedRigIds: string[];
  /** Resume after the last started source, so a slow prefix cannot starve
   * later rigs on subsequent polls. No fixed rig/seat truncation. */
  nextStartAfterRigId: string | null;
  readAt: number;
}
export const NEEDS_INPUT_CONCURRENCY = 4;
export const NEEDS_INPUT_DEADLINE_MS = 5_000;

function isTaxonomy(value: unknown): value is NeedsInputTaxonomy {
  if (!hasShape(value, { activity: oneOf("working", "idle-at-prompt", "unknown"),
    display: oneOf("working", "idle", "needs-input", "unknown"),
    needsInput: v => hasShape(v, { count: n => typeof n === "number" && isInteger(n) && n >= 0, reason: nullable(isText) }),
    decidedBy: nullable(isText), seq: n => typeof n === "number" && isInteger(n) && n >= 0,
    lastSwap: nullable(v => hasShape(v, { generation: isText, at: isText })) })) return false;
  // Validate the served bridge contract; never substitute a client-invented
  // display when a corrupt payload contradicts its authoritative count.
  const count = (value.needsInput as { count: number }).count;
  const expectedDisplay = count > 0 ? "needs-input"
    : value.activity === "idle-at-prompt" ? "idle" : value.activity;
  return value.display === expectedDisplay;
}
function isNode(value: unknown, rigId: string): value is NeedsInputNode {
  if (!isNodeInventoryEntry(value) || value.rigId !== rigId) return false;
  const taxonomy = "activityState" in value ? value.activityState : undefined;
  return taxonomy === undefined || taxonomy === null || isTaxonomy(taxonomy);
}
function sourceError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Needs-input source unavailable.");
}

/** Identity and independently observed prompts are positive obligations.
 * Served taxonomy can add a positive without erasing legacy full=true pane
 * evidence. Unknown activity never proves there are no prompts. */
function projectNode(node: NeedsInputNode): { seat?: NeedsInputSeatEntry; unknown: boolean } {
  const legacy = getActivityStateWithSource(node.agentActivity, node.terminalActive, node.identityVerdict);
  const identity = identityVerdictDownranksRunning(node.identityVerdict);
  const taxonomyPositive = node.activityState?.display === "needs-input" && node.activityState.needsInput.count > 0;
  if (identity || taxonomyPositive || legacy.state === "needs_input") {
    return { unknown: false, seat: {
      rigId: node.rigId, logicalId: node.logicalId, sessionName: node.canonicalSessionName,
      source: identity ? "identity_verdict" : taxonomyPositive ? "taxonomy" : legacy.source,
      eventAt: identity ? node.identityVerdict?.observedAt : taxonomyPositive ? undefined : node.agentActivity?.eventAt,
      sampledAt: identity ? node.identityVerdict?.observedAt : taxonomyPositive ? undefined : node.agentActivity?.sampledAt,
      // Preserve the original nullable/additive DTO, including taxonomy count,
      // reason, deciding rung and exact pane/session identity evidence.
      node,
    } };
  }
  const knownTaxonomy = node.activityState && node.activityState.display !== "unknown";
  const knownLegacy = node.agentActivity && node.agentActivity.state !== "unknown" && !node.agentActivity.stale;
  return { unknown: !knownTaxonomy && !knownLegacy };
}

/** Connected-local view only. The five-second budget covers inventory,
 * queued work, all headers and all bodies; each GET also uses the shared
 * bounded reader. A peer failure never discards already observed seats. */
export async function readNeedsInputSeats(options: { signal?: AbortSignal; startAfterRigId?: string | null } = {}): Promise<NeedsInputRead> {
  if (options.signal?.aborted) throw new OperatorReadError("cancelled", "Needs-input read cancelled.");
  const controller = new AbortController();
  let aborted: OperatorReadError | undefined;
  const cancel = (code: "cancelled" | "timeout") => {
    if (aborted) return;
    aborted = new OperatorReadError(code, code === "timeout" ? "Needs-input read timed out after 5 seconds." : "Needs-input read cancelled.");
    controller.abort();
  };
  const callerAbort = () => cancel("cancelled");
  options.signal?.addEventListener("abort", callerAbort, { once: true });
  const timer = setTimeout(() => cancel("timeout"), NEEDS_INPUT_DEADLINE_MS);
  try {
    let payload: unknown;
    try { payload = await boundedJsonRead<unknown>("/api/ps", { signal: controller.signal }); }
    catch (error) { throw aborted ?? error; }
    if (!Array.isArray(payload) || !payload.every(isPsEntry) || new Set(payload.map(r => r.rigId)).size !== payload.length) {
      throw new OperatorReadError("invalid_contract", "Needs-input inventory did not serve an exact rig list.");
    }
    const rigs: PsEntry[] = payload;
    const previous = rigs.findIndex(r => r.rigId === options.startAfterRigId);
    const start = previous < 0 ? 0 : (previous + 1) % Math.max(1, rigs.length);
    const sources: NeedsInputRigSource[] = rigs.map(rig => ({ rig, state: "omitted", nodes: [] }));
    const sourceErrors: NeedsInputSourceError[] = [];
    let cursor = 0;
    let nextStartAfterRigId: string | null = options.startAfterRigId ?? null;
    let rejectedRowCount = 0;
    async function worker() {
      while (cursor < rigs.length && !controller.signal.aborted) {
        const index = (start + cursor++) % rigs.length;
        const rig = rigs[index]!;
        nextStartAfterRigId = rig.rigId;
        try {
          // This legacy surface uniquely needs opt-in pane prompt evidence;
          // retain full=true without changing cheap topology/node reads.
          const rows = await boundedJsonRead<unknown>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes?full=true`, { signal: controller.signal });
          if (!Array.isArray(rows)) throw new OperatorReadError("invalid_contract", "Needs-input nodes did not serve an array.");
          const nodes: NeedsInputNode[] = [];
          const seen = new Set<string>();
          rows.forEach((row, rowIndex) => {
            if (!isNode(row, rig.rigId) || seen.has(row.logicalId)) {
              rejectedRowCount++;
              sourceErrors.push({ rigId: rig.rigId, rowIndex, error: new OperatorReadError("invalid_contract", "Needs-input node is malformed, duplicated or belongs to a different rig.") });
            } else { seen.add(row.logicalId); nodes.push(row); }
          });
          sources[index] = { rig, state: nodes.length === rows.length ? "available" : "partial", nodes };
        } catch (error) {
          if (aborted?.code === "cancelled") throw aborted;
          sources[index] = { rig, state: "unavailable", nodes: [] };
          sourceErrors.push({ rigId: rig.rigId, error: aborted ?? sourceError(error) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(NEEDS_INPUT_CONCURRENCY, rigs.length) }, () => worker()));
    if (aborted?.code === "cancelled") throw aborted;
    const seats: NeedsInputSeatEntry[] = [];
    const unknownSeats: NeedsInputUnknownSeat[] = [];
    for (const source of sources) for (const node of source.nodes) {
      const projection = projectNode(node);
      if (projection.seat) seats.push(projection.seat);
      if (projection.unknown) unknownSeats.push({ rigId: source.rig.rigId, logicalId: node.logicalId, node });
    }
    const omittedRigIds = sources.filter(s => s.state === "omitted").map(s => s.rig.rigId);
    return { seats, sources, sourceErrors, unknownSeats, omittedRigIds, nextStartAfterRigId, readAt: Date.now(),
      coverage: { complete: !aborted && sources.every(s => s.state === "available") && unknownSeats.length === 0,
        discoveredRigCount: rigs.length, inspectedRigCount: sources.filter(s => s.state === "available" || s.state === "partial").length,
        inspectedSeatCount: sources.reduce((count, s) => count + s.nodes.length, 0), unknownSeatCount: unknownSeats.length, rejectedRowCount } };
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", callerAbort); }
}
