import type { LifecycleCompilation } from "@openrig/daemon/project-lifecycle";
import type { SliceDetail } from "../hooks/useSlices.js";
import type { WorkflowLifecycleExecution } from "./workflow-contracts.js";
import { isWorkflowLifecycleExecution } from "./workflow-contracts.js";
import { arrayOf, hasShape, isBoolean, isInteger, isNumber, isObject, isText, nullable, oneOf, optional, OperatorReadError, operatorScopeKey, operatorScopeState, type Check, type OperatorInstanceScope } from "./operator-read.js";

export interface ProjectSelection { readonly id: string; readonly root: string }
export interface CatalogProject { id: string; root: string; name: string; sourcePath: string | null; missionsRoot: string; error?: string }
export interface ProjectCatalog { catalogPath: string; projects: CatalogProject[] }
const identity = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const directory = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isProjectSelection(value: unknown): value is ProjectSelection {
  return hasShape(value, { id: v => isText(v) && identity.test(v), root: v => isText(v) && /^(?:\/|[A-Za-z]:[\\/])/.test(v) && !v.includes("\0") });
}
export function requireProjectSelection(selection: unknown): asserts selection is ProjectSelection {
  if (!isProjectSelection(selection)) throw new OperatorReadError("invalid_request", "Choose the exact catalog project ID and canonical absolute root before reading project data.");
}
export function createProjectSelection(id: string, root: string): ProjectSelection {
  const selection = { id, root }; requireProjectSelection(selection); return Object.freeze(selection);
}
export function requireProjectDirectory(value: unknown, label: string): asserts value is string {
  if (!isText(value) || !directory.test(value)) throw new OperatorReadError("invalid_request", `${label} requires one exact directory identity.`);
}
export function projectParams(selection: ProjectSelection): URLSearchParams {
  requireProjectSelection(selection); return new URLSearchParams({ project: selection.id, projectRoot: selection.root });
}
export function projectKey(scope: OperatorInstanceScope, selection: ProjectSelection | null): readonly (string | null)[] {
  return [...operatorScopeKey(scope), "projects", selection?.id ?? null, selection?.root ?? null];
}
function projectSliceFileUrl(scope: OperatorInstanceScope, selection: ProjectSelection, mission: string, slice: string, relPath: string, family: "doc" | "proof-asset"): string {
  const scopeError = operatorScopeState(scope).scopeError; if (scopeError) throw scopeError;
  const params = projectParams(selection); requireProjectDirectory(mission, "Mission"); requireProjectDirectory(slice, "Slice");
  if (!isText(relPath) || !relPath || /^[A-Za-z]:/.test(relPath) || relPath.includes("\\") || relPath.includes("\0") || relPath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new OperatorReadError("invalid_request", "Slice files require a contained relative path.");
  }
  params.set("mission", mission);
  return `/api/slices/${encodeURIComponent(slice)}/${family}/${relPath.split("/").map(encodeURIComponent).join("/")}?${params}`;
}
export function projectSliceDocumentUrl(scope: OperatorInstanceScope, selection: ProjectSelection, mission: string, slice: string, relPath: string): string {
  return projectSliceFileUrl(scope, selection, mission, slice, relPath, "doc");
}
export function projectSliceProofAssetUrl(scope: OperatorInstanceScope, selection: ProjectSelection, mission: string, slice: string, relPath: string): string {
  return projectSliceFileUrl(scope, selection, mission, slice, relPath, "proof-asset");
}
export interface ProjectSliceDocument { relPath: string; content: string }
const textOrNull = nullable(isText);
const source = (v: unknown) => hasShape(v, { file: isText, line: isInteger });
const textMap = (v: unknown) => isObject(v) && Object.values(v).every(isText);
function isCatalogProject(v: unknown): v is CatalogProject { return hasShape(v, { id: isText, root: isText, name: isText, sourcePath: textOrNull, missionsRoot: isText, error: optional(isText) }); }
export function isProjectCatalog(v: unknown): v is ProjectCatalog { return hasShape(v, { catalogPath: isText, projects: arrayOf(isCatalogProject) }); }

// Narrow daemon TYPE surface supplies native proof types without bundling its Node readers.
export type MissionReadiness = LifecycleCompilation["readiness"];
export type ScopeReadiness = MissionReadiness["slices"][number]["readiness"];
export type NativeJudgment = NonNullable<ScopeReadiness["items"][number]["judgment"]>;
export interface ProjectReadiness { revision: string; state: "ready" | "unknown" | "not-ready"; missions: Array<MissionReadiness & { name: string }>; basis: string }
const readinessState = oneOf("ready", "not-ready", "unknown", "legacy");
const verdict = oneOf("accept", "reject", "withdraw");
const judgment: Check = v => hasShape(v, { version: oneOf(1), sequence: isInteger, scope: isText, id: isText, operationId: isText, itemId: isText, itemRevision: isText, policyRevision: isText, policySource: isText, previous: textOrNull, actor: isText, provenance: isText, at: isText, verdict, reason: isText, evidence: arrayOf(x => hasShape(x, { ref: isText, sha256: isText })), subject: x => hasShape(x, { kind: oneOf("artifact", "commit", "patch-equivalent"), ref: isText, comparison: optional(isText) }), intent: isText });
export function isScopeReadiness(v: unknown): v is ScopeReadiness {
  return hasShape(v, { configured: isBoolean, revision: isText, state: readinessState,
    history: arrayOf(x => hasShape(x, { ref: isText, id: isText, itemId: isText, verdict, previous: textOrNull })),
    items: arrayOf(x => hasShape(x, { id: isText, text: isText, revision: isText, index: isInteger, source, state: oneOf("accepted", "pending", "rejected", "withdrawn", "unknown"), reason: isText, judgment: nullable(judgment) })),
    issues: arrayOf(isText), policy: nullable(x => hasShape(x, { judges: arrayOf(isText), source: isText, revision: isText })), attention: x => hasShape(x, { scope: isText, revision: isText }),
  });
}
export function isMissionReadiness(v: unknown): v is MissionReadiness {
  return hasShape(v, { revision: isText, state: readinessState, issues: arrayOf(isText), historicalStatus: textOrNull,
    slices: arrayOf(x => hasShape(x, { scope: isText, id: isText, readiness: isScopeReadiness, dependsOn: arrayOf(isText), eligible: nullable(isBoolean) })) });
}
export interface ScopeContractItem { id: string; index: number; source: { file: string; line: number }; text: string; paired: boolean; drops: Array<{ file: string; artifactType: string | null; verdict: string | null; media: string[] }> }
export interface CanonicalSliceScope {
  dirName: string; id: string | null; displayName: string; status: string | null; stage: string | null;
  locks: { spec: { by: string; at: string } | null; delivery: { by: string; at: string } | null };
  proof: { paired: number; total: number }; readiness?: ScopeReadiness; error?: string; sourcePath?: string;
  intent: string; miniRequirements: string[]; proofContract: ScopeContractItem[]; progressPath: string | null;
  specShaShort: string | null; prdExists: boolean; narrative: string | null;
}
export interface CanonicalMissionScope { mission: string; slices: CanonicalSliceScope[]; readiness?: MissionReadiness; error?: string }
export interface CanonicalScopes { missions: CanonicalMissionScope[]; sources: Record<string, string>; readErrors: string[]; project: CatalogProject; sourceObservation: { state: "watching" | "unavailable"; revision: string } }
const lock = nullable((v: unknown) => hasShape(v, { by: isText, at: isText }));
function isSliceScope(v: unknown): v is CanonicalSliceScope {
  return hasShape(v, { dirName: isText, id: textOrNull, displayName: isText, status: textOrNull, stage: textOrNull,
    locks: x => hasShape(x, { spec: lock, delivery: lock }), proof: x => hasShape(x, { paired: isInteger, total: isInteger }), readiness: optional(isScopeReadiness), error: optional(isText), sourcePath: optional(isText),
    intent: isText, miniRequirements: arrayOf(isText), proofContract: arrayOf(x => hasShape(x, { id: isText, index: isInteger, source, text: isText, paired: isBoolean, drops: arrayOf(d => hasShape(d, { file: isText, artifactType: textOrNull, verdict: textOrNull, media: arrayOf(isText) })) })),
    progressPath: textOrNull, specShaShort: textOrNull, prdExists: isBoolean, narrative: textOrNull });
}
export function isCanonicalScopes(v: unknown): v is CanonicalScopes {
  return hasShape(v, { missions: arrayOf(x => hasShape(x, { mission: isText, slices: arrayOf(isSliceScope), readiness: optional(isMissionReadiness), error: optional(isText) }) && (x.error !== undefined || isMissionReadiness(x.readiness))), sources: textMap, readErrors: arrayOf(isText), project: isCatalogProject, sourceObservation: x => hasShape(x, { state: oneOf("watching", "unavailable"), revision: isText }) });
}

export type ProjectSliceDetail = Omit<SliceDetail, "readiness"> & { readiness: ScopeReadiness };
const currentStep: Check = v => hasShape(v, { stepId: isText, role: isText, objective: textOrNull, allowedExits: arrayOf(isText), allowedNextSteps: arrayOf(x => hasShape(x, { stepId: isText, role: isText, reason: oneOf("next_hop") })), hopCount: isInteger, instanceStatus: isText });
export function isProjectSliceDetail(v: unknown): v is ProjectSliceDetail {
  return hasShape(v, { readiness: isScopeReadiness, name: isText, missionId: textOrNull, slicePath: isText, displayName: isText, railItem: textOrNull, status: isText, rawStatus: textOrNull, qitemIds: arrayOf(isText), commitRefs: arrayOf(isText), lastActivityAt: textOrNull,
    workflowBinding: nullable(x => hasShape(x, { instanceId: isText, workflowName: isText, workflowVersion: isText, status: isText, currentStepId: textOrNull, currentFrontier: arrayOf(isText), hopCount: isInteger, createdAt: isText, completedAt: textOrNull, additionalInstanceIds: arrayOf(isText) })),
    story: x => hasShape(x, { events: arrayOf(e => hasShape(e, { ts: isText, phase: textOrNull, kind: isText, actorSession: textOrNull, qitemId: textOrNull, summary: isText, detail: nullable(isObject) })), phaseDefinitions: nullable(arrayOf(p => hasShape(p, { id: isText, label: isText, role: isText }))) }),
    acceptance: x => hasShape(x, { totalItems: isInteger, doneItems: isInteger, percentage: isNumber, items: arrayOf(i => hasShape(i, { text: isText, done: isBoolean, source, doneVia: optional(oneOf("checkbox", "qa-verdict")) })), closureCallout: textOrNull, currentStep: nullable(currentStep) }),
    decisions: x => hasShape(x, { rows: arrayOf(r => hasShape(r, { actionId: isText, ts: isText, actor: isText, verb: isText, qitemId: isText, reason: textOrNull, beforeState: textOrNull, afterState: textOrNull })) }),
    docs: x => hasShape(x, { tree: arrayOf(t => hasShape(t, { name: isText, type: oneOf("file", "dir"), size: nullable(isNumber), mtime: textOrNull, relPath: isText })) }),
    tests: x => hasShape(x, { proofPackets: arrayOf(p => hasShape(p, { dirName: isText, primaryMarkdown: nullable(m => hasShape(m, { relPath: isText, content: isText })), additionalMarkdown: arrayOf(m => hasShape(m, { relPath: isText, content: isText })), screenshots: arrayOf(isText), videos: arrayOf(isText), traces: arrayOf(isText), passFailBadge: oneOf("pass", "fail", "partial", "unknown") })), aggregate: a => hasShape(a, { passCount: isInteger, failCount: isInteger }) }),
    topology: x => hasShape(x, { affectedRigs: arrayOf(r => hasShape(r, { rigId: isText, rigName: isText, sessionNames: arrayOf(isText) })), totalSeats: isInteger, specGraph: nullable(g => hasShape(g, { specName: isText, specVersion: isText, nodes: arrayOf(n => hasShape(n, { stepId: isText, label: isText, role: isText, preferredTarget: textOrNull, isEntry: isBoolean, isCurrent: isBoolean, isTerminal: isBoolean })), edges: arrayOf(e => hasShape(e, { fromStepId: isText, toStepId: isText, routingType: oneOf("direct"), isLoopBack: isBoolean })) })) }),
  });
}

export type ExecutionTruth = boolean | "INDETERMINATE";
export interface ExecutionRung { value: ExecutionTruth | "NOT_APPLICABLE"; basis: string }
export interface ExecutionLane { qitem_id: string; slice: string; seat: string; worktree_path: string; branch: string; head_sha: string; fragile_join: boolean; join_basis: string; activity: { activity: "INDETERMINATE"; basis: string; source: string } | { activity: "working" | "idle-at-prompt" | "unknown"; needs_input: { count: number; reason: string | null }; decided_by: string | null; changed_at: string; source: string }; pickup: { state: "unclaimed" | "working" | "stalled-after-claim" | "parked" | "terminal"; evidence?: string }; source: { qitem_id: string } }
export interface ExecutionSequence { slice_id: string; dir: string; planned_owners: Array<{ component: string; owner: string; source: string }>; work_rows: Array<{ qitem_id: string; seat: string; state: string; summary: string | null; blocked_on: string | null; claimed_at: string | null }>; depends_on: string[] | "INDETERMINATE"; soft_after: string[]; blocked_on_rows: Array<{ qitem_id: string; blocked_on: string }>; next_up: ExecutionTruth; next_up_basis: string; next_up_rank: number | null; source: { spec_path: string; wave_map_row: string; arrangement_path?: string } }
export interface ExecutionCare { slice_id: string; build_wave: string; review_model: string; planning_dial: string; source: { wave_map_row: string; arrangement_path?: string; dial: string } }
export interface ExecutionLadder { slice_id: string; dir: string; locked: ExecutionRung; built: { candidate_sha: string; resolved_commit?: string; basis: string }; reviewed: ExecutionRung & { legs: Array<{ path: string; verdict: string; candidate_sha: string | null; artifact_type: string | null }>; excluded?: Array<{ path: string; reason: string }> }; folded: ExecutionRung; adopted: ExecutionRung }
export interface ExecutionPark { qitem_id: string; pickup_state: string; pickup_evidence?: string; park_kind: "deliberate-with-wake" | "stalled" | "indeterminate"; park_kind_basis: string; wake_target: string | null; age_minutes: number | null; source: { qitem_id: string } }
export interface ExecutionSources {
  queue_db: { asof: string; basis: string }; slice_frontmatter: { root: string; asof: string }; wave_map: { row: string; asof: string; superseded_by?: string };
  arrangement?: { value?: "INDETERMINATE"; manifest: string; asof: string; basis: string }; git: { basis: string; asof: string }; build_info: { commit: string; asof: string; basis: string }; review_artifacts: { root: string; asof: string }; disk: { asof: string }; workflow_lifecycle: { asof: string; basis: string };
}
export interface ExecutionDocument { project: string; membership: string; view: "execution"; mission: string; derived_at: string; readiness: MissionReadiness | null; project_readiness: ProjectReadiness | null; planning_guidance: Array<{ label: string; text: string; source: string; wave?: string }>; sources: ExecutionSources; lifecycle_instances: WorkflowLifecycleExecution[]; q1_lanes: ExecutionLane[]; q2_sequencing: ExecutionSequence[]; q3_care: ExecutionCare[]; q4_ladder: ExecutionLadder[]; q5_park: ExecutionPark[]; q6_parallelism: { lanes_live: number; lanes_possible: number; idle_seats_with_capacity: { value: number | "INDETERMINATE"; basis: string }; heavy_slot_holder: { value: string | null; basis: string }; df_margin: { available_kib: number | "INDETERMINATE"; path?: string; basis: string } } }
export interface ExecutionView { viewName: "execution"; generatedAt: string; rows: [ExecutionDocument]; rowCount: 1 }
const truth = oneOf(true, false, "INDETERMINATE");
const rung: Check = v => hasShape(v, { value: oneOf(true, false, "INDETERMINATE", "NOT_APPLICABLE"), basis: isText });
const asof: Check = v => hasShape(v, { asof: isText });
const basis: Check = v => hasShape(v, { asof: isText, basis: isText });
const pickupState = oneOf("unclaimed", "working", "stalled-after-claim", "parked", "terminal");
function isExecutionDocument(v: unknown): v is ExecutionDocument {
  return hasShape(v, { project: isText, membership: isText, view: oneOf("execution"), mission: isText, derived_at: isText, readiness: nullable(isMissionReadiness),
    project_readiness: nullable(x => hasShape(x, { revision: isText, state: oneOf("ready", "unknown", "not-ready"), missions: arrayOf(m => isMissionReadiness(m) && hasShape(m, { name: isText })), basis: isText })),
    planning_guidance: arrayOf(x => hasShape(x, { label: isText, text: isText, source: isText, wave: optional(isText) })),
    sources: x => hasShape(x, { queue_db: basis, slice_frontmatter: s => asof(s) && hasShape(s, { root: isText }), wave_map: s => asof(s) && hasShape(s, { row: isText, superseded_by: optional(isText) }), arrangement: optional(s => basis(s) && hasShape(s, { value: optional(oneOf("INDETERMINATE")), manifest: isText })), git: basis, build_info: s => basis(s) && hasShape(s, { commit: isText }), review_artifacts: s => asof(s) && hasShape(s, { root: isText }), disk: asof, workflow_lifecycle: basis }),
    lifecycle_instances: arrayOf(isWorkflowLifecycleExecution),
    q1_lanes: arrayOf(x => hasShape(x, { qitem_id: isText, slice: isText, seat: isText, worktree_path: isText, branch: isText, head_sha: isText, fragile_join: isBoolean, join_basis: isText, source: s => hasShape(s, { qitem_id: isText }), pickup: p => hasShape(p, { state: pickupState, evidence: optional(isText) }), activity: a => isObject(a) && (a.activity === "INDETERMINATE" ? hasShape(a, { basis: isText, source: isText }) : hasShape(a, { activity: oneOf("working", "idle-at-prompt", "unknown"), needs_input: n => hasShape(n, { count: isInteger, reason: textOrNull }), decided_by: textOrNull, changed_at: isText, source: isText })) })),
    q2_sequencing: arrayOf(x => hasShape(x, { slice_id: isText, dir: isText, planned_owners: arrayOf(o => hasShape(o, { component: isText, owner: isText, source: isText })), work_rows: arrayOf(r => hasShape(r, { qitem_id: isText, seat: isText, state: isText, summary: textOrNull, blocked_on: textOrNull, claimed_at: textOrNull })), depends_on: d => d === "INDETERMINATE" || arrayOf(isText)(d), soft_after: arrayOf(isText), blocked_on_rows: arrayOf(r => hasShape(r, { qitem_id: isText, blocked_on: isText })), next_up: truth, next_up_basis: isText, next_up_rank: nullable(isNumber), source: s => hasShape(s, { spec_path: isText, wave_map_row: isText, arrangement_path: optional(isText) }) })),
    q3_care: arrayOf(x => hasShape(x, { slice_id: isText, build_wave: isText, review_model: isText, planning_dial: isText, source: s => hasShape(s, { wave_map_row: isText, arrangement_path: optional(isText), dial: isText }) })),
    q4_ladder: arrayOf(x => hasShape(x, { slice_id: isText, dir: isText, locked: rung, built: b => hasShape(b, { candidate_sha: isText, resolved_commit: optional(isText), basis: isText }), reviewed: r => rung(r) && hasShape(r, { legs: arrayOf(l => hasShape(l, { path: isText, verdict: isText, candidate_sha: textOrNull, artifact_type: textOrNull })), excluded: optional(arrayOf(e => hasShape(e, { path: isText, reason: isText }))) }), folded: rung, adopted: rung })),
    q5_park: arrayOf(x => hasShape(x, { qitem_id: isText, pickup_state: pickupState, pickup_evidence: optional(isText), park_kind: oneOf("deliberate-with-wake", "stalled", "indeterminate"), park_kind_basis: isText, wake_target: textOrNull, age_minutes: nullable(isNumber), source: s => hasShape(s, { qitem_id: isText }) })),
    q6_parallelism: x => hasShape(x, { lanes_live: isInteger, lanes_possible: isInteger, idle_seats_with_capacity: c => hasShape(c, { value: v => v === "INDETERMINATE" || isInteger(v), basis: isText }), heavy_slot_holder: h => hasShape(h, { value: textOrNull, basis: isText }), df_margin: d => hasShape(d, { available_kib: v => v === "INDETERMINATE" || isInteger(v), path: optional(isText), basis: isText }) }),
  });
}
export function isExecutionView(v: unknown): v is ExecutionView { return hasShape(v, { viewName: oneOf("execution"), generatedAt: isText, rowCount: oneOf(1), rows: x => Array.isArray(x) && x.length === 1 && isExecutionDocument(x[0]) }); }
