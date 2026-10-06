import { useQuery } from "@tanstack/react-query";
import { isExecutionView, projectKey, projectParams, requireProjectDirectory, type ExecutionView, type ProjectSelection } from "../lib/project-read.js";
import { operatorRead, operatorScopeState, OperatorReadError, OPERATOR_QUERY_OPTIONS, type OperatorHookOptions, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
export async function readExecutionView(scope: OperatorInstanceScope, selection: ProjectSelection, mission: string | null = null, options: OperatorReadOptions = {}) {
  const params = projectParams(selection); if (mission !== null) { requireProjectDirectory(mission, "Mission"); params.set("mission", mission); }
  return operatorRead(scope, `/api/views/execution?${params}`, (v): v is ExecutionView => isExecutionView(v) && v.rows[0].project === selection.id && (mission === null || v.rows[0].mission === mission), options);
}
export function useExecutionView(scope: OperatorInstanceScope, selection: ProjectSelection | null, mission: string | null = null, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<ExecutionView, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...projectKey(scope, selection), "execution", mission], queryFn: ({ signal }) => readExecutionView(scope, selection!, mission, { signal }), enabled: scopeState.scopeSupported && selection !== null && options.enabled !== false });
  return { ...query, ...scopeState };
}
