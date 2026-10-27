// The graph's data model: seats as physics nodes grouped by rig, delegation
// links, and the message/activity signals read from the event stream. Pure.
import type { PsEntry, RigGraph, SeatNode } from "../api.js";
import type { RigEvent } from "../events.js";
import { contextPercent, seatTone, type Tone } from "../model.js";

export type GNode = {
  id: string;
  seat: SeatNode;
  rigId: string;
  rigName: string;
  tone: Tone;
  ctx: number | null;
  working: boolean;
  needsInput: boolean;
  activity: string | null;
  inProgress: number;
  pending: number;
  blocked: number;
  qitems: { qitemId: string; bodyExcerpt: string; tier: string | null }[];
  // d3-force state
  x: number; y: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null;
};
export type GLink = { source: string | GNode; target: string | GNode; kind: "delegates_to" | "can_observe" };
export type GRig = { rigId: string; name: string; color: string; anchor: { x: number; y: number }; nodeIds: string[] };
export type Model = { rigs: GRig[]; nodes: GNode[]; links: GLink[] };

export const RIG_COLORS = ["#5aa9ff", "#f0a35e", "#8bd17c", "#d98cf0", "#f06e8c", "#5fd3c9", "#e6c75a", "#9aa9ff", "#ff9f6e", "#7fe0a8"];

export const WORKING_MS = 20_000;

/** Rig anchors on a sunflower spiral: large rigs first, close to the middle. */
export function rigAnchors(sizes: number[], aspect = 1): { x: number; y: number }[] {
  const spacing = 170 + 11 * Math.max(0, ...sizes);
  const stretch = Math.sqrt(Math.max(0.5, Math.min(3, aspect)));
  return sizes.map((_, i) => {
    if (i === 0) return { x: 0, y: 0 };
    const a = i * 2.399963;
    const r = spacing * Math.sqrt(i) * 0.85;
    return { x: r * Math.cos(a) * stretch, y: (r * Math.sin(a)) / stretch };
  });
}

export function buildModel(
  rigs: PsEntry[],
  byRig: Map<string, SeatNode[]>,
  graphs: (RigGraph | undefined)[],
  events: RigEvent[],
  previous: Map<string, GNode>,
  now: number,
  aspect = 1,
): Model {
  const ordered = [...rigs].map((r, i) => ({ r, i, size: byRig.get(r.rigId)?.length ?? 0 })).sort((a, b) => b.size - a.size);
  const anchors = rigAnchors(ordered.map((o) => o.size), aspect);
  const recentlyWorking = new Set<string>();
  for (const ev of events) {
    if (ev.type === "agent.activity" && ev.seenAt > now - WORKING_MS) {
      const act = ev.activity as { state?: string } | undefined;
      if (act?.state === "running" && typeof ev.sessionName === "string") recentlyWorking.add(ev.sessionName);
    }
  }
  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const outRigs: GRig[] = [];
  const byNodeId = new Map<string, string>();
  ordered.forEach(({ r, i }, k) => {
    const seats = byRig.get(r.rigId) ?? [];
    const graph = graphs[i];
    const extra = new Map<string, Partial<import("../api.js").GraphSeatData>>();
    for (const gn of graph?.nodes ?? []) if (gn.type === "rigNode" && gn.data) extra.set(gn.id, gn.data);
    const anchor = anchors[k]!;
    const color = RIG_COLORS[k % RIG_COLORS.length]!;
    const ids: string[] = [];
    seats.forEach((seat, j) => {
      const id = seat.canonicalSessionName;
      const g = extra.get(seat.nodeId) ?? {};
      const prev = previous.get(id);
      const a = (2 * Math.PI * j) / Math.max(1, seats.length);
      const working = recentlyWorking.has(id) || g.agentActivity?.state === "running" || seat.activityState?.display === "active";
      nodes.push({
        id, seat, rigId: r.rigId, rigName: r.name,
        tone: seatTone(seat), ctx: g.contextUsedPercentage ?? contextPercent(seat),
        working, needsInput: (seat.activityState?.needsInput.count ?? 0) > 0,
        activity: g.agentActivity?.evidence ?? null,
        inProgress: g.inProgressWorkCount ?? 0, pending: g.pendingWorkCount ?? 0, blocked: g.blockedWorkCount ?? 0,
        qitems: g.currentQitems ?? [],
        x: prev?.x ?? anchor.x + 40 * Math.cos(a), y: prev?.y ?? anchor.y + 40 * Math.sin(a),
        vx: prev?.vx ?? 0, vy: prev?.vy ?? 0, fx: prev?.fx ?? null, fy: prev?.fy ?? null,
      });
      ids.push(id);
      byNodeId.set(seat.nodeId, id);
    });
    outRigs.push({ rigId: r.rigId, name: r.name, color, anchor, nodeIds: ids });
    for (const e of graph?.edges ?? []) {
      const s = byNodeId.get(e.source), t = byNodeId.get(e.target);
      if (s && t && s !== t && (e.label === "delegates_to" || e.label === "can_observe")) links.push({ source: s, target: t, kind: e.label });
    }
  });
  return { rigs: outRigs, nodes, links };
}

export type Message = { from: string; to: string; kind: "new work" | "handoff" | "rerouted"; at: number; seq: number };

/** The events that are one seat talking to another; `at` is when this browser saw it (live) or when the daemon logged it (replay). */
export function messageOf(ev: RigEvent, clock: "seen" | "logged" = "seen"): Message | null {
  const s = (k: string) => (typeof ev[k] === "string" ? (ev[k] as string) : null);
  const at = clock === "seen" ? ev.seenAt : loggedAt(ev);
  if (at === null) return null;
  if (ev.type === "queue.created") {
    const from = s("sourceSession"), to = s("destinationSession");
    return from && to && from !== to ? { from, to, kind: "new work", at, seq: ev.seq } : null;
  }
  if (ev.type === "queue.handed_off" || ev.type === "qitem.fallback_routed") {
    const from = s("fromSession") ?? s("sourceSession"), to = s("toSession") ?? s("destinationSession");
    return from && to && from !== to ? { from, to, kind: ev.type === "queue.handed_off" ? "handoff" : "rerouted", at, seq: ev.seq } : null;
  }
  return null;
}

export function loggedAt(ev: RigEvent): number | null {
  const raw = (ev.createdAt ?? ev.at ?? ev.timestamp) as string | undefined;
  if (!raw) return null;
  const t = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? null : t;
}

/** Message counts per 30 s bucket over the last `minutes`, oldest first. */
export function histogram(messages: Message[], now: number, minutes = 30, bucketMs = 30_000): number[] {
  const n = Math.ceil((minutes * 60_000) / bucketMs);
  const out = new Array<number>(n).fill(0);
  const start = now - n * bucketMs;
  for (const m of messages) {
    // A message newer than `now` (the clock ticks every few seconds) lands in the newest bucket.
    const i = Math.min(n - 1, Math.floor((m.at - start) / bucketMs));
    if (i >= 0) out[i]!++;
  }
  return out;
}

/** A point along the same quadratic curve the renderer draws. */
export function curvePoint(a: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  const c = control(a, b);
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export function control(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const k = Math.min(40, len / 4);
  return { x: (a.x + b.x) / 2 - (dy / len) * k, y: (a.y + b.y) / 2 + (dx / len) * k };
}
