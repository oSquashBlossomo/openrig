import { useQuery } from "@tanstack/react-query";
import { isCanonicalScopes, isProjectSliceDetail, projectSliceDocumentUrl, projectKey, projectParams, requireProjectDirectory, type CanonicalScopes, type ProjectSelection, type ProjectSliceDetail, type ProjectSliceDocument } from "../lib/project-read.js";
import { hasShape, isText, operatorRead, operatorScopeState, OperatorReadError, OPERATOR_QUERY_OPTIONS, type OperatorHookOptions, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
export async function readCanonicalScopes(scope: OperatorInstanceScope, selection: ProjectSelection, options: OperatorReadOptions = {}) {
  const params = new URLSearchParams({ detail: "1" }); projectParams(selection).forEach((value, key) => params.set(key, value));
  return operatorRead(scope, `/api/scopes?${params}`, (v): v is CanonicalScopes => isCanonicalScopes(v) && v.project.id === selection.id && v.project.root === selection.root, options);
}
export function useCanonicalScopes(scope: OperatorInstanceScope, selection: ProjectSelection | null, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<CanonicalScopes, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...projectKey(scope, selection), "scopes", "detail"], queryFn: ({ signal }) => readCanonicalScopes(scope, selection!, { signal }), enabled: scopeState.scopeSupported && selection !== null && options.enabled !== false });
  return { ...query, ...scopeState };
}
export async function readProjectSliceDetail(scope: OperatorInstanceScope, selection: ProjectSelection, mission: string, directory: string, options: OperatorReadOptions = {}) {
  const params = projectParams(selection); requireProjectDirectory(mission, "Mission"); requireProjectDirectory(directory, "Slice"); params.set("mission", mission);
  return operatorRead(scope, `/api/slices/${encodeURIComponent(directory)}?${params}`, (v): v is ProjectSliceDetail => isProjectSliceDetail(v) && v.name === directory && v.missionId === mission
    && (v.slicePath.startsWith(selection.root.replace(/[\\/]$/, "") + "/") || v.slicePath.startsWith(selection.root.replace(/[\\/]$/, "") + "\\")), options);
}
export function useProjectSliceDetail(scope: OperatorInstanceScope, selection: ProjectSelection | null, mission: string | null, directory: string | null, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<ProjectSliceDetail, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...projectKey(scope, selection), "slice-detail", mission, directory], queryFn: ({ signal }) => readProjectSliceDetail(scope, selection!, mission!, directory!, { signal }), enabled: scopeState.scopeSupported && selection !== null && mission !== null && directory !== null && options.enabled !== false });
  return { ...query, ...scopeState };
}

export async function readProjectSliceDocument(scope: OperatorInstanceScope, selection: ProjectSelection, mission: string, directory: string, relPath: string, options: OperatorReadOptions = {}) {
  const route = projectSliceDocumentUrl(scope, selection, mission, directory, relPath);
  return operatorRead(scope, route, (v): v is ProjectSliceDocument => hasShape(v, { relPath: isText, content: isText }) && v.relPath === relPath, options);
}
export function useProjectSliceDocument(scope: OperatorInstanceScope, selection: ProjectSelection | null, mission: string | null, directory: string | null, relPath: string | null, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<ProjectSliceDocument, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...projectKey(scope, selection), "slice-document", mission, directory, relPath], queryFn: ({ signal }) => readProjectSliceDocument(scope, selection!, mission!, directory!, relPath!, { signal }), enabled: scopeState.scopeSupported && selection !== null && mission !== null && directory !== null && relPath !== null && options.enabled !== false });
  return { ...query, ...scopeState };
}
