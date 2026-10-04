import type { NodeInventoryEntry } from "../hooks/useNodeInventory.js";
import type { PsEntry } from "../hooks/usePsEntries.js";
import { withHostParam } from "./host-param.js";
import { arrayOf, hasShape, isBoolean, isInteger, isNumber, isText, nullable, optional, oneOf,
  LOCAL_OPERATOR_INSTANCE, operatorRead, OperatorReadError, type OperatorReadOptions } from "./operator-read.js";

const identity = (v: unknown): v is string => isText(v) && !!v.trim();
const textOrNull = nullable(isText);
const lifecycle = oneOf("running", "recoverable", "stopped", "degraded", "attention_required");
const contextUsage = (v: unknown) => hasShape(v, { usedPercentage: nullable(isNumber), remainingPercentage: nullable(isNumber),
  contextWindowSize: nullable(isNumber), availability: textOrNull, sampledAt: textOrNull, fresh: isBoolean,
  totalInputTokens: optional(nullable(isNumber)), totalOutputTokens: optional(nullable(isNumber)) });
const activity = (v: unknown) => hasShape(v, { state: oneOf("running", "needs_input", "idle", "unknown"),
  reason: isText, evidenceSource: isText, sampledAt: isText, eventAt: optional(textOrNull), evidence: optional(textOrNull),
  staleness: optional(nullable(isNumber)), stale: optional(isBoolean), fallback: optional(isBoolean) });
const verdict = (v: unknown) => hasShape(v, { verdict: oneOf("verified", "mismatch", "pane_missing", "tmux_unavailable"),
  evidenceSource: optional(textOrNull), reason: optional(textOrNull), sessionName: optional(textOrNull), observedAt: optional(isText),
  evidence: optional(nullable(e => hasShape(e, { registeredPane: optional(textOrNull), observedPid: optional(nullable(isNumber)),
    observedCommand: optional(textOrNull), matchedLayer: optional(nullable(isNumber)) }))) });

/** Validate consumed facts while preserving the original, additive daemon DTO.
 * Missing native runtime/session bindings are legitimate unconfigured seats. */
export function isNodeInventoryEntry(v: unknown): v is NodeInventoryEntry {
  return hasShape(v, { rigId: identity, rigName: isText, logicalId: identity, podId: textOrNull,
    podNamespace: optional(textOrNull), canonicalSessionName: textOrNull, nodeKind: oneOf("agent", "infrastructure"),
    runtime: textOrNull, sessionStatus: textOrNull, startupStatus: nullable(oneOf("pending", "ready", "attention_required", "failed")),
    restoreOutcome: isText, tmuxAttachCommand: textOrNull, resumeCommand: textOrNull, latestError: textOrNull,
    contextUsage: optional(nullable(contextUsage)), agentActivity: optional(nullable(activity)),
    currentQitems: optional(arrayOf(q => hasShape(q, { qitemId: identity, bodyExcerpt: isText, tier: textOrNull }))),
    terminalActive: optional(nullable(isBoolean)), hasAssignedWork: optional(isBoolean), pendingWorkCount: optional(isInteger),
    identityVerdict: optional(nullable(verdict)), agentRef: optional(textOrNull), profile: optional(textOrNull), codexConfigProfile: optional(textOrNull) });
}
export function isPsEntry(v: unknown): v is PsEntry {
  return hasShape(v, { rigId: identity, name: isText, nodeCount: isInteger, runningCount: isInteger,
    activeCount: optional(isInteger), hasWorkCount: optional(isInteger), status: oneOf("running", "partial", "stopped"),
    lifecycleState: optional(lifecycle), uptime: textOrNull, latestSnapshot: textOrNull });
}
function requireIdentity(...ids: (string | null | undefined)[]) {
  if (!ids.every(identity)) throw new OperatorReadError("invalid_request", "Choose an exact host and rig before reading inventory.");
}
/** The connected daemon transports these supported origin reads through its
 * existing host envelope; it never falls back to local data on origin failure. */
export async function readPsEntries(hostId: string, options: OperatorReadOptions = {}) {
  requireIdentity(hostId);
  return operatorRead(LOCAL_OPERATOR_INSTANCE, withHostParam("/api/ps", hostId),
    (v): v is PsEntry[] => Array.isArray(v) && v.every(isPsEntry), options);
}
export async function readNodeInventory(rigId: string | null, hostId: string, options: OperatorReadOptions = {}) {
  requireIdentity(rigId, hostId);
  return operatorRead(LOCAL_OPERATOR_INSTANCE, withHostParam(`/api/rigs/${encodeURIComponent(rigId!)}/nodes`, hostId),
    (v): v is NodeInventoryEntry[] => Array.isArray(v) && v.every(row => isNodeInventoryEntry(row) && row.rigId === rigId), options);
}
