// TEST-ONLY sanitized fixtures for Recent / Pulse / maintained stream.
//
// Every identifier, session, rig and body below is fictional demo data;
// nothing is read from a live daemon, queue database, stream store or native
// history. Shapes are typed against the reviewed browser contracts
// (lib/recent-pulse-contracts.ts), and the route emulation follows the
// served daemon contracts (docs/plans/gui-recent-pulse-contracts.md):
// recent-transitions scope/rig/limit 1–20 and errors, latest-window order,
// queue item 404, and stream direction/limit/afterSortKey/filters/archive.
//
// Seats come from the twin's existing node inventory (fixtures.ts):
// coordinator@acme-build (terminalActive true), builder2@acme-build (true),
// reviewer1@acme-build (false). The twin's `/api/queue/list` is served by
// operator-fixtures.ts; recentPulseQueueListFor is exported for harnesses
// that need an independent Pulse queue (tests).

import type { MaintainedStreamItem, PulseQueueItem, RecentTransition } from "../src/lib/recent-pulse-contracts.js";

type TwinResponse = { body: unknown; status: number };

const at = (minute: number, second = 0) => `2025-09-01T01:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

const qitem = (qitemId: string, state: PulseQueueItem["state"], destinationSession: string, summary: string | null, extra: Partial<PulseQueueItem> = {}): PulseQueueItem & Record<string, unknown> => ({
  qitemId, state, destinationSession, summary,
  sourceSession: "coordinator@acme-build", priority: "routine", tsCreated: at(10), tsUpdated: at(40),
  body: `${summary ?? "Untitled request"}\n(fictional demo request body)`, blockedOn: null, handedOffTo: null, claimedAt: null,
  // Additive served fields are retained by the contracts.
  tier: null, tags: null, handedOffFrom: null, evidenceRef: null, targetRepo: null,
  ...extra,
});

/** Queue rows for Pulse lanes and single-item reads. */
export const recentPulseQueueRows: Array<PulseQueueItem & Record<string, unknown>> = [
  qitem("qitem-rp-needs-1", "pending", "human-avery@host", "Approve the release-train build plan", { priority: "urgent" }),
  qitem("qitem-rp-needs-2", "blocked", "builder2@acme-build", "Confirm load-test budget", { blockedOn: "human-avery@host" }),
  qitem("qitem-rp-active-1", "in-progress", "coordinator@acme-build", "Coordinate slice 2 hand-offs", { claimedAt: at(20) }),
  qitem("qitem-rp-parked-1", "in-progress", "reviewer1@acme-build", "Review the deploy checklist", { claimedAt: at(12) }),
  qitem("qitem-rp-blocked-1", "blocked", "builder2@acme-build", "Wire the packaging step", { blockedOn: "qitem-rp-active-1" }),
  qitem("qitem-rp-blocked-2", "blocked", "builder2@acme-build", "Publish preview build", { blockedOn: "gate:release-window" }),
  qitem("qitem-rp-next-1", "pending", "builder2@acme-build", "Add a smoke test for the CLI"),
  qitem("qitem-rp-next-2", "pending", "reviewer1@acme-build", null, { body: "\n  Check the changelog wording\nsecond line" }),
  qitem("qitem-rp-claimed-pending", "pending", "builder2@acme-build", "Already claimed; not up next", { claimedAt: at(30) }),
  qitem("qitem-rp-done-1", "done", "builder2@acme-build", "Fix flaky lint step", { tsUpdated: at(44) }),
  qitem("qitem-rp-handoff-1", "handed-off", "coordinator@acme-build", "Hand slice 1 to review", { tsUpdated: at(46), handedOffTo: "reviewer1@acme-build" }),
];

const transition = (transitionId: number, qitemId: string, minute: number, actorSession: string, change: string, rig: string, summary: string | null, target: Pick<RecentTransition, "targetKind" | "target"> = { targetKind: "qitem", target: qitemId }): RecentTransition => ({
  transitionId, qitemId, ts: at(minute), actorSession, change, summary, rig, ...target,
});

/** Served chronology across two rigs, including a tied timestamp (#7/#8). */
export const recentPulseTransitions: RecentTransition[] = [
  transition(3, "qitem-rp-done-1", 14, "builder2@acme-build", "claimed", "acme-build", "Fix flaky lint step"),
  transition(4, "qitem-rp-active-1", 20, "coordinator@acme-build", "claimed", "acme-build", "Coordinate slice 2 hand-offs", { targetKind: "slice", target: "slice-02-packaging" }),
  transition(5, "qitem-rp-parked-1", 21, "reviewer1@acme-build", "claimed", "acme-build", "Review the deploy checklist"),
  transition(6, "qitem-rp-blocked-1", 25, "builder2@acme-build", "blocked", "acme-build", "Wire the packaging step", { targetKind: "mission", target: "release-train" }),
  transition(7, "qitem-rp-comms-1", 30, "writer@acme-comms", "completed", "acme-comms", "Draft the release notes"),
  transition(8, "qitem-rp-comms-2", 30, "router@acme-comms", "failed", "acme-comms", null),
  transition(9, "qitem-rp-done-1", 44, "builder2@acme-build", "completed", "acme-build", "Fix flaky lint step"),
  transition(10, "qitem-rp-handoff-1", 46, "coordinator@acme-build", "handed off", "acme-build", "Hand slice 1 to review"),
];

const stream = (n: number, minute: number, sourceSession: string, body: string, extra: Partial<MaintainedStreamItem> = {}): MaintainedStreamItem => ({
  streamItemId: `stream-rp-${String(n).padStart(2, "0")}`, tsEmitted: at(minute), streamSortKey: `${at(minute)}#${String(n).padStart(6, "0")}`,
  sourceSession, body, format: "text", hintType: null, hintUrgency: null, hintDestination: null, hintTags: null, interrupt: false, archivedAt: null, ...extra,
});

/** Persisted maintained stream; #04/#05 share a timestamp, #06 is archived. */
export const recentPulseStreamItems: MaintainedStreamItem[] = [
  stream(1, 5, "coordinator@acme-build", "Starting release-train planning"),
  stream(2, 9, "builder2@acme-build", "Build cache warmed", { hintType: "progress", hintTags: ["build"] }),
  stream(3, 15, "reviewer1@acme-build", "Checklist review queued", { hintDestination: "coordinator@acme-build" }),
  stream(4, 22, "builder2@acme-build", "Packaging step blocked on hand-offs", { hintUrgency: "high", hintTags: ["build", "blocked"] }),
  stream(5, 22, "coordinator@acme-build", "Hand-off order confirmed"),
  stream(6, 26, "writer@acme-comms", "Old draft superseded", { archivedAt: at(28) }),
  stream(7, 31, "writer@acme-comms", "Release notes drafted\nSecond paragraph of notes", { format: "markdown", hintTags: ["release"] }),
  stream(8, 38, "builder2@acme-build", "Lint fix pushed", { hintType: "result", hintTags: ["build"] }),
  stream(9, 44, "coordinator@acme-build", "Slice 1 handed to review", { interrupt: true, hintDestination: "reviewer1@acme-build" }),
];

/** `/api/queue/recent-transitions` emulation (local active rigs). */
export function recentTransitionsFor(search: URLSearchParams, rows: readonly RecentTransition[] = recentPulseTransitions): TwinResponse {
  const scope = search.get("scope");
  const rig = search.get("rig");
  if (scope !== null && scope !== "" && scope !== "instance" && scope !== "rig") return { body: { error: "invalid_scope" }, status: 400 };
  const rigScope = scope === "rig" || (scope === null && rig !== null);
  if (rigScope && !rig) return { body: { error: "rig_required" }, status: 400 };
  const requested = Number(search.get("limit"));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 20) : 20;
  const ordered = rows.filter((r) => !rigScope || r.rig === rig)
    .slice().sort((a, b) => b.ts.localeCompare(a.ts) || b.transitionId - a.transitionId).slice(0, limit).reverse();
  return { body: ordered, status: 200 };
}

/** `/api/queue/list` emulation for the Pulse windows (state/attention/limit). */
export function recentPulseQueueListFor(search: URLSearchParams, rows: readonly PulseQueueItem[] = recentPulseQueueRows): TwinResponse {
  const limit = Number(search.get("limit") ?? 100);
  const attention = search.get("attention") === "1";
  const states = attention ? ["pending", "in-progress", "blocked"] : (search.get("state") ?? "").split(",").filter(Boolean);
  const human = (s: string | null) => !!s && /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/.test(s);
  const served = rows.filter((r) => (!states.length || states.includes(r.state)) && (!attention || human(r.destinationSession) || human(r.blockedOn)))
    .slice().sort((a, b) => b.tsCreated.localeCompare(a.tsCreated));
  return { body: served.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 100), status: 200 };
}

/** `/api/stream/list` emulation: tuple (tsEmitted, streamSortKey) ordering. */
export function streamListFor(search: URLSearchParams, rows: readonly MaintainedStreamItem[] = recentPulseStreamItems): TwinResponse {
  const direction = search.get("direction") ?? "chronological";
  if (direction !== "chronological" && direction !== "latest") return { body: { error: "invalid direction" }, status: 400 };
  const after = search.get("afterSortKey");
  if (direction === "latest" && after !== null) return { body: { error: "afterSortKey is not supported with direction=latest" }, status: 400 };
  const limit = Number(search.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { body: { error: "invalid limit" }, status: 400 };
  const since = search.get("since"), until = search.get("until");
  for (const value of [since, until]) if (value !== null && !Number.isFinite(Date.parse(value))) return { body: { error: "invalid timestamp" }, status: 400 };
  if (since && until && Date.parse(since) > Date.parse(until)) return { body: { error: "since must not be after until" }, status: 400 };
  const tuple = (r: MaintainedStreamItem) => `${r.tsEmitted}\u0000${r.streamSortKey}`;
  let served = rows
    .filter((r) => search.get("includeArchived") === "true" || r.archivedAt === null)
    .filter((r) => !search.has("sourceSession") || r.sourceSession === search.get("sourceSession"))
    .filter((r) => !search.has("hintDestination") || r.hintDestination === search.get("hintDestination"))
    .filter((r) => !search.has("hintTag") || (r.hintTags ?? []).includes(search.get("hintTag")!))
    .filter((r) => (!since || Date.parse(r.tsEmitted) >= Date.parse(since)) && (!until || Date.parse(r.tsEmitted) <= Date.parse(until)))
    .slice().sort((a, b) => tuple(a).localeCompare(tuple(b)));
  if (after !== null) {
    const cursor = rows.find((r) => r.streamSortKey === after);
    served = cursor ? served.filter((r) => tuple(r) > tuple(cursor)) : [];
  }
  return { body: direction === "latest" ? served.slice(-limit) : served.slice(0, limit), status: 200 };
}

/** Body for a Recent/Pulse/stream read, or undefined if not one. Does NOT
 * answer `/api/queue/list` (the twin's operator fixtures own it). */
export function recentPulseTwinBody(pathname: string, search: URLSearchParams, queueRows: ReadonlyArray<{ qitemId: string }> = recentPulseQueueRows): TwinResponse | undefined {
  if (pathname === "/api/queue/recent-transitions") return recentTransitionsFor(search);
  if (pathname === "/api/stream/list") return streamListFor(search);
  const item = /^\/api\/queue\/([^/]+)$/.exec(pathname);
  if (item && !["list", "human-updates", "attention-aggregate", "recent-transitions"].includes(item[1]!)) {
    let id: string;
    try { id = decodeURIComponent(item[1]!); } catch { return { body: { error: "qitem_not_found" }, status: 404 }; }
    const row = queueRows.find((r) => r.qitemId === id);
    return row ? { body: row, status: 200 } : { body: { error: "qitem_not_found" }, status: 404 };
  }
  return undefined;
}
