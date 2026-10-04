import { useQuery } from "@tanstack/react-query";
import { arrayOf, hasShape, isBoolean, isText, nullable, operatorRead, operatorScopeKey, operatorScopeState, OperatorReadError,
  LOCAL_OPERATOR_INSTANCE, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
import { isWorkflowInstance, isWorkflowOperation, isWorkflowReconciliation, isWorkflowTrace,
  type WorkflowInstanceStatus, type WorkflowInstanceWithDeadline, type WorkflowOperation, type WorkflowReconciliation, type WorkflowSpecSummary, type WorkflowTrace } from "../lib/workflow-contracts.js";
export * from "../lib/workflow-contracts.js";

const QUERY_OPTIONS = { retry: false, staleTime: 15_000, placeholderData: undefined } as const;
export const workflowQueryKey = (scope: OperatorInstanceScope, family: string, ...ids: unknown[]) => ["workflow", ...operatorScopeKey(scope), family, ...ids] as const;
function exactId(id: string) {
  if (!isText(id) || !id.trim()) throw new OperatorReadError("invalid_request", "Workflow reads require an exact non-empty ID.");
  return encodeURIComponent(id);
}
export function readWorkflowInstances(scope: OperatorInstanceScope, status?: WorkflowInstanceStatus, options: OperatorReadOptions = {}) {
  if (status !== undefined && !["active", "waiting", "completed", "failed", "aborted"].includes(status)) throw new OperatorReadError("invalid_request", "Unknown workflow status filter.");
  return operatorRead(scope, `/api/workflow/list${status ? `?status=${status}` : ""}`,
    (v): v is WorkflowInstanceWithDeadline[] => arrayOf(x => isWorkflowInstance(x))(v), options);
}
export function readWorkflowInstance(scope: OperatorInstanceScope, instanceId: string, options: OperatorReadOptions = {}) {
  return operatorRead(scope, `/api/workflow/${exactId(instanceId)}`,
    (v): v is WorkflowInstanceWithDeadline => isWorkflowInstance(v) && v.instanceId === instanceId, options);
}
export function readWorkflowTrace(scope: OperatorInstanceScope, instanceId: string, options: OperatorReadOptions = {}) {
  return operatorRead(scope, `/api/workflow/${exactId(instanceId)}/trace`,
    (v): v is WorkflowTrace => isWorkflowTrace(v) && v.instance.instanceId === instanceId, options);
}
export function readWorkflowSpecs(scope: OperatorInstanceScope, options: OperatorReadOptions = {}) {
  return operatorRead(scope, "/api/workflow/specs", (v): v is { specs: WorkflowSpecSummary[] } => hasShape(v, {
    specs: arrayOf(x => hasShape(x, { name: isText, version: isText, purpose: nullable(isText), targetRig: nullable(isText),
      coordinationTerminalTurnRule: isText, sourcePath: isText, cachedAt: isText, isBuiltIn: isBoolean })),
  }), options);
}
export function readWorkflowRevision(scope: OperatorInstanceScope, instanceId: string, options: OperatorReadOptions = {}) {
  return operatorRead(scope, `/api/workflow/${exactId(instanceId)}/revision`, isWorkflowReconciliation, options);
}
export function readWorkflowOperation(scope: OperatorInstanceScope, operationKey: string, options: OperatorReadOptions = {}) {
  return operatorRead(scope, `/api/workflow/operations/${exactId(operationKey)}`,
    (v): v is WorkflowOperation => isWorkflowOperation(v) && v.receipt.operationKey === operationKey, options);
}

/** Existing signatures remain valid. Explicit remote scope is unavailable; no
 * host forwarding exists for these connected-instance workflow endpoints. */
export function useWorkflowInstances(status?: WorkflowInstanceStatus, scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery({ ...QUERY_OPTIONS, queryKey: workflowQueryKey(scope, "instances", status ?? "all"),
    queryFn: ({ signal }) => readWorkflowInstances(scope, status, { signal }), enabled: scopeState.scopeSupported });
  return { ...query, ...scopeState };
}
export function useWorkflowInstance(instanceId: string | null, scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery({ ...QUERY_OPTIONS, queryKey: workflowQueryKey(scope, "instance", instanceId),
    queryFn: ({ signal }) => readWorkflowInstance(scope, instanceId ?? "", { signal }), enabled: scopeState.scopeSupported && !!instanceId });
  return { ...query, ...scopeState };
}
export function useWorkflowSpecs(scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery({ ...QUERY_OPTIONS, queryKey: workflowQueryKey(scope, "specs"),
    queryFn: ({ signal }) => readWorkflowSpecs(scope, { signal }), enabled: scopeState.scopeSupported });
  return { ...query, ...scopeState };
}
export function useWorkflowTrace(instanceId: string | null, scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery({ ...QUERY_OPTIONS, queryKey: workflowQueryKey(scope, "trace", instanceId),
    queryFn: ({ signal }) => readWorkflowTrace(scope, instanceId ?? "", { signal }), enabled: scopeState.scopeSupported && !!instanceId });
  return { ...query, ...scopeState };
}
export function useWorkflowRevision(instanceId: string | null, scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<WorkflowReconciliation, OperatorReadError>({ ...QUERY_OPTIONS, queryKey: workflowQueryKey(scope, "revision", instanceId),
    queryFn: ({ signal }) => readWorkflowRevision(scope, instanceId ?? "", { signal }), enabled: scopeState.scopeSupported && !!instanceId });
  return { ...query, ...scopeState };
}
export function useWorkflowOperation(operationKey: string | null, scope: OperatorInstanceScope = LOCAL_OPERATOR_INSTANCE) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<WorkflowOperation, OperatorReadError>({ ...QUERY_OPTIONS, queryKey: workflowQueryKey(scope, "operation", operationKey),
    queryFn: ({ signal }) => readWorkflowOperation(scope, operationKey ?? "", { signal }), enabled: scopeState.scopeSupported && !!operationKey });
  return { ...query, ...scopeState };
}
