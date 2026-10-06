// TEST-ONLY fictional Library fixtures (library/provenance cohort). Answers
// the spec library (list, review, active lens), context-pack and agent-image
// lists/previews, plus two extra rigs with inventory, with DTOs that pass the
// real read guards. Nothing touches disk, a daemon or user files.
//
// Covers: same names across kinds, roots and versions; reserved characters in
// names and seat IDs; retired (409 legacy_spec_id) and moved (409
// source_changed) spec IDs; a rig that only DECLARES an agent spec versus a
// different rig whose seat is OBSERVED running it; a seat whose spec source
// was deleted after launch; a rig whose inventory fails; a context pack whose
// preview fails while its list row is current.
//
// Registration (operator-owned fetch-stub.ts), before the existing
// /api/rigs and library handlers:
//   const library = libraryTwinBody(pathname, search, method, body);
//   if (library) return json(library.body, library.status);
// and append `...libraryTwinRigs` to the /api/rigs/summary response.

export interface LibraryTwinResponse { body: unknown; status: number }

const AT = "2026-09-30T08:00:00.000Z";
export const LIBRARY_TWIN_HASH = "sha256:5eed0000000000000000000000000000000000000000000000000000000000a1";

const fileId = (n: number) => `specfile:v2:${n.toString(16).padStart(64, "0")}`;

export const LIBRARY_TWIN_IDS = {
  reviewerBuiltin: fileId(1),
  reviewerUser: fileId(2),
  reviewerV2: fileId(3),
  plannerReserved: fileId(4),
  percentAgent: fileId(5),
  pairRig: fileId(6),
  reviewerRig: fileId(7),
  legacy: "0123456789abcdef",
  moved: fileId(8),
  releaseV1: "workflow:release:1",
  releaseV2: "workflow:release:2",
} as const;

type Entry = Record<string, unknown> & { id: string; kind: "rig" | "agent" | "workflow"; name: string; version: string; sourcePath: string };

const entry = (id: string, kind: Entry["kind"], name: string, version: string, sourceType: "builtin" | "user_file", sourcePath: string, relativePath: string, extra: Record<string, unknown> = {}): Entry =>
  ({ id, kind, name, version, sourceType, sourcePath, relativePath, updatedAt: AT, ...extra });

export const libraryTwinEntries: Entry[] = [
  entry(LIBRARY_TWIN_IDS.reviewerBuiltin, "agent", "reviewer", "1", "builtin", "/fixture/builtin/agents/reviewer/agent.yaml", "agents/reviewer/agent.yaml"),
  entry(LIBRARY_TWIN_IDS.reviewerUser, "agent", "reviewer", "1", "user_file", "/fixture/user/agents/reviewer/agent.yaml", "agents/reviewer/agent.yaml"),
  entry(LIBRARY_TWIN_IDS.reviewerV2, "agent", "reviewer", "2", "user_file", "/fixture/user/agents/reviewer-v2/agent.yaml", "agents/reviewer-v2/agent.yaml"),
  entry(LIBRARY_TWIN_IDS.plannerReserved, "agent", "planner: alpha/beta 1.0", "1.0", "user_file", "/fixture/user/agents/planner/agent.yaml", "agents/planner/agent.yaml"),
  entry(LIBRARY_TWIN_IDS.percentAgent, "agent", "100%", "1", "user_file", "/fixture/user/agents/percent/agent.yaml", "agents/percent/agent.yaml"),
  entry(LIBRARY_TWIN_IDS.pairRig, "rig", "pair", "1", "user_file", "/fixture/user/rig-pair.yaml", "rig-pair.yaml", { summary: "Declares the user reviewer spec." }),
  entry(LIBRARY_TWIN_IDS.reviewerRig, "rig", "reviewer", "1", "user_file", "/fixture/user/rig-reviewer.yaml", "rig-reviewer.yaml"),
  entry(LIBRARY_TWIN_IDS.releaseV1, "workflow", "release", "1", "builtin", "/fixture/builtin/workflows/release.yaml", "release.yaml", { isBuiltIn: true, rolesCount: 1, stepsCount: 1, terminalTurnRule: "hot_potato", targetRig: null, status: "valid" }),
  entry(LIBRARY_TWIN_IDS.releaseV2, "workflow", "release", "2", "user_file", "/fixture/user/workflows/release.yaml", "release.yaml", { isBuiltIn: false, rolesCount: 1, stepsCount: 1, terminalTurnRule: "hot_potato", targetRig: null, status: "valid" }),
];

const agentReview = (e: Entry) => ({
  sourceState: "library_item", kind: "agent", name: e.name, version: e.version, description: `Fictional ${e.name} agent.`,
  profiles: [{ name: "default" }], resources: { skills: ["fixture-skill"], guidance: ["guide.md"], plugins: ["unknown-plugin"], subagents: [] },
  startup: { files: [], actions: [] }, raw: `name: ${JSON.stringify(e.name)}\nversion: ${JSON.stringify(e.version)}\n`,
  libraryEntryId: e.id, sourcePath: e.sourcePath,
});

const rigReview = (e: Entry, members: Array<{ id: string; agentRef: string }>) => ({
  sourceState: "library_item", kind: "rig", name: e.name, version: e.version, summary: e.summary, format: "pod_aware",
  pods: [{ id: "dev", label: "Dev", members: members.map((m) => ({ ...m, runtime: "claude-code", profile: "default" })), edges: [] }],
  edges: [], graph: { nodes: [], edges: [] }, raw: `name: ${e.name}\n`, libraryEntryId: e.id, sourcePath: e.sourcePath,
});

const workflowReview = (e: Entry) => ({
  kind: "workflow", libraryEntryId: e.id, name: e.name, version: e.version, purpose: `Fictional release v${e.version}.`, targetRig: null,
  terminalTurnRule: "hot_potato", rolesCount: 1, stepsCount: 1, isBuiltIn: e.sourceType === "builtin", sourcePath: e.sourcePath, cachedAt: AT,
  topology: { nodes: [{ stepId: "ship", role: "worker", objective: "Ship", preferredTarget: null, isEntry: true, isTerminal: true }], edges: [] },
  steps: [{ stepId: "ship", role: "worker", objective: "Ship", allowedExits: ["done"], allowedNextSteps: [] }],
});

export function libraryTwinReview(id: string): LibraryTwinResponse {
  if (id === LIBRARY_TWIN_IDS.legacy) return { status: 409, body: { code: "legacy_spec_id", error: "This legacy spec ID does not identify an exact source. Reselect the spec from the current library." } };
  if (id === LIBRARY_TWIN_IDS.moved) return { status: 409, body: { code: "source_changed", error: "This spec source address changed. Refresh the library and reselect the exact source." } };
  const e = libraryTwinEntries.find((candidate) => candidate.id === id);
  if (!e) return { status: 404, body: { error: `Spec '${id}' not found in library` } };
  if (e.kind === "agent") return { status: 200, body: agentReview(e) };
  if (e.kind === "workflow") return { status: 200, body: workflowReview(e) };
  if (e.id === LIBRARY_TWIN_IDS.pairRig) return { status: 200, body: rigReview(e, [{ id: "rev", agentRef: "local:agents/reviewer" }, { id: "ext", agentRef: "registry:acme/reviewer@3" }]) };
  return { status: 200, body: rigReview(e, [{ id: "solo", agentRef: "local:agents/missing" }]) };
}

// --- Rigs: one with an observed consumer, one whose inventory read fails.

export const libraryTwinRigs = [
  { id: "rig-observer", name: "observer-rig", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null },
  { id: "rig-unreadable", name: "unreadable-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
];

const seat = (logicalId: string, spec: { name: string; version: string; hash: string }, lifecycleState: string) => ({
  rigId: "rig-observer", rigName: "observer-rig", logicalId, podId: "dev", podNamespace: "dev", canonicalSessionName: `${logicalId}@observer-rig`,
  nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  tmuxAttachCommand: null, resumeCommand: null, latestError: null, agentRef: "local:agents/reviewer", profile: "default",
  resolvedSpecName: spec.name, resolvedSpecVersion: spec.version, resolvedSpecHash: spec.hash, lifecycleState,
});

export const libraryTwinInventory = [
  seat("dev.rev/1%", { name: "reviewer", version: "1", hash: LIBRARY_TWIN_HASH }, "running"),
  seat("dev.ghost", { name: "ghost-spec", version: "1", hash: "sha256:dead" }, "detached"),
];

// --- Context packs and agent images (connected instance).

export const libraryTwinContextPacks = [
  { id: "context-pack:fixture-brief", kind: "context-pack", name: "fixture-brief", version: "1", purpose: "Fictional brief.", sourceType: "workspace",
    sourcePath: "/fixture/user/context-packs/fixture-brief", relativePath: "fixture-brief", updatedAt: AT, manifestEstimatedTokens: null, derivedEstimatedTokens: 40,
    files: [{ path: "brief.md", role: "brief", summary: null, absolutePath: "/fixture/user/context-packs/fixture-brief/brief.md", bytes: 120, estimatedTokens: 30 }] },
];

const activeLens: { value: { specName: string; specVersion: string; activatedAt: string } | null } = { value: null };

export function libraryTwinBody(pathname: string, search: URLSearchParams, method = "GET", body?: unknown): LibraryTwinResponse | undefined {
  if (pathname === "/api/specs/library/active-lens") {
    if (method === "POST") {
      const input = (typeof body === "string" ? JSON.parse(body) : body) as { specName: string; specVersion: string };
      activeLens.value = { specName: input.specName, specVersion: input.specVersion, activatedAt: AT };
      return { status: 200, body: { activeLens: activeLens.value } };
    }
    if (method === "DELETE") { activeLens.value = null; return { status: 200, body: { activeLens: null } }; }
    return { status: 200, body: { activeLens: activeLens.value } };
  }
  if (pathname === "/api/specs/library") {
    const kind = search.get("kind");
    return { status: 200, body: kind ? libraryTwinEntries.filter((e) => e.kind === kind) : libraryTwinEntries };
  }
  const review = /^\/api\/specs\/library\/([^/]+)\/review$/.exec(pathname);
  if (review) return libraryTwinReview(decodeURIComponent(review[1]!));
  if (pathname === "/api/rigs/rig-observer/nodes") return { status: 200, body: libraryTwinInventory };
  if (pathname === "/api/rigs/rig-unreadable/nodes") return { status: 503, body: { error: "inventory_unavailable" } };
  if (pathname === "/api/context-packs/library") return { status: 200, body: libraryTwinContextPacks };
  if (pathname === "/api/context-packs/library/by-ref/preview") return { status: 503, body: { error: "preview_unavailable" } };
  return undefined;
}

/** Test reset for the in-memory active lens. */
export function resetLibraryTwin() { activeLens.value = null; }
