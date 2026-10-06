// TEST-ONLY sanitized fixtures for the connected-instance operator pages
// (Health, Attention + delivered updates, Configuration, Connections).
//
// Every identifier, path and name below is fictional demo data. Nothing is
// read from a live daemon, instance database, native history or settings
// file. Shapes are typed against the real exported hook contracts, so a
// contract change breaks the twin/test build instead of drifting silently.
// Used by the digital twin's fetch stub (root browser verification) and by
// packages/ui/test/operator-views.test.tsx.

import type { HealthListProjection, HealthRecord } from "../src/hooks/useCanonicalHealth.js";
import type { AttentionDetail, AttentionRead, DeliveredHumanUpdates } from "../src/hooks/useCanonicalAttention.js";
import type { ConfigurationBrowser } from "../src/hooks/useConfigurationBrowser.js";
import type { GatewayConnections, SlackManifest } from "../src/hooks/useGatewayConnections.js";

const AT = "2025-09-01T02:00:00.000Z";
const EARLIER = "2025-09-01T01:42:00.000Z";
const HOME = "/home/demo/.openrig";
const PROJECT_ROOT = "/home/demo/work/acme-project";

const window = (source: HealthRecord["window"]["source"]): HealthRecord["window"] => ({ source, startedAt: EARLIER, endedAt: AT, limit: 50, retentionSeconds: 3600 });

export const twinHealthRecords: HealthRecord[] = [
  {
    schema: "openrig.health/v0alpha1", id: "hf-queue-stall-builder2", detector: "queue-pickup-stall", category: "behavioral",
    scope: { type: "seat", rigId: "rig_alpha", seatId: "node_builder2" }, severity: "critical", confidence: "high", status: "active",
    startedAt: EARLIER, lastObservedAt: AT, window: window("queue-transition"),
    freshness: { state: "fresh", evaluatedAt: AT, newestSourceAt: AT, maxAgeSeconds: 300, ageSeconds: 42 },
    summary: "Delivered request not picked up for 18 minutes",
    evidence: [
      { type: "queue-transition", sourceOrder: 0, observedAt: EARLIER, qitemId: "q-twin-101", transitionId: 7, state: "delivered", actorSession: "coordinator@acme-build", identityProvenance: "native" },
      { type: "topology-activity", sourceOrder: 1, observedAt: AT, nodeId: "node_builder2", sessionName: "builder2@acme-build", activity: "idle", activitySequence: 311 },
    ],
    threshold: "pickup within 15 minutes of delivery", explanation: "The seat received a request and has not claimed it within the configured window.",
    suggestedInspection: "rig queue show q-twin-101 --full", indeterminateReason: null, policyVersion: "health-policy/v3",
    operatingPosture: {
      posture: "delegated", source: "binding", reason: "Mission binding delegates routine pickup", grantsAuthority: false,
      binding: { id: "bind-twin-7", scope: "mission", setAt: EARLIER, evidence: "operator-authored binding" },
      context: { rigId: "rig_alpha", projectId: "acme-project", missionId: "release-train", phase: { value: "build", source: "mission.yaml" }, sources: ["project.yaml", "mission.yaml"], paths: { project: PROJECT_ROOT, mission: `${PROJECT_ROOT}/missions/release-train` } },
    },
  },
  {
    schema: "openrig.health/v0alpha1", id: "hf-context-reviewer1", detector: "context-pressure", category: "context",
    scope: { type: "seat", rigId: "rig_alpha", seatId: "node_reviewer1" }, severity: "warning", confidence: "medium", status: "indeterminate",
    startedAt: EARLIER, lastObservedAt: null, window: window("context-usage"),
    freshness: { state: "unavailable", evaluatedAt: AT, newestSourceAt: null, maxAgeSeconds: 120, ageSeconds: null },
    summary: "Context usage could not be sampled", evidence: [
      { type: "context-usage", sourceOrder: 0, observedAt: null, nodeId: "node_reviewer1", sessionId: null, usedPercentage: null, available: false, fresh: false },
    ],
    threshold: "warning at 80%, critical at 92%", explanation: "No fresh context sample exists, so pressure is unknown — not healthy.",
    suggestedInspection: "rig ps --nodes acme-build", indeterminateReason: "context sampler unavailable for this runtime",
    ceremony: {
      origin: "passive", stage: "needs-diagnosis", lineageId: "lin-twin-3", basis: "missing sample in bounded window", transitionIds: [],
      context: [{ path: `${PROJECT_ROOT}/missions/release-train/mission.md`, state: "available", sha256: "0f3a9c", role: "mission" }],
      workflowReceipts: [], missingFacts: ["context sample", "runtime support statement"],
    },
  },
  {
    schema: "openrig.health/v0alpha1", id: "hf-rig-restore-gamma", detector: "lifecycle-restore", category: "process",
    scope: { type: "rig", rigId: "rig_gamma" }, severity: "info", confidence: "high", status: "cleared",
    startedAt: EARLIER, lastObservedAt: AT, window: window("lifecycle-receipt"),
    freshness: { state: "fresh", evaluatedAt: AT, newestSourceAt: AT, maxAgeSeconds: 600, ageSeconds: 75 },
    summary: "Restore completed after partial outcome",
    evidence: [{ type: "lifecycle-receipt", sourceOrder: 0, observedAt: AT, receiptId: "rcpt-twin-12", operation: "restore", outcome: "completed" }],
    threshold: "receipt outcome", explanation: "A later receipt cleared the earlier partial restore.", suggestedInspection: "rig snapshot list acme-core",
    indeterminateReason: null,
  },
];

export const twinHealthList: HealthListProjection = {
  schema: "openrig.health-list/v0alpha1", evaluatedAt: AT, total: 3, limit: 200, truncated: false, records: twinHealthRecords,
  coverage: [
    { source: "queue-transition", evaluatedAt: AT, unit: "transitions", limit: 500, total: 640, evaluated: 500, omitted: 140, partial: true, order: "latest-first" },
    { source: "watchdog-history", evaluatedAt: AT, status: "unavailable", partial: true, reason: "watchdog store not readable" },
  ],
};

const queueAction = { id: "queue:q-twin-101", kind: "action", summary: "Approve release-train build plan", unblocks: "Builder seat starts implementation",
  urgency: "high", at: AT, scope: "project acme-project", project: { id: "acme-project", root: PROJECT_ROOT }, source: "/api/queue/q-twin-101", recipient: "human:operator" } as const;
const closedAction = { id: "queue:q-twin-099", kind: "action", summary: "Confirm deploy window (resolved elsewhere)", unblocks: "Deploy seat",
  urgency: "routine", at: EARLIER, scope: "instance · project unknown", project: null, source: "/api/queue/q-twin-099", recipient: "human:operator" } as const;
const healthUpdate = { id: "health:hf-queue-stall-builder2", kind: "update", summary: "Delivered request not picked up for 18 minutes · active",
  unblocks: null, urgency: "critical", at: AT, scope: "instance health · seat / rig_alpha / node_builder2", project: null, source: "/api/health/hf-queue-stall-builder2" } as const;
const workflowUpdate = { id: "workflow:wf-twin-5", kind: "update", summary: "release-train: verify done · workflow active", unblocks: null, urgency: "outcome", at: EARLIER,
  scope: "project acme-project · mission release-train", project: { id: "acme-project", root: PROJECT_ROOT }, source: "/api/workflow/wf-twin-5/trace" } as const;

export const twinAttentionDetails: Record<string, AttentionDetail> = {
  [queueAction.id]: { item: { ...queueAction }, lines: ["Request:", "Please approve the release-train build plan before the builder starts.", "Supplemental detail:", "Plan covers 3 slices; no schema changes.", "State: pending", "To: human:operator", "From: coordinator@acme-build", "Blocked on: none", "Posture: delegated · Mission binding delegates routine pickup", `Evidence reference: ${PROJECT_ROOT}/missions/release-train/PLAN.md#scope`, "Decision route: follow the correlated human request in Slack. Inspect: rig queue show q-twin-101 --full", "Queue history (read/delivery is not approval):", "{\"transitionId\":6,\"state\":\"pending\"}", "{\"transitionId\":7,\"state\":\"delivered\"}"], files: [{ label: "Request evidence", path: `${PROJECT_ROOT}/missions/release-train/PLAN.md#scope` }] },
  [closedAction.id]: { item: { ...closedAction }, lines: ["Request:", "Confirm the deploy window.", "State: done", "To: human:operator", "From: deploy@acme-comms", "Queue history (read/delivery is not approval):", "{\"transitionId\":3,\"state\":\"done\"}"], files: [] },
  [healthUpdate.id]: { item: { ...healthUpdate }, lines: ["Status: active; first observed 2025-09-01T01:42:00.000Z; last observed 2025-09-01T02:00:00.000Z", "Freshness: fresh; ", "The seat received a request and has not claimed it within the configured window.", "rig queue show q-twin-101 --full", "Threshold: pickup within 15 minutes of delivery"], files: [] },
  [workflowUpdate.id]: { item: { ...workflowUpdate }, lines: ["Current workflow state: active; a step receipt alone does not complete the mission.", "Actor: verifier@acme-build"], files: [{ label: "Mission authority", path: `${PROJECT_ROOT}/missions/release-train/mission.yaml` }] },
};

export const twinAttention: AttentionRead = {
  scope: "instance", readAt: AT, detail: null, detailError: null,
  items: [{ ...queueAction }, { ...healthUpdate }, { ...workflowUpdate }],
  sources: [
    { source: "project catalog", state: "available", detail: "Exact catalog identities; unscoped requests remain instance facts." },
    { source: "queue", state: "available", detail: "Open human-addressed requests and explicit human blockers." },
    { source: "proof: project acme-project", state: "unavailable", detail: "missions root not readable" },
    { source: "mission outcomes", state: "available", detail: "At most 200 manifest-bound workflows." },
    { source: "health", state: "partial", detail: "queue-transition: partial — evaluated 500 of 640 transitions; 140 omitted." },
  ],
};

export function twinAttentionRead(item: string | null): AttentionRead {
  if (item === null) return twinAttention;
  const detail = twinAttentionDetails[item] ?? null;
  return { ...twinAttention, detail, detailError: detail ? null : "Selected source is unavailable or outside the current source window. Return to Attention to refresh; absence is not resolution." };
}

export const twinDeliveredUpdates: DeliveredHumanUpdates = {
  limit: 20, truncated: false,
  items: [
    { qitemId: "q-twin-120", summary: "Nightly build green", body: "Nightly build finished; 412 tests passed.", humanDetail: "Artifacts retained for 7 days.", destinationSession: "human:operator", sourceSession: "builder2@acme-build", tags: ["project:acme-project"], evidenceRef: `${PROJECT_ROOT}/reports/nightly.md`, deliveredAt: AT, deliveryReceipt: "slack:accepted:demo-ts-1" },
    { qitemId: "q-twin-118", summary: null, body: "Reviewer finished the dimension pass.\nTwo notes filed.", humanDetail: null, destinationSession: "human:operator", sourceSession: "reviewer1@acme-build", tags: null, evidenceRef: null, deliveredAt: EARLIER, deliveryReceipt: "slack:accepted:demo-ts-0" },
  ],
};

const entry = (e: Partial<ConfigurationBrowser["entries"][number]> & Pick<ConfigurationBrowser["entries"][number], "key" | "group">): ConfigurationBrowser["entries"][number] => ({
  value: null, defaultValue: null, defaultKnown: true, source: "default", visibility: "shown", reason: null, scope: "Displayed daemon instance",
  application: "Resolved configuration; running application unverified.", ...e,
});

export const twinConfiguration: ConfigurationBrowser = {
  observedAt: AT, home: HOME, readOnly: true,
  sources: [
    { id: "general", state: "available", path: `${HOME}/config.json`, detail: "Environment > file > derived default." },
    { id: "slack", state: "available", path: `${HOME}/gateway/slack.json`, detail: "Enabled; applied changed; external reach unverified." },
    { id: "people", state: "available", path: `${HOME}/gateway/humans.json`, detail: "Read-only registry; registration does not prove delivery." },
    { id: "hosts", state: "missing", path: `${HOME}/hosts.yaml`, detail: "Authored registered targets only; no connection or readiness probe." },
    { id: "health", state: "malformed", path: `${HOME}/health/policy.json`, detail: "Validated health policy." },
  ],
  entries: [
    entry({ key: "host.name", group: "general", value: "demo-studio", source: "file", defaultValue: "" }),
    entry({ key: "workspace.root", group: "general", value: "/home/demo/work", source: "env", defaultValue: "/home/demo/work" }),
    entry({ key: "queue.pickup_stall_threshold_minutes", group: "general", value: 15, defaultValue: 15, source: "default" }),
    entry({ key: "policies.claude_compaction.compact_instruction", group: "general", value: null, defaultValue: null, source: "file", visibility: "withheld", reason: "Instruction bodies are withheld." }),
    entry({ key: "slack.channel", group: "slack", value: "C0DEMO", defaultValue: null, source: "file" }),
    entry({ key: "slack.botToken", group: "slack", value: "resolved", defaultValue: null, defaultKnown: false, source: "unreported", reason: "Credential resolution presence only; values and provenance withheld." }),
    entry({ key: "people.k1.displayName", group: "people", subject: "Avery Demo", value: "Avery Demo", defaultKnown: false, source: "file" }),
    entry({ key: "people.k1.availability", group: "people", subject: "Avery Demo", value: "focus", defaultKnown: false, source: "file" }),
    entry({ key: "health.policy.disabledDetectors", group: "health", value: null, defaultValue: "", source: "unavailable", visibility: "unavailable" }),
  ],
  exclusions: ["Provider credentials and private runtime files are outside CONFIG.", "Instruction bodies, free notes, credential contents and sensitive URL components are withheld."],
};

export const twinConnections: GatewayConnections = {
  observedAt: AT, home: HOME, pid: 4242, settingsSource: `${HOME}/config.json`,
  settings: [{ key: "host.name", value: "demo-studio", source: "file" }, { key: "workspace.root", value: "/home/demo/work", source: "env" }],
  configSource: { state: "loaded", path: `${HOME}/gateway/slack.json`, sourceState: "available" },
  configuration: { enabled: true, channel: "C0DEMO", inboundDestination: "coordinator@acme-build", outboundDestinations: ["human:operator", null], postLevel: "info", interruptLevel: "high", botToken: "resolved", appToken: "resolved" },
  running: { state: "active", activatedAt: EARLIER, outboundReady: true, inboundReady: true, inboundState: "socket connected at activation", applied: "changed" },
  state: "unverified", nextAction: "Configuration changed since activation. Inspect, then restart the gateway with the supported command.",
  verification: { state: "ready-at-check", at: EARLIER, actor: "human:operator" },
  registry: { state: "available", path: `${HOME}/gateway/humans.json` },
  humans: [
    { browserKey: "k1", entityId: "human-avery", address: "human:operator", displayName: "Avery Demo", class: "human", away: false, deliveryClass: "A", availability: "focus", excluded: false,
      bindings: [{ browserKey: "b1", kind: "slack", ref: "U0DEMO1", role: "primary", handle: "@avery", credentialReference: false }, { browserKey: "b2", kind: "slack", ref: "C0DEMO", role: "secondary", handle: null, credentialReference: true }] },
    { browserKey: "k2", entityId: "human-blake", address: "human:observer", displayName: null, class: "human", away: true, deliveryClass: "C", availability: "away", excluded: true, bindings: [] },
  ],
};

export const twinSlackManifest: SlackManifest = {
  yaml: "display_information:\n  name: OpenRig Demo\nfeatures:\n  bot_user:\n    display_name: OpenRig\n",
  url: "https://api.slack.com/apps?new_app=1&manifest_yaml=demo",
  scopes: ["chat:write", "channels:history"], events: ["message.channels"],
  manifest: {
    display_information: { name: "OpenRig Demo", description: "Demo connector" }, features: { bot_user: { display_name: "OpenRig", always_online: false } },
    oauth_config: { scopes: { bot: ["chat:write", "channels:history"] } },
    settings: { event_subscriptions: { bot_events: ["message.channels"] }, interactivity: { is_enabled: true }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false },
  } as SlackManifest["manifest"],
};

type TwinResponse = { body: unknown; status: number };
const SCOPE_TYPES = ["instance", "rig", "seat", "mission", "slice"] as const;
const SEVERITIES = ["info", "warning", "critical"] as const;
const STATUSES = ["active", "cleared", "indeterminate"] as const;

/** The daemon's `healthScopeId`: the scope's terminal identity, never a composite. */
function twinHealthScopeId(scope: HealthRecord["scope"]): string {
  switch (scope.type) {
    case "instance": return scope.instanceId;
    case "rig": return scope.rigId;
    case "seat": return scope.seatId;
    case "mission": return scope.missionId;
    case "slice": return scope.sliceId;
  }
}

/**
 * Emulates the served `/api/health` contract (routes/health.ts +
 * HealthProjectionService.list): paired scope_type/scope_id, severity and
 * status filters with 400s on invalid input, the default read omitting
 * cleared findings, ceremony-first ordering, `limit` (default 100, 1–200),
 * `total`/`truncated` over the filtered set, and evaluatedAt/coverage taken
 * from the whole evaluation (filters never narrow coverage).
 */
export function twinHealthListFor(search: URLSearchParams, records: readonly HealthRecord[] = twinHealthRecords, coverage = twinHealthList.coverage): TwinResponse {
  const scopeType = search.get("scope_type");
  const scopeId = search.get("scope_id");
  if ((scopeType === null) !== (scopeId === null)) return { body: { error: "scope_type and scope_id must be provided together" }, status: 400 };
  if (scopeType !== null && !(SCOPE_TYPES as readonly string[]).includes(scopeType)) return { body: { error: `scope_type must be one of: ${SCOPE_TYPES.join(", ")}` }, status: 400 };
  const severity = search.get("severity");
  if (severity !== null && !(SEVERITIES as readonly string[]).includes(severity)) return { body: { error: `severity must be one of: ${SEVERITIES.join(", ")}` }, status: 400 };
  const status = search.get("status");
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) return { body: { error: `status must be one of: ${STATUSES.join(", ")}` }, status: 400 };
  const limit = search.get("limit") === null ? 100 : Number(search.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { body: { error: "limit must be an integer from 1 to 200" }, status: 400 };
  const filtered = records.filter((record) => (scopeType === null || record.scope.type === scopeType)
    && (scopeId === null || twinHealthScopeId(record.scope) === scopeId)
    && (severity === null || record.severity === severity)
    && (status === null ? record.status !== "cleared" : record.status === status))
    .sort((a, b) => Number(b.detector === "process.ceremony-amplification") - Number(a.detector === "process.ceremony-amplification"));
  const body: HealthListProjection = {
    schema: "openrig.health-list/v0alpha1",
    evaluatedAt: records.map((record) => record.freshness.evaluatedAt).sort().at(-1) ?? null,
    total: filtered.length, limit, truncated: filtered.length > limit, records: filtered.slice(0, limit),
    ...(coverage?.length ? { coverage } : {}),
  };
  return { body, status: 200 };
}

/** Emulates `/api/queue/human-updates?limit=` (default 20, 1–100, latest first). */
export function twinDeliveredUpdatesFor(search: URLSearchParams, all: DeliveredHumanUpdates["items"] = twinDeliveredUpdates.items): TwinResponse {
  const limit = Number(search.get("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { body: { error: "limit must be an integer from 1 to 100" }, status: 400 };
  return { body: { items: all.slice(0, limit), limit, truncated: all.length > limit } satisfies DeliveredHumanUpdates, status: 200 };
}

/** Fictional queue rows for the bounded queue windows (`/api/queue/list`).
 * Four open requests to human:operator exercise Connections' three-row sample. */
const queueRow = (qitemId: string, state: string, destinationSession: string, summary: string, sourceSession = "coordinator@acme-build") => ({
  qitemId, tsCreated: EARLIER, tsUpdated: AT, sourceSession, destinationSession, state, priority: "routine", tier: null, tags: null,
  blockedOn: null, handedOffTo: null, handedOffFrom: null, claimedAt: null, summary, evidenceRef: null, body: `${summary} (fictional demo request)`,
});
export const twinQueueRows = [
  queueRow("q-twin-101", "pending", "human:operator", "Approve release-train build plan"),
  queueRow("q-twin-102", "in-progress", "human:operator", "Review deploy checklist", "deploy@acme-comms"),
  queueRow("q-twin-103", "blocked", "human:operator", "Confirm budget for load test"),
  queueRow("q-twin-104", "pending", "human:operator", "Sign off release notes", "writer@acme-comms"),
  queueRow("q-twin-105", "pending", "human:observer", "Acknowledge maintenance window"),
  queueRow("q-twin-106", "in-progress", "builder2@acme-build", "Implement slice 2"),
];

function twinQueueList(search: URLSearchParams): TwinResponse {
  const limit = Number(search.get("limit") ?? 100);
  const states = search.get("attention") === "1" ? ["pending", "in-progress", "blocked"] : (search.get("state") ?? "").split(",").filter(Boolean);
  const rows = twinQueueRows.filter((row) => (!states.length || states.includes(row.state))
    && (search.get("attention") !== "1" || row.destinationSession.startsWith("human")));
  return { body: rows.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 100), status: 200 };
}

/** Served rig spec names (`/api/rigs/:id/spec.json`), fictional. */
const twinRigSpecNames: Record<string, string> = { rig_alpha: "acme-build", rig_bravo: "acme-comms", rig_gamma: "acme-core" };

/** Body for a connected-instance operator route, or undefined if not one. */
export function operatorTwinBody(pathname: string, search: URLSearchParams): TwinResponse | undefined {
  if (pathname === "/api/health") return twinHealthListFor(search);
  const finding = /^\/api\/health\/(.+)$/.exec(pathname);
  if (finding) {
    let id: string;
    try { id = decodeURIComponent(finding[1]!); } catch { return { body: { error: "health_finding_not_found" }, status: 404 }; }
    const record = twinHealthRecords.find((r) => r.id === id);
    return record ? { body: record, status: 200 } : { body: { error: "health_finding_not_found" }, status: 404 };
  }
  if (pathname === "/api/queue/list") return twinQueueList(search);
  const rigSpec = /^\/api\/rigs\/([^/]+)\/spec\.json$/.exec(pathname);
  if (rigSpec) {
    const name = twinRigSpecNames[decodeURIComponent(rigSpec[1]!)];
    return name ? { body: { name, version: "0.2", pods: [] }, status: 200 } : { body: { error: "rig not found" }, status: 404 };
  }
  if (pathname === "/api/attention") return { body: twinAttentionRead(search.get("item")), status: 200 };
  if (pathname === "/api/queue/human-updates") return twinDeliveredUpdatesFor(search);
  if (pathname === "/api/config" && search.get("view") === "browser") return { body: twinConfiguration, status: 200 };
  if (pathname === "/api/gateway/connections") return { body: twinConnections, status: 200 };
  if (pathname === "/api/gateway/slack/manifest") return { body: twinSlackManifest, status: 200 };
  return undefined;
}
