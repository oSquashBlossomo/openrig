// Spatial topology model — pure parsing, scoping, status, search and layout
// for the topology "3D" view-mode.
//
// This module deliberately imports nothing from three.js: it turns the
// daemon's /api/rigs/:id/graph payloads into a host-scoped, validated model
// plus deterministic world-space geometry (plain numbers). The renderer
// (components/topology/spatial/SpatialRenderer.tsx) is the only three.js
// consumer, and it is lazy-loaded, so this file stays in the light chunk and
// is fully unit-testable without a GPU.
//
// Identity rules (load-bearing):
//   - Every key is scoped by selected host AND rig. Two rigs may reuse a
//     graph node id; two hosts may reuse a rig id. Keys never derive from
//     display names.
//   - Pod membership follows the agent's `parentId` pointing at a pod node in
//     the SAME graph (the daemon emits `parentId: "pod-<podId>"`). A pod's
//     identity for navigation is its namespace metadata (`podNamespace`),
//     falling back to `podId`, then the pod node id.
//   - Relationships are kept only when both endpoints are agents in the same
//     parsed rig; everything else is counted as an issue, never drawn.
//   - Malformed entries degrade to a partial model with issues; nothing here
//     throws on daemon data, and no layout value can be NaN/Infinity.

import type {
  AgentActivitySummary,
  CurrentQitemSummary,
  SeatIdentityVerdictSummary,
} from "../hooks/useNodeInventory.js";
import {
  getActivityLabel,
  getActivityStateWithSource,
  getTimeInState,
  identityVerdictDownranksRunning,
  isActivityStale,
  type ActivityState,
} from "./activity-visuals.js";
import { displayAgentName } from "./display-name.js";

// ---------------------------------------------------------------------------
// Scope + keys
// ---------------------------------------------------------------------------

export type SpatialScope =
  | { kind: "host" }
  | { kind: "rig"; rigId: string }
  | { kind: "pod"; rigId: string; podName: string };

/** Upper bound on per-rig graph fetches for the host scope. Keeps the 3D tab's
 *  network + parse work predictable on large fleets; rigs past the cap are
 *  reported, not silently dropped. */
export const MAX_SPATIAL_RIGS = 24;

export function spatialScopeKey(scope: SpatialScope): string {
  if (scope.kind === "host") return "host";
  if (scope.kind === "rig") return `rig/${encodeURIComponent(scope.rigId)}`;
  return `pod/${encodeURIComponent(scope.rigId)}/${encodeURIComponent(scope.podName)}`;
}

export type SpatialEntityKind = "rig" | "pod" | "agent" | "edge";

export function spatialKey(hostId: string, rigId: string, kind: SpatialEntityKind, id: string): string {
  return `${encodeURIComponent(hostId)}/${encodeURIComponent(rigId)}/${kind}/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

export type SpatialIssueKind =
  | "malformed-graph"
  | "malformed-node"
  | "duplicate-node"
  | "orphan-parent"
  | "malformed-edge"
  | "dangling-edge"
  | "self-edge"
  | "duplicate-edge";

export interface SpatialIssue {
  rigId: string;
  kind: SpatialIssueKind;
  detail: string;
}

export interface SpatialAgent {
  key: string;
  hostId: string;
  rigId: string;
  rigName: string;
  /** Rig-local graph node id (as emitted by the daemon). */
  nodeId: string;
  /** Null when the payload omitted it — detail navigation is then disabled. */
  logicalId: string | null;
  displayName: string;
  podKey: string | null;
  podNamespace: string | null;
  role: string | null;
  runtime: string | null;
  model: string | null;
  nodeKind: "agent" | "infrastructure";
  canonicalSessionName: string | null;
  sessionStatus: string | null;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  agentActivity: AgentActivitySummary | null;
  terminalActive: boolean | null;
  identityVerdict: SeatIdentityVerdictSummary | null;
  hasAssignedWork: boolean;
  pendingWorkCount: number;
  currentQitems: CurrentQitemSummary[];
  contextUsedPercentage: number | null;
  contextFresh: boolean;
}

export interface SpatialPod {
  key: string;
  rigId: string;
  nodeId: string;
  /** Navigation identity (`/topology/pod/$rigId/$podName`). */
  namespace: string;
  /** Daemon pod id when present; used only as a secondary match key. */
  podId: string | null;
  label: string;
  agentKeys: string[];
}

export interface SpatialEdge {
  key: string;
  rigId: string;
  sourceKey: string;
  targetKey: string;
  kind: string;
  crossPod: boolean;
}

export interface SpatialRig {
  key: string;
  rigId: string;
  rigName: string;
  /** Node count reported by the rig summary (may differ from the graph). */
  summaryNodeCount: number | null;
  pods: SpatialPod[];
  /** Agents with no pod (rendered on the rig deck). */
  looseAgentKeys: string[];
  agents: SpatialAgent[];
  edges: SpatialEdge[];
  issues: SpatialIssue[];
}

export interface SpatialModel {
  hostId: string;
  rigs: SpatialRig[];
  agentsByKey: ReadonlyMap<string, SpatialAgent>;
  podsByKey: ReadonlyMap<string, SpatialPod>;
  edges: SpatialEdge[];
  issues: SpatialIssue[];
  counts: { rigs: number; pods: number; agents: number; edges: number };
}

export interface SpatialRigInput {
  rigId: string;
  rigName: string;
  summaryNodeCount?: number | null;
  /** Raw /api/rigs/:id/graph JSON. Treated as untrusted. */
  graph: unknown;
}

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** JSON strings may contain lone UTF-16 surrogates, which URI key encoding
 * rejects. Check identity bytes without repairing or aliasing the input. */
function hasWellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value: unknown): number {
  const n = finiteNumber(value);
  return n === null || n < 0 ? 0 : Math.floor(n);
}

const ACTIVITY_STATES = new Set(["running", "needs_input", "idle", "unknown"]);
const STARTUP_STATES = new Set(["pending", "ready", "attention_required", "failed"]);
const IDENTITY_VERDICTS = new Set(["verified", "mismatch", "pane_missing", "tmux_unavailable"]);

function readActivity(value: unknown): AgentActivitySummary | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (typeof state !== "string" || !ACTIVITY_STATES.has(state)) return null;
  return {
    state: state as AgentActivitySummary["state"],
    reason: typeof value.reason === "string" ? value.reason : "",
    evidenceSource: typeof value.evidenceSource === "string" ? value.evidenceSource : "unknown",
    sampledAt: typeof value.sampledAt === "string" ? value.sampledAt : "",
    eventAt: typeof value.eventAt === "string" ? value.eventAt : null,
    evidence: typeof value.evidence === "string" ? value.evidence : null,
    staleness: finiteNumber(value.staleness),
    stale: value.stale === true,
    fallback: value.fallback === true,
  };
}

function readIdentity(value: unknown): SeatIdentityVerdictSummary | null {
  if (!isRecord(value)) return null;
  const verdict = value.verdict;
  if (typeof verdict !== "string" || !IDENTITY_VERDICTS.has(verdict)) return null;
  return {
    verdict: verdict as SeatIdentityVerdictSummary["verdict"],
    evidenceSource: str(value.evidenceSource),
    reason: str(value.reason),
    sessionName: str(value.sessionName),
    observedAt: typeof value.observedAt === "string" ? value.observedAt : undefined,
  };
}

function readQitems(value: unknown): CurrentQitemSummary[] {
  if (!Array.isArray(value)) return [];
  const out: CurrentQitemSummary[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const qitemId = str(item.qitemId);
    if (!qitemId) continue;
    out.push({
      qitemId,
      bodyExcerpt: typeof item.bodyExcerpt === "string" ? item.bodyExcerpt : "",
      tier: str(item.tier),
    });
  }
  return out;
}

function isPodType(type: unknown): boolean {
  return type === "podGroup" || type === "group";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseSpatialRig(hostId: string, input: SpatialRigInput): SpatialRig {
  const { rigId, rigName } = input;
  const rigKey = spatialKey(hostId, rigId, "rig", rigId);
  const issues: SpatialIssue[] = [];
  const summaryNodeCount = finiteNumber(input.summaryNodeCount ?? null);

  const graph = input.graph;
  const rawNodes = isRecord(graph) && Array.isArray(graph.nodes) ? graph.nodes : null;
  const rawEdges = isRecord(graph) && Array.isArray(graph.edges) ? graph.edges : [];
  if (rawNodes === null) {
    issues.push({ rigId, kind: "malformed-graph", detail: "graph payload has no node list" });
  }

  const seenIds = new Set<string>();
  const podNodes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const agentNodes: Array<{ id: string; parentId: string | null; data: Record<string, unknown> }> = [];

  for (const raw of rawNodes ?? []) {
    if (!isRecord(raw)) {
      issues.push({ rigId, kind: "malformed-node", detail: "node entry is not an object" });
      continue;
    }
    const id = str(raw.id);
    if (!id) {
      issues.push({ rigId, kind: "malformed-node", detail: "node entry has no id" });
      continue;
    }
    if (!hasWellFormedUnicode(id)) {
      issues.push({ rigId, kind: "malformed-node", detail: "node id contains malformed UTF-16" });
      continue;
    }
    if (seenIds.has(id)) {
      issues.push({ rigId, kind: "duplicate-node", detail: `duplicate node id ${id}` });
      continue;
    }
    seenIds.add(id);
    const data = isRecord(raw.data) ? raw.data : {};
    if (isPodType(raw.type)) podNodes.push({ id, data });
    else agentNodes.push({ id, parentId: str(raw.parentId), data });
  }

  const pods: SpatialPod[] = podNodes.map(({ id, data }) => {
    const namespace = str(data.podNamespace) ?? str(data.podId) ?? id;
    return {
      key: spatialKey(hostId, rigId, "pod", id),
      rigId,
      nodeId: id,
      namespace,
      podId: str(data.podId),
      label: str(data.podLabel) ?? namespace,
      agentKeys: [],
    };
  });
  const podByNodeId = new Map(pods.map((pod) => [pod.nodeId, pod]));
  const podByDaemonPodId = new Map<string, SpatialPod>();
  for (const pod of pods) {
    if (pod.podId && !podByDaemonPodId.has(pod.podId)) podByDaemonPodId.set(pod.podId, pod);
  }

  const agents: SpatialAgent[] = [];
  const looseAgentKeys: string[] = [];
  const agentByNodeId = new Map<string, SpatialAgent>();
  const podOfAgent = new Map<string, SpatialPod>();

  for (const { id, parentId, data } of agentNodes) {
    let pod: SpatialPod | undefined;
    if (parentId !== null) {
      pod = podByNodeId.get(parentId);
      if (!pod) {
        issues.push({ rigId, kind: "orphan-parent", detail: `node ${id} references missing pod ${parentId}` });
      }
    } else {
      // Secondary rule: an explicit daemon pod id that matches a pod node's
      // pod id. Never infer membership from names.
      const podId = str(data.podId);
      if (podId) pod = podByDaemonPodId.get(podId);
    }

    const logicalId = str(data.logicalId);
    const startup = data.startupStatus;
    const key = spatialKey(hostId, rigId, "agent", id);
    const agent: SpatialAgent = {
      key,
      hostId,
      rigId,
      rigName,
      nodeId: id,
      logicalId,
      displayName: logicalId ? displayAgentName(logicalId) : id,
      podKey: pod?.key ?? null,
      podNamespace: pod?.namespace ?? null,
      role: str(data.role),
      runtime: str(data.runtime),
      model: str(data.model),
      nodeKind: data.nodeKind === "infrastructure" || data.runtime === "terminal" ? "infrastructure" : "agent",
      canonicalSessionName: str(data.canonicalSessionName),
      sessionStatus: str(data.status),
      startupStatus: typeof startup === "string" && STARTUP_STATES.has(startup)
        ? (startup as SpatialAgent["startupStatus"])
        : null,
      agentActivity: readActivity(data.agentActivity),
      terminalActive: typeof data.terminalActive === "boolean" ? data.terminalActive : null,
      identityVerdict: readIdentity(data.identityVerdict),
      hasAssignedWork: data.hasAssignedWork === true,
      pendingWorkCount: nonNegativeInt(data.pendingWorkCount),
      currentQitems: readQitems(data.currentQitems),
      contextUsedPercentage: finiteNumber(data.contextUsedPercentage),
      contextFresh: data.contextFresh === true,
    };
    agents.push(agent);
    agentByNodeId.set(id, agent);
    if (pod) {
      pod.agentKeys.push(key);
      podOfAgent.set(key, pod);
    } else {
      looseAgentKeys.push(key);
    }
  }

  const edges: SpatialEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  rawEdges.forEach((raw, index) => {
    if (!isRecord(raw)) {
      issues.push({ rigId, kind: "malformed-edge", detail: "edge entry is not an object" });
      return;
    }
    const source = str(raw.source);
    const target = str(raw.target);
    if (!source || !target) {
      issues.push({ rigId, kind: "malformed-edge", detail: "edge entry is missing an endpoint" });
      return;
    }
    const id = str(raw.id) ?? `${source}->${target}#${index}`;
    if (![source, target, id].every(hasWellFormedUnicode)) {
      issues.push({ rigId, kind: "malformed-edge", detail: "edge identity contains malformed UTF-16" });
      return;
    }
    const from = agentByNodeId.get(source);
    const to = agentByNodeId.get(target);
    if (!from || !to) {
      issues.push({ rigId, kind: "dangling-edge", detail: `edge ${source} → ${target} has no agent endpoint` });
      return;
    }
    if (from === to) {
      issues.push({ rigId, kind: "self-edge", detail: `edge on ${source} points at itself` });
      return;
    }
    const key = spatialKey(hostId, rigId, "edge", id);
    if (seenEdgeKeys.has(key)) {
      issues.push({ rigId, kind: "duplicate-edge", detail: `duplicate edge id ${id}` });
      return;
    }
    seenEdgeKeys.add(key);
    const data = isRecord(raw.data) ? raw.data : {};
    const kind = str(data.kind) ?? str(raw.label) ?? "relates";
    edges.push({
      key,
      rigId,
      sourceKey: from.key,
      targetKey: to.key,
      kind,
      crossPod: (podOfAgent.get(from.key)?.key ?? null) !== (podOfAgent.get(to.key)?.key ?? null),
    });
  });

  return { key: rigKey, rigId, rigName, summaryNodeCount, pods, looseAgentKeys, agents, edges, issues };
}

export function buildSpatialModel(hostId: string, rigs: SpatialRig[]): SpatialModel {
  const agentsByKey = new Map<string, SpatialAgent>();
  const podsByKey = new Map<string, SpatialPod>();
  const edges: SpatialEdge[] = [];
  const issues: SpatialIssue[] = [];
  for (const rig of rigs) {
    for (const agent of rig.agents) agentsByKey.set(agent.key, agent);
    for (const pod of rig.pods) podsByKey.set(pod.key, pod);
    edges.push(...rig.edges);
    issues.push(...rig.issues);
  }
  return {
    hostId,
    rigs,
    agentsByKey,
    podsByKey,
    edges,
    issues,
    counts: { rigs: rigs.length, pods: podsByKey.size, agents: agentsByKey.size, edges: edges.length },
  };
}

/** Narrow a parsed rig to one pod (pod scope). Returns null when the rig has
 *  no pod with that namespace (or daemon pod id). Relationships are kept only
 *  when both endpoints remain in scope. */
export function scopeRigToPod(rig: SpatialRig, podName: string): SpatialRig | null {
  const pod = rig.pods.find((p) => p.namespace === podName) ?? rig.pods.find((p) => p.podId === podName);
  if (!pod) return null;
  const keep = new Set(pod.agentKeys);
  return {
    ...rig,
    pods: [pod],
    looseAgentKeys: [],
    agents: rig.agents.filter((a) => keep.has(a.key)),
    edges: rig.edges.filter((e) => keep.has(e.sourceKey) && keep.has(e.targetKey)),
  };
}

// ---------------------------------------------------------------------------
// Status — reuses the shared activity/identity/staleness helpers so the 3D
// view agrees with graph + table. An old sample is never presented as live.
// ---------------------------------------------------------------------------

export type SpatialTone = "active" | "needs_input" | "blocked" | "idle" | "unknown" | "offline";

export interface SpatialSeatStatus {
  tone: SpatialTone;
  /** Short state label, e.g. "running", "last sampled running", "stopped". */
  label: string;
  /** Where the state came from, in operator words. */
  evidence: string;
  /** Activity evidence is current (hook / terminal poll / pane heuristic). */
  live: boolean;
  /** The activity sample is old — rendered muted and labeled as such. */
  stale: boolean;
  /** Age of the activity sample, e.g. "4m", when known. */
  sampleAge: string | null;
  /** Startup / identity problems the operator should see first. */
  problems: string[];
}

const TONE_BY_ACTIVITY: Record<ActivityState, SpatialTone> = {
  running: "active",
  needs_input: "needs_input",
  idle: "idle",
  unknown: "unknown",
};

const EVIDENCE_LABEL = {
  hook: "runtime hook",
  terminal_activity: "terminal output poll",
  pane_heuristic: "pane heuristic",
} as const;

export function deriveSeatStatus(agent: SpatialAgent): SpatialSeatStatus {
  const problems: string[] = [];
  const identityProblem = identityVerdictDownranksRunning(agent.identityVerdict);
  if (identityProblem) {
    const what = agent.identityVerdict?.verdict === "pane_missing"
      ? "Pane missing — the registered tmux pane is gone"
      : "Identity mismatch — the pane process is not the registered seat";
    problems.push(agent.identityVerdict?.reason ? `${what} (${agent.identityVerdict.reason})` : what);
  }
  if (agent.startupStatus === "failed") problems.push("Startup failed");
  else if (agent.startupStatus === "attention_required" && !identityProblem) problems.push("Startup needs attention");

  const result = getActivityStateWithSource(agent.agentActivity, agent.terminalActive, agent.identityVerdict);
  // eventAt describes how long the state has lasted, not the age of the
  // probe. A terminal-output boolean has no timestamp in this graph payload;
  // it must not borrow a runtime-hook/pane sample's age.
  const sampleAge = result.source !== "terminal_activity" && agent.agentActivity
    ? getTimeInState({ ...agent.agentActivity, eventAt: null })?.label ?? null
    : null;
  const sampleStale = agent.agentActivity ? (agent.agentActivity.stale === true || isActivityStale(agent.agentActivity)) : false;

  // Session not running: whatever an old sample says, the seat is not live.
  if (agent.sessionStatus !== null && agent.sessionStatus !== "running") {
    return {
      tone: agent.startupStatus === "failed" ? "blocked" : "offline",
      label: agent.sessionStatus,
      evidence: "session record",
      live: false,
      stale: false,
      sampleAge,
      problems,
    };
  }

  if (agent.startupStatus === "failed") {
    return { tone: "blocked", label: "startup failed", evidence: "startup status", live: false, stale: sampleStale, sampleAge, problems };
  }
  if (identityProblem) {
    return {
      tone: "needs_input",
      label: agent.identityVerdict?.verdict === "pane_missing" ? "pane missing" : "identity mismatch",
      evidence: "liveness identity check",
      live: false,
      stale: false,
      sampleAge,
      problems,
    };
  }

  if (result.source === "none") {
    if (result.state === "unknown") {
      return {
        tone: "unknown",
        label: agent.startupStatus === "pending" ? "starting" : "no activity signal",
        evidence: agent.sessionStatus === null ? "no session" : "no signal",
        live: false,
        stale: false,
        sampleAge,
        problems,
      };
    }
    // A stale / fallback sample: show what it said, never as current.
    return {
      tone: TONE_BY_ACTIVITY[result.state],
      label: `last sampled ${getActivityLabel(result.state)}`,
      evidence: "stale sample",
      live: false,
      stale: true,
      sampleAge,
      problems,
    };
  }

  const stale = result.source !== "terminal_activity" && sampleStale;
  return {
    tone: agent.startupStatus === "attention_required" ? "needs_input" : TONE_BY_ACTIVITY[result.state],
    label: stale ? `last sampled ${getActivityLabel(result.state)}` : getActivityLabel(result.state),
    evidence: EVIDENCE_LABEL[result.source],
    live: !stale,
    stale,
    sampleAge,
    problems,
  };
}

export interface SpatialStatusTally {
  active: number;
  needs_input: number;
  blocked: number;
  idle: number;
  unknown: number;
  offline: number;
  stale: number;
  problems: number;
}

export function tallySeatStatuses(agents: Iterable<SpatialAgent>): SpatialStatusTally {
  const tally: SpatialStatusTally = { active: 0, needs_input: 0, blocked: 0, idle: 0, unknown: 0, offline: 0, stale: 0, problems: 0 };
  for (const agent of agents) {
    const status = deriveSeatStatus(agent);
    tally[status.tone]++;
    if (status.stale) tally.stale++;
    if (status.problems.length > 0) tally.problems++;
  }
  return tally;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function normalizeSpatialQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/** Every token must appear in at least one searchable field of the seat. */
export function agentMatchesQuery(agent: SpatialAgent, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    agent.logicalId,
    agent.displayName,
    agent.canonicalSessionName,
    agent.runtime,
    agent.model,
    agent.role,
    agent.podNamespace,
    agent.rigName,
    agent.nodeId,
  ]
    .filter((v): v is string => typeof v === "string")
    .join("\u0000")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

// ---------------------------------------------------------------------------
// Layout — deterministic world-space geometry. Y is up; rigs sit on the
// ground (deck top at y=0), pods hover as platforms above their rig, agents
// stand on their platform (or on the rig deck when unpodded). Height encodes
// containment depth, not decoration.
// ---------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];

export interface SpatialRect {
  /** Min corner on the ground plane. */
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface LaidOutRig extends SpatialRect {
  key: string;
}

export interface LaidOutPod extends SpatialRect {
  key: string;
  rigKey: string;
  /** Platform top surface height. */
  top: number;
}

export interface LaidOutAgent {
  key: string;
  position: Vec3;
}

export interface LaidOutEdge {
  key: string;
  sourceKey: string;
  targetKey: string;
  from: Vec3;
  control: Vec3;
  to: Vec3;
}

export interface SpatialBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  radius: number;
}

export interface SpatialLayout {
  rigs: LaidOutRig[];
  pods: LaidOutPod[];
  agents: LaidOutAgent[];
  edges: LaidOutEdge[];
  bounds: SpatialBounds;
}

export const SPATIAL_LAYOUT = {
  agentSpacing: 4.4,
  podPadding: 2.2,
  podHeader: 1.8,
  podTop: 3.2,
  podThickness: 0.45,
  agentLift: 0.55,
  rigPadding: 3,
  rigHeader: 3.4,
  rigGap: 9,
  deckThickness: 0.6,
  blockGap: 2.8,
} as const;

interface Block {
  kind: "pod" | "loose";
  podKey: string | null;
  agentKeys: string[];
  w: number;
  d: number;
}

function gridDims(count: number): { cols: number; rows: number } {
  const n = Math.max(1, count);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

function blockFor(kind: Block["kind"], podKey: string | null, agentKeys: string[]): Block {
  const L = SPATIAL_LAYOUT;
  const { cols, rows } = gridDims(agentKeys.length);
  return {
    kind,
    podKey,
    agentKeys,
    w: cols * L.agentSpacing + L.podPadding * 2,
    d: rows * L.agentSpacing + L.podPadding * 2 + L.podHeader,
  };
}

/** Shelf-pack rectangles left→right, wrapping at maxRowWidth. Deterministic. */
function shelfPack<T extends { w: number; d: number }>(
  items: T[],
  maxRowWidth: number,
  gap: number,
): { placed: Array<T & { x: number; z: number }>; width: number; depth: number } {
  const placed: Array<T & { x: number; z: number }> = [];
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  let width = 0;
  for (const item of items) {
    if (x > 0 && x + item.w > maxRowWidth) {
      x = 0;
      z += rowDepth + gap;
      rowDepth = 0;
    }
    placed.push({ ...item, x, z });
    x += item.w + gap;
    rowDepth = Math.max(rowDepth, item.d);
    width = Math.max(width, x - gap);
  }
  return { placed, width: Math.max(0, width), depth: items.length > 0 ? z + rowDepth : 0 };
}

function safe(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

export function layoutSpatialModel(model: SpatialModel): SpatialLayout {
  const L = SPATIAL_LAYOUT;
  const agentsPos = new Map<string, Vec3>();
  const rigBoxes: Array<{ key: string; w: number; d: number; blocks: Array<Block & { x: number; z: number }> }> = [];

  for (const rig of model.rigs) {
    const blocks: Block[] = rig.pods.map((pod) => blockFor("pod", pod.key, pod.agentKeys));
    if (rig.looseAgentKeys.length > 0) blocks.push(blockFor("loose", null, rig.looseAgentKeys));
    const area = blocks.reduce((sum, b) => sum + b.w * b.d, 0);
    const widest = blocks.reduce((m, b) => Math.max(m, b.w), 0);
    const maxRow = Math.max(widest, Math.sqrt(Math.max(area, 1)) * 1.45);
    const packed = shelfPack(blocks, maxRow, L.blockGap);
    const w = Math.max(18, packed.width + L.rigPadding * 2);
    const d = Math.max(12, packed.depth + L.rigPadding * 2 + L.rigHeader);
    rigBoxes.push({ key: rig.key, w, d, blocks: packed.placed });
  }

  const totalArea = rigBoxes.reduce((sum, r) => sum + r.w * r.d, 0);
  const widestRig = rigBoxes.reduce((m, r) => Math.max(m, r.w), 0);
  const outer = shelfPack(rigBoxes, Math.max(widestRig, Math.sqrt(Math.max(totalArea, 1)) * 1.6), L.rigGap);
  const offsetX = -outer.width / 2;
  const offsetZ = -outer.depth / 2;

  const rigs: LaidOutRig[] = [];
  const pods: LaidOutPod[] = [];
  for (const rigBox of outer.placed) {
    const rx = safe(rigBox.x + offsetX);
    const rz = safe(rigBox.z + offsetZ);
    rigs.push({ key: rigBox.key, x: rx, z: rz, w: rigBox.w, d: rigBox.d });
    for (const block of rigBox.blocks) {
      const bx = rx + L.rigPadding + block.x;
      const bz = rz + L.rigPadding + L.rigHeader + block.z;
      const surface = block.kind === "pod" ? L.podTop : 0;
      if (block.kind === "pod" && block.podKey) {
        pods.push({ key: block.podKey, rigKey: rigBox.key, x: bx, z: bz, w: block.w, d: block.d, top: L.podTop });
      }
      const { cols } = gridDims(block.agentKeys.length);
      block.agentKeys.forEach((agentKey, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        agentsPos.set(agentKey, [
          safe(bx + L.podPadding + (col + 0.5) * L.agentSpacing),
          surface + L.agentLift,
          safe(bz + L.podHeader + L.podPadding + (row + 0.5) * L.agentSpacing),
        ]);
      });
    }
  }

  const agents: LaidOutAgent[] = [];
  for (const [key, position] of agentsPos) agents.push({ key, position });

  const edges: LaidOutEdge[] = [];
  for (const edge of model.edges) {
    const from = agentsPos.get(edge.sourceKey);
    const to = agentsPos.get(edge.targetKey);
    if (!from || !to) continue;
    const dx = to[0] - from[0];
    const dz = to[2] - from[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    const lift = Math.min(14, Math.max(1.6, dist * 0.32)) + (edge.crossPod ? 1.2 : 0);
    edges.push({
      key: edge.key,
      sourceKey: edge.sourceKey,
      targetKey: edge.targetKey,
      from,
      to,
      control: [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + lift, (from[2] + to[2]) / 2],
    });
  }

  return { rigs, pods, agents, edges, bounds: computeBounds(rigs, pods, agents, edges) };
}

function computeBounds(rigs: LaidOutRig[], pods: LaidOutPod[], agents: LaidOutAgent[], edges: LaidOutEdge[]): SpatialBounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const add = (x: number, y: number, z: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  };
  for (const r of rigs) {
    add(r.x, -SPATIAL_LAYOUT.deckThickness, r.z);
    add(r.x + r.w, 0, r.z + r.d);
  }
  for (const p of pods) add(p.x + p.w, p.top, p.z + p.d);
  for (const a of agents) add(a.position[0], a.position[1] + 1.2, a.position[2]);
  for (const e of edges) add(e.control[0], e.control[1] * 0.75, e.control[2]);
  if (!Number.isFinite(minX)) {
    // Empty scene: a small unit volume at the origin keeps the camera math finite.
    return { min: [-10, -1, -10], max: [10, 4, 10], center: [0, 1.5, 0], radius: 15 };
  }
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(
    8,
    Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) / 2,
  );
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], center, radius };
}

// ---------------------------------------------------------------------------
// Camera math (pure; the renderer applies it)
// ---------------------------------------------------------------------------

export type SpatialCameraPreset = "iso" | "top";

/** Unit view directions (from target toward camera). Top keeps a hair of
 *  tilt so OrbitControls never sits exactly on the pole. */
export const SPATIAL_CAMERA_DIRECTIONS: Record<SpatialCameraPreset, Vec3> = {
  iso: normalize([0.78, 0.92, 1]),
  top: normalize([0, 1, 0.012]),
};

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len === 0) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Distance that fits a sphere of `radius` inside a perspective frustum with
 *  vertical FOV `fovDeg` and the given aspect, with fractional padding. */
export function fitDistance(radius: number, fovDeg: number, aspect: number, padding = 1.12): number {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const fov = Number.isFinite(fovDeg) ? fovDeg : 40;
  const vFov = (Math.min(Math.max(fov, 10), 120) * Math.PI) / 180;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * a);
  const limiting = Math.min(vFov, hFov);
  return (r / Math.sin(limiting / 2)) * Math.max(1, padding);
}
