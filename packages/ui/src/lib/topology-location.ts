import { hasUnpairedSurrogate, stringifyTopologySearch } from "./topology-search.js";

export const TOPOLOGY_IDENTITY_LIMIT = 2_048;
export const TOPOLOGY_QUERY_LIMIT = 256;
export const TOPOLOGY_URL_LIMIT = 16 * 1_024;
export type TopologyScope = { kind: "host" } | { kind: "rig"; rigId: string }
  | { kind: "pod"; rigId: string; podName: string } | { kind: "seat"; rigId: string; logicalId: string };
export type TopologyView = "graph" | "spatial" | "table" | "terminal" | "overview" | "details";
export interface TopologySelection { rigId: string; nodeId: string }
export interface TopologyLocation {
  scope: TopologyScope;
  sourceHost?: string;
  view: TopologyView;
  spatialMode: "scene" | "list";
  spatialQuery: string;
  selection?: TopologySelection;
}
export interface TopologyIssue {
  field: "scope" | "sourceHost" | "view" | "spatialMode" | "spatialQuery" | "selection" | "location";
  code: "invalid" | "duplicate" | "too_large" | "wrong_scope" | "unrepresentable_path";
  blocking: boolean;
}
export interface ParsedTopologyLocation {
  location: TopologyLocation;
  issues: TopologyIssue[];
  /** Legacy source still needs a successful host read/bind; this is not admission. */
  sourceState: "legacy" | "asserted" | "invalid";
  targetValid: boolean;
}
const defaultView = (scope: TopologyScope): TopologyView => scope?.kind === "seat" ? "overview" : "graph";
function identityIssue(value: unknown): TopologyIssue["code"] | null {
  if (Array.isArray(value)) return "duplicate";
  if (typeof value !== "string" || !value.length || hasUnpairedSurrogate(value)) return "invalid";
  return value.length > TOPOLOGY_IDENTITY_LIMIT ? "too_large" : null;
}
function pathIdentityIssue(value: unknown): TopologyIssue["code"] | null {
  const issue = identityIssue(value);
  if (issue) return issue;
  // These segments normalize in URLs/router.decodePath. Disclose an inability
  // to represent them instead of linking a different entity.
  return value === "." || value === ".." || /[\x00-\x1f\x7f]/.test(value as string) ? "unrepresentable_path" : null;
}
function scopeIssue(scope: TopologyScope): TopologyIssue["code"] | null {
  if (!scope || !["host", "rig", "pod", "seat"].includes(scope.kind)) return "invalid";
  if (scope.kind === "host") return null;
  return pathIdentityIssue(scope.rigId)
    ?? (scope.kind === "pod" ? pathIdentityIssue(scope.podName) : scope.kind === "seat" ? pathIdentityIssue(scope.logicalId) : null);
}
function allowedView(scope: TopologyScope, value: unknown): value is TopologyView {
  return typeof value === "string" && (scope.kind === "seat" ? ["overview", "details"]
    : scope.kind === "host" ? ["graph", "spatial", "table", "terminal"]
      : ["graph", "spatial", "table", "terminal", "overview"]).includes(value);
}
/** Pass router-decoded scope params verbatim and supply location.publicHref
 * as serializedPathAndQuery to validate the original whole URL budget/path.
 * Canonicalized location.href may erase oversized/malformed original input.
 * Only the serialized path is decoded here; scope identities are never decoded again. */
export function parseTopologyLocation(scope: TopologyScope, search: Record<string, unknown>,
  options: { serializedPathAndQuery?: string } = {}): ParsedTopologyLocation {
  const issues: TopologyIssue[] = [];
  const add = (field: TopologyIssue["field"], code: TopologyIssue["code"], blocking = false) => issues.push({ field, code, blocking });
  const invalidScope = scopeIssue(scope); if (invalidScope) add("scope", invalidScope, true);
  const location: TopologyLocation = { scope, view: defaultView(scope), spatialMode: "scene", spatialQuery: "" };
  if (invalidScope) return { location, issues, sourceState: "legacy", targetValid: false };
  let sourceState: ParsedTopologyLocation["sourceState"] = "legacy";
  if (search.sourceHost !== undefined) {
    const issue = identityIssue(search.sourceHost);
    if (issue) { sourceState = "invalid"; add("sourceHost", issue, true); }
    else { sourceState = "asserted"; location.sourceHost = search.sourceHost as string; }
  }
  if (search.view !== undefined) {
    if (allowedView(scope, search.view)) location.view = search.view;
    else add("view", Array.isArray(search.view) ? "duplicate" : "invalid");
  }
  if (scope.kind !== "seat") {
    if (search.spatialMode !== undefined) {
      if (search.spatialMode === "scene" || search.spatialMode === "list") location.spatialMode = search.spatialMode;
      else add("spatialMode", Array.isArray(search.spatialMode) ? "duplicate" : "invalid");
    }
    if (search.spatialQuery !== undefined) {
      if (Array.isArray(search.spatialQuery)) add("spatialQuery", "duplicate");
      else if (typeof search.spatialQuery !== "string" || hasUnpairedSurrogate(search.spatialQuery)) add("spatialQuery", "invalid");
      else if ([...search.spatialQuery].length > TOPOLOGY_QUERY_LIMIT) add("spatialQuery", "too_large");
      else location.spatialQuery = search.spatialQuery;
    }
    if (search.selectedRig !== undefined || search.selectedNode !== undefined) {
      const issue = identityIssue(search.selectedRig) ?? identityIssue(search.selectedNode);
      if (issue) add("selection", issue);
      else if (scope.kind !== "host" && search.selectedRig !== scope.rigId) add("selection", "wrong_scope");
      else location.selection = { rigId: search.selectedRig as string, nodeId: search.selectedNode as string };
    }
  }
  const serialized = options.serializedPathAndQuery;
  if (serialized !== undefined) {
    const pathAndQuery = serialized.split("#", 1)[0]!;
    if (new TextEncoder().encode(pathAndQuery).length > TOPOLOGY_URL_LIMIT) add("location", "too_large", true);
    try {
      const segments = pathAndQuery.split("?", 1)[0]!.split("/");
      if (segments.some(segment => {
        const decoded = decodeURIComponent(segment);
        return hasUnpairedSurrogate(decoded) || decoded === "." || decoded === ".." || /[\x00-\x1f\x7f]/.test(decoded);
      })) add("scope", "unrepresentable_path", true);
    } catch { add("scope", "invalid", true); }
  }
  return { location, issues, sourceState, targetValid: !issues.some(issue => issue.blocking) };
}
export interface TopologyLinkInput {
  scope: TopologyScope;
  sourceHost: string;
  view?: TopologyView;
  spatialMode?: "scene" | "list";
  spatialQuery?: string;
  selection?: TopologySelection;
}
export interface TopologyLinkTarget {
  /** RAW params: migrate manual preencode/decode producers AND consumers together. */
  to: "/topology" | "/topology/rig/$rigId" | "/topology/pod/$rigId/$podName" | "/topology/seat/$rigId/$logicalId";
  params: Record<string, string>;
  search: Record<string, string>;
  /** Already serialized, once-encoded href for plain anchors/copy. */
  href: string;
}
export type TopologyLinkResult = { ok: true; target: TopologyLinkTarget } | { ok: false; issues: TopologyIssue[] };
/** New links contain only semantic allowlisted fields; no origin metadata/hash
 * is copied. Same-entry replacements should preserve router hash/state separately. */
export function buildTopologyLink(input: TopologyLinkInput): TopologyLinkResult {
  const parsed = parseTopologyLocation(input.scope, { sourceHost: input.sourceHost, view: input.view,
    spatialMode: input.spatialMode, spatialQuery: input.spatialQuery,
    selectedRig: input.selection?.rigId, selectedNode: input.selection?.nodeId });
  if (parsed.issues.length || parsed.sourceState !== "asserted")
    return { ok: false, issues: parsed.issues.length ? parsed.issues : [{ field: "sourceHost", code: "invalid", blocking: true }] };
  const location = parsed.location;
  const search: Record<string, string> = { sourceHost: location.sourceHost! };
  if (location.view !== defaultView(input.scope)) search.view = location.view;
  if (input.scope.kind !== "seat") {
    if (location.spatialMode !== "scene") search.spatialMode = location.spatialMode;
    if (location.spatialQuery) search.spatialQuery = location.spatialQuery;
    if (location.selection) { search.selectedRig = location.selection.rigId; search.selectedNode = location.selection.nodeId; }
  }
  const scope = input.scope;
  const params: Record<string, string> = scope.kind === "host" ? {} : { rigId: scope.rigId };
  let to: TopologyLinkTarget["to"] = "/topology", path = "/topology";
  if (scope.kind !== "host") {
    to = scope.kind === "rig" ? "/topology/rig/$rigId" : scope.kind === "pod" ? "/topology/pod/$rigId/$podName" : "/topology/seat/$rigId/$logicalId";
    path += `/${scope.kind}/${encodeURIComponent(scope.rigId)}`;
    if (scope.kind === "pod") { params.podName = scope.podName; path += `/${encodeURIComponent(scope.podName)}`; }
    if (scope.kind === "seat") { params.logicalId = scope.logicalId; path += `/${encodeURIComponent(scope.logicalId)}`; }
  }
  const href = path + stringifyTopologySearch(search);
  if (new TextEncoder().encode(href).length > TOPOLOGY_URL_LIMIT)
    return { ok: false, issues: [{ field: "location", code: "too_large", blocking: true }] };
  return { ok: true, target: { to, params, search, href } };
}
/** The candidate must come from a usable served projection, never a label or
 * inferred logical seat. Pod membership is validated only against that fact. */
export function topologySelectionMatches(scope: TopologyScope, sourceHost: string, selection: TopologySelection,
  candidate: { hostId: string; rigId: string; nodeId: string; podNamespace: string | null }): boolean {
  return scope.kind !== "seat" && candidate.hostId === sourceHost && candidate.rigId === selection.rigId
    && candidate.nodeId === selection.nodeId && (scope.kind === "host" || scope.rigId === selection.rigId)
    && (scope.kind !== "pod" || candidate.podNamespace === scope.podName);
}
