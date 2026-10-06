import type { NodeDetailData } from "../hooks/useNodeDetail.js";
import type { LibraryAgentReview, LibraryRigReview, LibraryWorkflowReview, SpecLibraryEntry, SpecLibraryKind } from "../hooks/useSpecLibrary.js";
import { withHostParam } from "./host-param.js";
import { arrayOf, hasShape, isBoolean, isInteger, isObject, isText, nullable, optional, oneOf,
  LOCAL_OPERATOR_INSTANCE, operatorRead, OperatorReadError, type OperatorReadOptions } from "./operator-read.js";

const exactText = (v: unknown): v is string => isText(v) && !!v.trim();
const textOrNull = nullable(isText);
const actions = arrayOf(v => hasShape(v, { type: isText, value: isText }));
const specEdges = arrayOf(v => hasShape(v, { from: isText, to: isText, kind: isText }));
const endpoint = (v: unknown) => hasShape(v, { logicalId: isText, sessionName: textOrNull });
const nodeEdges = arrayOf(v => hasShape(v, { kind: isText, from: optional(endpoint), to: optional(endpoint) }));

/** Validate the consumer's required shape, retaining the original DTO and all
 * additional lifecycle/binding/native facts. Nullable unconfigured seats remain
 * readable; their eligibility for actions is a separate contract. */
export function isNodeDetail(v: unknown): v is NodeDetailData {
  return hasShape(v, {
    nodeId: optional(isText), rigId: exactText, rigName: isText, logicalId: exactText, podId: textOrNull, podNamespace: optional(textOrNull),
    canonicalSessionName: textOrNull, nodeKind: oneOf("agent", "infrastructure"), runtime: textOrNull,
    sessionStatus: textOrNull, startupStatus: nullable(oneOf("pending", "ready", "attention_required", "failed")),
    restoreOutcome: isText, tmuxAttachCommand: textOrNull, resumeCommand: textOrNull,
    recoveryGuidance: optional(nullable(g => hasShape(g, { summary: isText, commands: arrayOf(isText), notes: arrayOf(isText) }))),
    latestError: textOrNull, model: textOrNull, agentRef: textOrNull, profile: textOrNull,
    resolvedSpecName: textOrNull, resolvedSpecVersion: textOrNull, resolvedSpecHash: optional(textOrNull), cwd: textOrNull,
    startupFiles: arrayOf(f => hasShape(f, { path: isText, deliveryHint: isText, required: isBoolean,
      absolutePath: optional(textOrNull), ownerRoot: optional(textOrNull) })),
    startupActions: actions, recentEvents: arrayOf(e => hasShape(e, { type: isText, createdAt: isText })),
    infrastructureStartupCommand: textOrNull,
    peers: arrayOf(p => hasShape(p, { logicalId: isText, canonicalSessionName: textOrNull, runtime: textOrNull })),
    edges: e => hasShape(e, { outgoing: nodeEdges, incoming: nodeEdges }),
    transcript: t => hasShape(t, { enabled: isBoolean, path: textOrNull, tailCommand: textOrNull }),
    compactSpec: s => hasShape(s, { name: textOrNull, version: textOrNull, profile: textOrNull, skillCount: isInteger, guidanceCount: isInteger }),
  });
}
export function isSpecLibraryEntry(v: unknown): v is SpecLibraryEntry {
  return hasShape(v, { id: exactText, kind: oneOf("rig", "agent", "workflow"), name: isText, version: isText,
    sourceType: oneOf("builtin", "user_file"), sourcePath: isText, relativePath: isText, updatedAt: isText,
    resolvedSourcePath: optional(textOrNull), summary: optional(isText), hasServices: optional(isBoolean),
    isBuiltIn: optional(isBoolean), rolesCount: optional(isInteger), stepsCount: optional(isInteger),
    terminalTurnRule: optional(isText), targetRig: optional(textOrNull), status: optional(oneOf("valid", "error")), errorMessage: optional(textOrNull) });
}
export type LibraryReviewData = LibraryRigReview | LibraryAgentReview | LibraryWorkflowReview;
export function isLibraryReview(v: unknown): v is LibraryReviewData {
  if (!hasShape(v, { libraryEntryId: exactText, kind: oneOf("rig", "agent", "workflow"), name: isText,
    version: isText, sourcePath: isText })) return false;
  if (v.kind === "workflow") {
    // Workflow reviews come from the cache and do not serve sourceState/raw.
    return hasShape(v, { purpose: textOrNull, targetRig: textOrNull, terminalTurnRule: isText,
      rolesCount: isInteger, stepsCount: isInteger, isBuiltIn: isBoolean, cachedAt: isText,
      topology: t => hasShape(t, {
        nodes: arrayOf(n => hasShape(n, { stepId: isText, role: isText, objective: textOrNull,
          preferredTarget: textOrNull, isEntry: isBoolean, isTerminal: isBoolean })),
        edges: arrayOf(e => hasShape(e, { fromStepId: isText, toStepId: isText, routingType: oneOf("direct", "branch"),
          branchOn: optional(oneOf("handoff", "waiting", "done", "failed")) })),
      }), steps: arrayOf(s => hasShape(s, { stepId: isText, role: isText, objective: textOrNull,
        allowedExits: arrayOf(isText), allowedNextSteps: arrayOf(n => hasShape(n, { stepId: isText, role: isText })) })) });
  }
  if (!hasShape(v, { sourceState: oneOf("library_item"), raw: isText })) return false;
  if (v.kind === "agent") return hasShape(v, {
    profiles: arrayOf(p => hasShape(p, { name: isText, description: optional(textOrNull) })),
    resources: r => hasShape(r, { skills: arrayOf(isText), guidance: arrayOf(isText), plugins: arrayOf(isText), subagents: arrayOf(isText) }),
    startup: s => hasShape(s, { files: arrayOf(f => hasShape(f, { path: isText, required: isBoolean })), actions }),
  });
  return hasShape(v, { format: oneOf("legacy", "pod_aware"), edges: specEdges,
    nodes: optional(arrayOf(n => hasShape(n, { id: isText, runtime: isText }))),
    pods: optional(arrayOf(p => hasShape(p, { id: isText,
      members: arrayOf(m => hasShape(m, { id: isText, agentRef: isText, runtime: isText })), edges: specEdges }))),
    graph: g => hasShape(g, { nodes: arrayOf(n => hasShape(n, { id: isText, label: isText, runtime: isText, kind: oneOf("agent", "infrastructure") })),
      edges: arrayOf(e => hasShape(e, { source: isText, target: isText, kind: isText })) }),
  });
}
function requireIdentity(...ids: (string | null | undefined)[]) {
  if (!ids.every(exactText)) throw new OperatorReadError("invalid_request", "Choose an exact node or library identity before reading.");
}
function identityMismatch(entity: string): never {
  throw new OperatorReadError("invalid_contract", `${entity} response belongs to another selection; refresh this selection before using its facts.`);
}
/** These GETs are supported by daemon read-through. LOCAL_OPERATOR_INSTANCE
 * describes the transport endpoint (the connected daemon), while the selected
 * origin rides its existing host query envelope. No remote URL/bearer reaches
 * the browser, and no local fallback is attempted after an origin failure. */
export async function readNodeDetail(rigId: string | null, logicalId: string | null, hostId: string, options: OperatorReadOptions = {}) {
  requireIdentity(rigId, logicalId, hostId);
  return operatorRead(LOCAL_OPERATOR_INSTANCE,
    withHostParam(`/api/rigs/${encodeURIComponent(rigId!)}/nodes/${encodeURIComponent(logicalId!)}`, hostId),
    (v): v is NodeDetailData => {
      if (isObject(v) && ((isText(v.rigId) && v.rigId !== rigId) || (isText(v.logicalId) && v.logicalId !== logicalId))) identityMismatch("Node detail");
      return isNodeDetail(v);
    }, options);
}
export async function readLibraryEntries(kind: SpecLibraryKind | undefined, hostId: string, options: OperatorReadOptions = {}) {
  requireIdentity(hostId);
  if (kind !== undefined && !oneOf("rig", "agent", "workflow")(kind)) throw new OperatorReadError("invalid_request", "Choose a supported library kind.");
  return operatorRead(LOCAL_OPERATOR_INSTANCE, withHostParam(kind ? `/api/specs/library?kind=${kind}` : "/api/specs/library", hostId),
    (v): v is SpecLibraryEntry[] => Array.isArray(v) && v.every(row => isSpecLibraryEntry(row) && (!kind || row.kind === kind)), options);
}
export async function readLibraryReview(id: string | null, hostId: string, options: OperatorReadOptions = {}) {
  requireIdentity(id, hostId);
  return operatorRead(LOCAL_OPERATOR_INSTANCE, withHostParam(`/api/specs/library/${encodeURIComponent(id!)}/review`, hostId),
    (v): v is LibraryReviewData => {
      if (isObject(v) && isText(v.libraryEntryId) && v.libraryEntryId !== id) identityMismatch("Library review");
      return isLibraryReview(v);
    }, options);
}
