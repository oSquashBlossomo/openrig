import { useQuery } from "@tanstack/react-query";
import type { HealthRecord } from "@openrig/daemon/health-projection";
import type { HealthListProjection, HealthListQuery } from "@openrig/daemon/health-detectors";
import { arrayOf, hasShape, isBoolean, isInteger, isNumber, isObject, isText, nullable, oneOf, optional, operatorRead, operatorScopeKey, operatorScopeState, OperatorReadError, OPERATOR_QUERY_OPTIONS, type Check, type OperatorHookOptions, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
export type { HealthRecord, HealthListProjection, HealthListQuery };

const textOrNull = nullable(isText);
const scopes: Record<string, Record<string, Check>> = {
  instance: { instanceId: isText }, rig: { rigId: isText }, seat: { rigId: isText, seatId: isText },
  mission: { projectId: isText, missionId: isText }, slice: { projectId: isText, missionId: isText, sliceId: isText },
};
const evidenceShapes: Record<string, Record<string, Check>> = {
  "queue-transition": { qitemId: isText, transitionId: isInteger, state: isText, actorSession: isText, identityProvenance: textOrNull },
  "watchdog-history": { jobId: isText, historyId: isText, outcome: isText, deliveryStatus: textOrNull },
  "work-graph": { nodeType: oneOf("mission", "slice"), nodeId: isText, missionId: isText, stage: textOrNull, dependsOn: arrayOf(isText) },
  "topology-activity": { nodeId: isText, sessionName: textOrNull, activity: textOrNull, activitySequence: nullable(isInteger) },
  "context-usage": { nodeId: isText, sessionId: textOrNull, usedPercentage: nullable(isNumber), available: isBoolean, fresh: isBoolean },
  "occupant-model": { nodeId: isText, occupantGeneration: textOrNull, runtime: textOrNull, model: textOrNull },
  "lifecycle-receipt": { receiptId: isText, operation: isText, outcome: isText },
};
const evidence: Check = v => isObject(v) && isText(v.type) && Object.hasOwn(evidenceShapes, v.type)
  && hasShape(v, { sourceOrder: isInteger, observedAt: textOrNull, ...evidenceShapes[v.type] });
const operatingContext: Check = v => hasShape(v, {
  rigId: optional(isText), projectId: optional(isText), missionId: optional(isText), workstreamId: optional(isText), qitemId: optional(isText),
  phase: x => hasShape(x, { value: textOrNull, source: textOrNull }), sources: arrayOf(isText),
  paths: optional(x => hasShape(x, { project: isText, mission: optional(isText), workstream: optional(isText) })),
});
const posture: Check = v => hasShape(v, {
  posture: oneOf("human-led", "delegated", "unknown"), source: oneOf("product-default", "binding", "unknown"),
  context: nullable(operatingContext), binding: nullable(x => hasShape(x, { id: isText, scope: oneOf("global_host", "rig", "project", "mission", "workstream", "qitem"), setAt: isText, evidence: isText })),
  reason: isText, grantsAuthority: oneOf(false), members: optional(arrayOf(x => hasShape(x, { qitemId: isText, posture: isText, source: isText, bindingId: textOrNull }))),
});
const assessment: Check = v => hasShape(v, { basis: isText, conclusion: oneOf("established", "false-positive", "indeterminate"), outcomes: arrayOf(x => hasShape(x, { id: isText, observedAt: isText, evidenceRefs: arrayOf(isText) })), boundedAuthority: nullable(isBoolean), boundary: isText, evidenceRefs: arrayOf(isText), missingFacts: arrayOf(isText) });
const ceremony: Check = v => hasShape(v, {
  origin: oneOf("passive"), stage: oneOf("needs-diagnosis", "confirmed", "cleared", "indeterminate"), lineageId: isText, basis: isText,
  transitionIds: arrayOf(isInteger), context: arrayOf(x => hasShape(x, { path: isText, state: oneOf("available", "unavailable"), sha256: optional(isText), role: isText })),
  workflowReceipts: arrayOf(x => hasShape(x, { trailId: isText, instanceId: isText, stepId: isText, qitemId: isText, closureReason: isText, actor: isText, at: isText, evidence: () => true })),
  assessment: optional(x => hasShape(x, { result: assessment, actor: isText, at: isText, transitionId: isInteger, identityProvenance: textOrNull })), missingFacts: arrayOf(isText),
});
export function isCanonicalHealthRecord(v: unknown): v is HealthRecord {
  return hasShape(v, {
    schema: oneOf("openrig.health/v0alpha1"), id: isText, detector: isText,
    category: oneOf("behavioral", "process", "governance", "epistemic", "context"),
    scope: x => isObject(x) && isText(x.type) && Object.hasOwn(scopes, x.type) && hasShape(x, scopes[x.type]!),
    severity: oneOf("info", "warning", "critical"), confidence: oneOf("high", "medium"), status: oneOf("active", "cleared", "indeterminate"),
    startedAt: textOrNull, lastObservedAt: textOrNull,
    window: x => hasShape(x, { source: oneOf(...Object.keys(evidenceShapes), "mixed"), startedAt: isText, endedAt: isText, limit: isInteger, retentionSeconds: isNumber }),
    freshness: x => hasShape(x, { state: oneOf("fresh", "stale", "unavailable", "contradictory"), evaluatedAt: isText, newestSourceAt: textOrNull, maxAgeSeconds: isNumber, ageSeconds: nullable(isNumber) }),
    summary: isText, evidence: arrayOf(evidence), threshold: isText, explanation: isText, suggestedInspection: isText, indeterminateReason: textOrNull,
    policyVersion: optional(isText), operatingPosture: optional(posture), ceremony: optional(ceremony),
  });
}
function isHealthList(v: unknown): v is HealthListProjection {
  return hasShape(v, {
    schema: oneOf("openrig.health-list/v0alpha1"), evaluatedAt: textOrNull, total: isInteger, limit: isInteger, truncated: isBoolean, records: arrayOf(isCanonicalHealthRecord),
    coverage: optional(arrayOf(x => hasShape(x, { source: isText, evaluatedAt: isText }) && (x.status === "unavailable"
      ? hasShape(x, { partial: oneOf(true), reason: isText })
      : hasShape(x, { status: optional(oneOf("available")), unit: isText, limit: isInteger, total: isInteger, evaluated: isInteger, omitted: isInteger, partial: isBoolean, order: isText })))),
  });
}
function healthParams(filters: HealthListQuery): URLSearchParams {
  const limit = filters.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (filters.scopeType !== undefined) !== (filters.scopeId !== undefined)
    || (filters.scopeType !== undefined && !Object.hasOwn(scopes, filters.scopeType))
    || (filters.scopeId !== undefined && (!isText(filters.scopeId) || !filters.scopeId.trim()))
    || (filters.severity !== undefined && !oneOf("info", "warning", "critical")(filters.severity))
    || (filters.status !== undefined && !oneOf("active", "cleared", "indeterminate")(filters.status))) {
    throw new OperatorReadError("invalid_request", "Health filters require a bounded limit and paired canonical scope type/id.");
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.scopeType !== undefined) { params.set("scope_type", filters.scopeType); params.set("scope_id", filters.scopeId!); }
  if (filters.severity !== undefined) params.set("severity", filters.severity);
  if (filters.status !== undefined) params.set("status", filters.status);
  return params;
}
export async function readCanonicalHealth(scope: OperatorInstanceScope, filters: HealthListQuery = {}, options: OperatorReadOptions = {}) {
  return operatorRead(scope, `/api/health?${healthParams(filters)}`, isHealthList, options);
}
export async function readCanonicalHealthDetail(scope: OperatorInstanceScope, findingId: string, options: OperatorReadOptions = {}) {
  if (!isText(findingId) || !findingId.trim()) throw new OperatorReadError("invalid_request", "Health detail requires an exact finding ID.");
  return operatorRead(scope, `/api/health/${encodeURIComponent(findingId)}`, (v): v is HealthRecord => isCanonicalHealthRecord(v) && v.id === findingId, options);
}
export function useCanonicalHealth(scope: OperatorInstanceScope, filters: HealthListQuery = {}, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<HealthListProjection, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS,
    queryKey: [...operatorScopeKey(scope), "health", "list", filters.limit ?? 200, filters.scopeType ?? null, filters.scopeId ?? null, filters.severity ?? null, filters.status ?? null],
    queryFn: ({ signal }) => readCanonicalHealth(scope, filters, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false,
  });
  return { ...query, ...scopeState };
}
export function useCanonicalHealthDetail(scope: OperatorInstanceScope, findingId: string | null, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<HealthRecord, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS,
    queryKey: [...operatorScopeKey(scope), "health", "detail", findingId], queryFn: ({ signal }) => readCanonicalHealthDetail(scope, findingId ?? "", { signal }),
    enabled: scopeState.scopeSupported && findingId !== null && options.enabled !== false,
  });
  return { ...query, ...scopeState };
}
