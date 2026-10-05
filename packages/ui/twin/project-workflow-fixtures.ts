// TEST-ONLY sanitized fictional fixtures for the exact catalog project page
// (/project/catalog) and the rich workflow instance page. Two catalog projects
// deliberately share a display name, mission name and slice directory; a third
// entry is unavailable. One project's slice carries a withdrawn native outcome
// beside a legacy review PASS. Workflows include one failed instance with two
// unresolved occurrences, one aborted instance and one active instance with a
// source-only plan revision. Mutations change only this in-memory twin state.
//
// Integration: the twin fetch stub calls `projectWorkflowTwinBody(pathname,
// search, method, body)` before its other routes (see
// docs/plans/gui-project-workflow-ui.md for the exact snippet).

type TwinResponse = { body: unknown; status: number };
const at = "2026-10-04T12:00:00Z";
const later = "2026-10-04T12:40:00Z";

const PROJECTS = [
  { id: "guide-north", root: "/srv/books/north", name: "Field Guide", sourcePath: "/srv/books/north/project.yaml", missionsRoot: "/srv/books/north/missions" },
  { id: "guide-south", root: "/srv/books/south", name: "Field Guide", sourcePath: "/srv/books/south/project.yaml", missionsRoot: "/srv/books/south/missions" },
  { id: "atlas", root: "/srv/books/atlas", name: "Atlas", sourcePath: "/srv/books/atlas/project.yaml", missionsRoot: "/srv/books/atlas/missions", error: "Project root is not readable" },
];
const catalog = { catalogPath: "/srv/books/workspace.yaml", projects: PROJECTS };

const withdrawn = (id: string) => ({
  version: 1, sequence: 2, scope: "launch/slices/01-intro", id: `judgment-2-${id}`, operationId: `op-2-${id}`, itemId: "intro-reads", itemRevision: "rev-item-1",
  policyRevision: "rev-policy-1", policySource: "project.yaml", previous: `judgment-1-${id}`, actor: "editor@guide", provenance: "transport:v1", at: later,
  verdict: "withdraw", reason: "Screenshots show the old cover; reopening until replaced.", evidence: [{ ref: "proof/cover-check.md", sha256: "c".repeat(64) }],
  subject: { kind: "artifact", ref: "chapters/intro.md" }, intent: "Judge whether the introduction reads cleanly",
});
const readinessFor = (id: string) => id === "guide-north" ? {
  configured: true, revision: "readiness-north-3", state: "not-ready",
  history: [
    { ref: "proof/judgments/00000001.md", id: `judgment-1-${id}`, itemId: "intro-reads", verdict: "accept", previous: null },
    { ref: "proof/judgments/00000002.md", id: `judgment-2-${id}`, itemId: "intro-reads", verdict: "withdraw", previous: `judgment-1-${id}` },
  ],
  items: [{ id: "intro-reads", text: "The introduction reads cleanly on a phone", revision: "rev-item-1", index: 1, source: { file: "SPEC.md", line: 9 }, state: "withdrawn", reason: "Withdrawn by editor@guide", judgment: withdrawn(id) },
    { id: "intro-links", text: "Every cross-reference resolves", revision: "rev-item-2", index: 2, source: { file: "SPEC.md", line: 10 }, state: "pending", reason: "No judgment recorded", judgment: null }],
  issues: ["Outcome intro-reads was withdrawn"], policy: { judges: ["editor@guide"], source: "project.yaml", revision: "rev-policy-1" },
  attention: { scope: "launch/slices/01-intro", revision: "readiness-north-3" },
} : {
  configured: false, revision: "readiness-south-1", state: "unknown", history: [], items: [], issues: [], policy: null,
  attention: { scope: "launch/slices/01-intro", revision: "readiness-south-1" },
};
const missionReadiness = (id: string) => ({ revision: `mission-${id}`, state: id === "guide-north" ? "not-ready" : "unknown", issues: [],
  slices: [{ scope: "01-intro", id: "intro", readiness: readinessFor(id), dependsOn: [], eligible: true }], historicalStatus: "active" });

const scopeSlice = (p: (typeof PROJECTS)[number]) => ({
  dirName: "01-intro", id: "intro", displayName: "Slice 01 — Introduction", status: "done", stage: "review",
  locks: { spec: { by: "editor@guide", at }, delivery: null }, proof: { paired: 1, total: 2 }, readiness: readinessFor(p.id),
  intent: `Introduce the ${p.id === "guide-north" ? "northern" : "southern"} edition.`, miniRequirements: ["Reads cleanly on a phone", "Cross-references resolve"],
  proofContract: [
    { id: "intro-reads", index: 1, source: { file: "SPEC.md", line: 9 }, text: "The introduction reads cleanly on a phone", paired: true,
      drops: [{ file: "proof/phone-review.md", artifactType: "review", verdict: "PASS", media: ["proof/phone.png"] }] },
    { id: "intro-links", index: 2, source: { file: "SPEC.md", line: 10 }, text: "Every cross-reference resolves", paired: false, drops: [] },
  ],
  progressPath: `${p.missionsRoot}/launch/slices/01-intro/PROGRESS.md`, specShaShort: "9f31c0a", prdExists: false,
  narrative: "- [x] Draft written\n- [x] Phone check (display only — not an outcome judgment)", sourcePath: `${p.missionsRoot}/launch/slices/01-intro/SPEC.md`,
});
const scopes = (p: (typeof PROJECTS)[number]) => ({
  missions: [
    { mission: "launch", slices: [scopeSlice(p)], readiness: missionReadiness(p.id) },
    ...(p.id === "guide-south" ? [{ mission: "archive", slices: [], error: "mission.yaml could not be parsed" }] : []),
  ],
  sources: { launch: `${p.missionsRoot}/launch/mission.yaml` },
  readErrors: p.id === "guide-south" ? ["missions/archive: mission.yaml could not be parsed"] : [],
  project: p, sourceObservation: { state: "unavailable", revision: "unverified" },
});

const reconciliation = (instanceId: string, status = "current") => ({
  status, adopted: status === "current", boundDigest: "sha256:bound-1", proposedDigest: status === "current" ? "sha256:bound-1" : "sha256:authored-2",
  boundVersion: "1", proposedVersion: status === "current" ? "1" : "2", compatible: true,
  changes: status === "current" ? [] : [{ kind: "source-changed", ref: "mission.yaml", fields: ["sdlc.catalog.address"] }], reasons: [],
  composition: { mode: "extend", explanation: status === "current" ? "The running plan matches its authored sources." : "Only catalog source bytes changed.", boundSlices: ["intro"], executableSteps: [{ id: "draft", dependsOn: [] }, { id: "review", dependsOn: ["draft"] }] },
  nextAction: status === "current" ? "Nothing to apply." : `rig workflow revise ${instanceId} --expected-version 5 --expected-digest sha256:authored-2`,
  expectedVersion: 5, ...(status === "current" ? {} : { operationKey: `revision:${instanceId}:5`, applyCommand: "Inspect, then apply explicitly" }),
});

const lifecycle = (p: (typeof PROJECTS)[number]) => ({
  instance_id: `wf-${p.id}`, workflow_name: "guide-release", workflow_version: "1", description: "Release the introduction", status: p.id === "guide-north" ? "failed" : "active",
  operation_key: `instantiate-${p.id}`, compiled_input_digest: "sha256:bound-1", identity: { project: p.id, mission: "launch", lifecycleProfile: "release" },
  sources: [{ kind: "mission", path: `${p.missionsRoot}/launch/mission.yaml`, sha256: "d".repeat(64) }], dependencies: [{ stepId: "review", dependsOn: ["draft"] }],
  graph_source: { mode: "extend", profileSource: `${p.root}/project.yaml`, missionSource: `${p.missionsRoot}/launch/mission.yaml`, requiredSteps: ["draft", "review"] },
  steps: [{ id: "draft", objective: "Draft the introduction", next_hop: null }, { id: "review", objective: "Review on a phone", next_hop: { mode: "require", suggested_roles: ["editor"] } }],
  reconciliation: reconciliation(`wf-${p.id}`, p.id === "guide-south" ? "source-only" : "current"),
  boundary_obligations: [
    { stepId: "draft", required: true, state: "closed", receiptState: "recorded", receipt: { evidenceRef: "chapters/intro.md", actorSession: "writer@guide", closedAt: at } },
    { stepId: "review", required: true, state: "open", receiptState: "missing", receipt: null },
  ],
  frontier_packets: p.id === "guide-north" ? [] : [{
    packet_id: "packet-review-south", step_id: "review", owner: "editor@guide", queue_state: "blocked", blocked_on: "human@guide",
    blocker: { qitem_id: "ask-cover", summary: "Choose the cover photo", destination_session: "human@guide", state: "pending", evidence_ref: "proof/covers.md" },
    summary: "Review the introduction on a phone", evidence_ref: "chapters/intro.md", objective: "Review on a phone",
    latest_transition: { ts: at, state: "blocked", transition_note: "Waiting for the cover decision", actor_session: "editor@guide" },
    wake: { kind: "timer", ref: "wake-cover", phase: "fired", live: false, deliveryStatus: "delivered", unconsumed: true, recoveryOwner: "queue-stuck-sweep", expiresAt: later },
    wake_schedule: { policy: "re-present", interval_seconds: 900, last_evaluation_at: at }, depends_on: ["draft"],
    gate: { target: "human@guide", summary: "Choose the cover photo", evidence_ref: "proof/covers.md" },
    acceptance: { candidate: "intro-draft-3", verdicts: ["accept", "reject"], evidence_ref: "chapters/intro.md" },
    targeted_action: "rig workflow project --instance 'wf-guide-south' --current-packet 'packet-review-south' --exit handoff",
  }],
  failure_occurrences: p.id === "guide-north" ? [
    { occurrence_id: "occ-north-1", step_id: "review", status: "unresolved", failure_reason: "Phone render crashed", redrive_packet_id: null, failed_at: at, resolved_at: null, targeted_action: "rig workflow resume wf-guide-north --occurrence occ-north-1" },
    { occurrence_id: "occ-north-2", step_id: "review", status: "unresolved", failure_reason: "Link checker timed out", redrive_packet_id: null, failed_at: later, resolved_at: null, targeted_action: "rig workflow resume wf-guide-north --occurrence occ-north-2" },
  ] : [],
  unknowns: p.id === "guide-north" ? ["Successor activation is not bound"] : [],
});

const execution = (p: (typeof PROJECTS)[number], mission: string) => ({
  viewName: "execution", generatedAt: later, rowCount: 1, rows: [{
    project: p.id, membership: "exact project:<id> tags", view: "execution", mission, derived_at: later, readiness: missionReadiness(p.id),
    project_readiness: { revision: `project-${p.id}`, state: "not-ready", missions: [{ name: mission, ...missionReadiness(p.id) }], basis: "Active mission readiness; distinct from outcome judgments" },
    planning_guidance: [{ label: "Review", text: "Phone review before any publication", source: "mission.yaml", wave: "wave-1" }, { label: "Scope", text: "Keep each edition separate", source: "project.yaml" }],
    sources: { queue_db: { asof: later, basis: "queue rows" }, slice_frontmatter: { root: p.missionsRoot, asof: later }, wave_map: { row: "INDETERMINATE", asof: later, superseded_by: "mission.yaml" },
      arrangement: { manifest: "mission.yaml", asof: later, basis: "composition order" }, git: { asof: later, basis: "No repository configured" },
      build_info: { commit: "INDETERMINATE", asof: later, basis: "Daemon source only" }, review_artifacts: { root: `${p.root}/reviews`, asof: later }, disk: { asof: later },
      workflow_lifecycle: { asof: later, basis: "Bound packets and current queue rows" } },
    q1_lanes: p.id === "guide-south" ? [{ qitem_id: "packet-review-south", slice: "intro", seat: "editor@guide", worktree_path: "INDETERMINATE", branch: "INDETERMINATE", head_sha: "INDETERMINATE",
      fragile_join: false, join_basis: "Exact slice tag", activity: { activity: "INDETERMINATE", basis: "Activity oracle unavailable", source: "SeatActivityService" }, pickup: { state: "parked" }, source: { qitem_id: "packet-review-south" } }] : [],
    q2_sequencing: [{ slice_id: "intro", dir: "01-intro", planned_owners: [{ component: "review", owner: "editor@guide", source: "slice.yaml" }],
      work_rows: p.id === "guide-south" ? [{ qitem_id: "packet-review-south", seat: "editor@guide", state: "blocked", summary: "Review on a phone", blocked_on: "human@guide", claimed_at: at }] : [],
      depends_on: [], soft_after: [], blocked_on_rows: p.id === "guide-south" ? [{ qitem_id: "packet-review-south", blocked_on: "human@guide" }] : [],
      next_up: false, next_up_basis: "Outcome reopened; no ready successor named", next_up_rank: null, source: { spec_path: "SPEC.md", wave_map_row: "INDETERMINATE", arrangement_path: "slice.yaml" } }],
    q3_care: [{ slice_id: "intro", build_wave: "wave-1", review_model: "pair", planning_dial: "careful", source: { wave_map_row: "INDETERMINATE", arrangement_path: "slice.yaml", dial: "mission.yaml" } }],
    q4_ladder: [{ slice_id: "intro", dir: "01-intro", locked: { value: true, basis: "Spec lock recorded" }, built: { candidate_sha: "intro-draft-3", resolved_commit: "INDETERMINATE", basis: "No repository configured" },
      reviewed: { value: true, basis: "Legacy review artifact says PASS", legs: [{ path: "reviews/intro.md", verdict: "PASS", candidate_sha: "intro-draft-3", artifact_type: "review" }], excluded: [] },
      folded: { value: "INDETERMINATE", basis: "No repository configured" }, adopted: { value: "NOT_APPLICABLE", basis: "Catalog project has no daemon-source deployment" } }],
    q5_park: p.id === "guide-south" ? [{ qitem_id: "packet-review-south", pickup_state: "parked", pickup_evidence: "Gate waits on human@guide", park_kind: "deliberate-with-wake", park_kind_basis: "Fired timer", wake_target: "wake-cover", age_minutes: 40, source: { qitem_id: "packet-review-south" } }] : [],
    q6_parallelism: { lanes_live: p.id === "guide-south" ? 1 : 0, lanes_possible: 2, idle_seats_with_capacity: { value: "INDETERMINATE", basis: "Activity oracle unavailable" },
      heavy_slot_holder: { value: null, basis: "No tagged row" }, df_margin: { available_kib: "INDETERMINATE", path: p.root, basis: "Cannot statfs in the twin" } },
    lifecycle_instances: [lifecycle(p)],
  }],
});

const sliceDetail = (p: (typeof PROJECTS)[number], mission: string) => ({
  name: "01-intro", missionId: mission, slicePath: `${p.missionsRoot}/${mission}/slices/01-intro`, displayName: "Slice 01 — Introduction", railItem: null, status: "done", rawStatus: "done",
  qitemIds: [], commitRefs: ["intro-draft-3"], lastActivityAt: later, readiness: readinessFor(p.id),
  workflowBinding: { instanceId: `wf-${p.id}`, workflowName: "guide-release", workflowVersion: "1", status: p.id === "guide-north" ? "failed" : "active", currentStepId: p.id === "guide-north" ? null : "review",
    currentFrontier: p.id === "guide-north" ? [] : ["packet-review-south"], hopCount: 2, createdAt: at, completedAt: null, additionalInstanceIds: [] },
  story: { events: [{ ts: at, phase: "draft", kind: "queue", actorSession: "writer@guide", qitemId: "packet-draft", summary: "Draft closed", detail: {} }], phaseDefinitions: [{ id: "draft", label: "Draft", role: "writer" }] },
  acceptance: { totalItems: 2, doneItems: 2, percentage: 100, items: [{ text: "Reads cleanly", done: true, source: { file: "PROGRESS.md", line: 2 }, doneVia: "checkbox" }, { text: "Links resolve", done: true, source: { file: "PROGRESS.md", line: 3 }, doneVia: "checkbox" }], closureCallout: null, currentStep: null },
  decisions: { rows: [] }, docs: { tree: [{ name: "SPEC.md", type: "file", size: 420, mtime: at, relPath: "SPEC.md" }, { name: "notes.md", type: "file", size: 80, mtime: at, relPath: "notes/notes.md" }] },
  tests: { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } },
  topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
});

// ------------------------------------------------------------- workflows

const failure = (instanceId: string, id: string, reason: string, failedAt: string) => ({
  occurrenceId: id, instanceId, failedPacketId: `packet-${id}`, stepId: "review", branchDrive: 1, hopCount: 2, hopsBaseline: 1, failureReason: reason,
  status: "unresolved", redrivePacketId: null as string | null, resumeDecision: null as string | null, failedAt, resolvedAt: null as string | null, targetedAction: "resume",
});
type TwinInstance = Record<string, unknown> & { instanceId: string; status: string; failureOccurrences: ReturnType<typeof failure>[] };
const baseInstance = (instanceId: string, status: string, over: Record<string, unknown> = {}): TwinInstance => ({
  instanceId, workflowName: "guide-release", workflowVersion: "1", createdBySession: "lead@guide", createdAt: at, status, currentFrontier: [], currentStepId: null,
  hopCount: 2, fallbackSynthesis: null, lastContinuationDecision: null, completedAt: null, version: 5, resumeCount: 0, hopsBaseline: 1,
  deadline: { state: "healthy", evidence: null }, boundRig: "guide-rig", lifecycleOperationKey: `instantiate-${instanceId}`, compiledInputDigest: "sha256:bound-1",
  lifecycleBinding: { identity: { project: instanceId.replace(/^wf-/, ""), mission: "launch", lifecycleProfile: "release" } },
  frontierPackets: [], failureOccurrences: [], boundaryObligations: [], unknowns: [], ...over,
});
const instances: Record<string, TwinInstance> = {
  "wf-guide-north": baseInstance("wf-guide-north", "failed", {
    failureOccurrences: [failure("wf-guide-north", "occ-north-1", "Phone render crashed", at), failure("wf-guide-north", "occ-north-2", "Link checker timed out", later)],
    unknowns: ["Successor activation is not bound"],
    boundaryObligations: [{ stepId: "draft", required: true, state: "closed", receiptState: "recorded", receipt: { evidenceRef: "chapters/intro.md", actorSession: "writer@guide", closedAt: at } },
      { stepId: "review", required: true, state: "open", receiptState: "missing", receipt: null }],
  }),
  "wf-guide-south": baseInstance("wf-guide-south", "active", { currentFrontier: ["packet-review-south"], currentStepId: "review" }),
  "wf-guide-old": baseInstance("wf-guide-old", "aborted", { completedAt: later, lastContinuationDecision: { action: "abort", actorSession: "lead@guide", reason: "Superseded by the second edition" } }),
};
const revisionStatus: Record<string, string> = { "wf-guide-north": "current", "wf-guide-south": "source-only", "wf-guide-old": "current" };
const operations: Record<string, unknown> = {};

function traceFor(id: string) {
  const instance = instances[id]!;
  return { instance, trail: [{ trailId: `trail-${id}-1`, instanceId: id, stepId: "draft", stepRole: "writer", closedAt: at, closureReason: "handoff", closureEvidence: { evidence_ref: "chapters/intro.md" }, actorSession: "writer@guide", nextQitemId: "packet-review", priorQitemId: "packet-draft" }],
    failures: instance.failureOccurrences, frontier: instance.frontierPackets, boundaryObligations: instance.boundaryObligations, unknowns: instance.unknowns };
}

function mutate(id: string, kind: string, body: Record<string, unknown>): TwinResponse {
  const instance = instances[id];
  if (!instance) return { body: { error: "instance_not_found", message: `No workflow ${id}` }, status: 404 };
  if (kind === "resume") {
    const occurrence = instance.failureOccurrences.find((o) => o.occurrenceId === body.occurrenceId);
    if (!occurrence || occurrence.status !== "unresolved") return { body: { error: "failure_occurrence_not_unresolved", message: `Occurrence ${String(body.occurrenceId)} is not unresolved` }, status: 409 };
    Object.assign(occurrence, { status: "resolved", redrivePacketId: `redrive-${occurrence.occurrenceId}`, resumeDecision: typeof body.decision === "string" ? body.decision : null, resolvedAt: new Date().toISOString(), targetedAction: "none" });
    const open = instance.failureOccurrences.some((o) => o.status === "unresolved");
    Object.assign(instance, { status: open ? "failed" : "active", resumeCount: (instance.resumeCount as number) + 1, version: (instance.version as number) + 1 });
    return { body: { instanceId: id, stepId: occurrence.stepId, newPacketId: occurrence.redrivePacketId, ownerSession: "editor@guide", resumeCount: instance.resumeCount, exceptionItemsClosed: 1 }, status: 200 };
  }
  if (kind === "abort") {
    if (instance.status === "completed" || instance.status === "aborted") return { body: { error: "instance_not_abortable", message: `Workflow ${id} is ${instance.status}` }, status: 409 };
    const closed = instance.currentFrontier as string[];
    Object.assign(instance, { status: "aborted", completedAt: new Date().toISOString(), currentFrontier: [], lastContinuationDecision: { action: "abort", actorSession: body.actorSession, reason: body.reason } });
    return { body: { instanceId: id, closedPacketIds: closed, status: "aborted" }, status: 200 };
  }
  if (kind === "revision") {
    const view = reconciliation(id, revisionStatus[id]);
    if (view.operationKey !== body.operationKey || body.expectedDigest !== view.proposedDigest || body.expectedVersion !== view.expectedVersion)
      return { body: { error: "lifecycle_revision_conflict", message: "The proposal changed; inspect it again." }, status: 409 };
    revisionStatus[id] = "current";
    const operation = { kind: "revision", receipt: { operationKey: body.operationKey, instanceId: id, expectedVersion: body.expectedVersion, compiledInputDigest: body.expectedDigest, actorSession: body.actorSession, reason: body.reason, at: new Date().toISOString() },
      instance: { ...instance, version: (instance.version as number) + 1, workflowVersion: "2" } };
    operations[body.operationKey as string] = operation;
    return { body: operation, status: 200 };
  }
  return { body: { error: "not_found" }, status: 404 };
}

// Connected-instance workflow library: the exact served entry for the twin
// instances' (guide-release, 1) tuple, plus a colon-bearing sibling pair whose
// opaque IDs show that the page selects by served name/version bytes.
const WORKFLOW_ENTRIES = [
  { id: "workflow:guide-release:1", kind: "workflow", name: "guide-release", version: "1", sourceType: "user_file", sourcePath: "/srv/specs/workflows/guide-release.yaml",
    relativePath: "workflows/guide-release.yaml", updatedAt: at, isBuiltIn: false, rolesCount: 2, stepsCount: 2, terminalTurnRule: "hot_potato", targetRig: null, status: "valid", errorMessage: null },
  { id: "workflow:@WyJyZWxlYXNlLW5vdGVzIiwiMToyIl0", kind: "workflow", name: "release-notes", version: "1:2", sourceType: "user_file", sourcePath: "/srv/specs/workflows/release-notes.yaml",
    relativePath: "workflows/release-notes.yaml", updatedAt: at, isBuiltIn: false, rolesCount: 1, stepsCount: 1, terminalTurnRule: "hot_potato", targetRig: null, status: "valid", errorMessage: null },
  { id: "workflow:release-notes:1:2", kind: "workflow", name: "release-notes:1", version: "2", sourceType: "user_file", sourcePath: "/srv/specs/workflows/release-notes-legacy.yaml",
    relativePath: "workflows/release-notes-legacy.yaml", updatedAt: at, isBuiltIn: false, rolesCount: 1, stepsCount: 1, terminalTurnRule: "hot_potato", targetRig: null, status: "valid", errorMessage: null },
];
function workflowReview(entry: (typeof WORKFLOW_ENTRIES)[number]) {
  const steps = entry.name === "guide-release"
    ? [{ stepId: "draft", role: "writer", objective: "Draft the introduction", next: ["review"] }, { stepId: "review", role: "editor", objective: "Review on a phone", next: [] }]
    : [{ stepId: `${entry.name}-step`, role: "writer", objective: "Write notes", next: [] }];
  return {
    kind: "workflow", libraryEntryId: entry.id, name: entry.name, version: entry.version, purpose: "Fictional twin workflow", targetRig: null, terminalTurnRule: entry.terminalTurnRule,
    rolesCount: entry.rolesCount, stepsCount: entry.stepsCount, isBuiltIn: false, sourcePath: entry.sourcePath, cachedAt: at,
    topology: {
      nodes: steps.map((s, i) => ({ stepId: s.stepId, role: s.role, objective: s.objective, preferredTarget: null, isEntry: i === 0, isTerminal: s.next.length === 0 })),
      edges: steps.flatMap((s) => s.next.map((to) => ({ fromStepId: s.stepId, toStepId: to, routingType: "direct" }))),
    },
    steps: steps.map((s) => ({ stepId: s.stepId, role: s.role, objective: s.objective, allowedExits: s.next.length ? ["handoff"] : ["done"],
      allowedNextSteps: s.next.map((to) => ({ stepId: to, role: steps.find((x) => x.stepId === to)!.role })) })),
  };
}

/** Body for a project/workflow route, or undefined if not one. */
export function projectWorkflowTwinBody(pathname: string, search: URLSearchParams, method = "GET", body: unknown = undefined): TwinResponse | undefined {
  if (pathname === "/api/scopes/projects") return { body: catalog, status: 200 };
  const selected = () => {
    const p = PROJECTS.find((x) => x.id === search.get("project"));
    if (!p || p.error) return { error: { body: { error: "project_unavailable", message: `Project ${search.get("project")} is not available` }, status: 409 } };
    if (p.root !== search.get("projectRoot")) return { error: { body: { error: "project_changed", message: `Project ${p.id} is catalogued at ${p.root}` }, status: 409 } };
    return { project: p };
  };
  if (pathname === "/api/scopes" && search.has("project")) { const s = selected(); return s.error ?? { body: scopes(s.project!), status: 200 }; }
  if (pathname === "/api/views/execution" && search.has("project")) { const s = selected(); return s.error ?? { body: execution(s.project!, search.get("mission") ?? "launch"), status: 200 }; }
  const slice = /^\/api\/slices\/01-intro(?:\/doc\/(.+))?$/.exec(pathname);
  if (slice && search.has("project")) {
    const s = selected();
    if (s.error) return s.error;
    if (slice[1]) {
      const rel = slice[1].split("/").map(decodeURIComponent).join("/");
      return { body: { relPath: rel, content: `# ${rel}\n\nFrom ${s.project!.root} (${s.project!.id}).` }, status: 200 };
    }
    return { body: sliceDetail(s.project!, search.get("mission") ?? "launch"), status: 200 };
  }
  if (/^\/api\/slices\/[^/]+\/proof-asset\//.test(pathname) && search.has("project")) return { body: { error: "proof_packet_not_found" }, status: 404 };

  // Connected-instance library only (no `host` envelope); other library
  // requests keep the twin's existing behaviour.
  if (pathname === "/api/specs/library" && search.get("kind") === "workflow" && !search.has("host")) return { body: WORKFLOW_ENTRIES, status: 200 };
  const review = /^\/api\/specs\/library\/(.+)\/review$/.exec(pathname);
  if (review && !search.has("host")) {
    const entry = WORKFLOW_ENTRIES.find((e) => e.id === decodeURIComponent(review[1]!));
    if (entry) return { body: workflowReview(entry), status: 200 };
  }
  if (pathname === "/api/workflow/list") return { body: Object.values(instances), status: 200 };
  const op = /^\/api\/workflow\/operations\/(.+)$/.exec(pathname);
  if (op) { const key = decodeURIComponent(op[1]!); return operations[key] ? { body: operations[key], status: 200 } : { body: { error: "operation_not_found" }, status: 404 }; }
  const wf = /^\/api\/workflow\/([^/]+)(?:\/(trace|revision|resume|abort))?$/.exec(pathname);
  if (wf && wf[1] !== "specs" && wf[1] !== "sse") {
    const id = decodeURIComponent(wf[1]!);
    if (method === "POST" && wf[2]) return mutate(id, wf[2], (body ?? {}) as Record<string, unknown>);
    if (!instances[id]) return { body: { error: "instance_not_found" }, status: 404 };
    if (wf[2] === "trace") return { body: traceFor(id), status: 200 };
    if (wf[2] === "revision") return { body: reconciliation(id, revisionStatus[id]), status: 200 };
    if (!wf[2]) return { body: instances[id], status: 200 };
  }
  return undefined;
}
