import { useQuery } from "@tanstack/react-query";
import { isProjectCatalog, type ProjectCatalog } from "../lib/project-read.js";
import { operatorRead, operatorScopeKey, operatorScopeState, OperatorReadError, OPERATOR_QUERY_OPTIONS, type OperatorHookOptions, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
export function readProjectCatalog(scope: OperatorInstanceScope, options: OperatorReadOptions = {}) { return operatorRead(scope, "/api/scopes/projects", isProjectCatalog, options); }
export function useProjectCatalog(scope: OperatorInstanceScope, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<ProjectCatalog, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...operatorScopeKey(scope), "projects", "catalog"], queryFn: ({ signal }) => readProjectCatalog(scope, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  return { ...query, ...scopeState };
}
