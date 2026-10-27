// Pure layout and event logic for the Graph screen.
import type { SeatNode } from "./api.js";
import type { RigEvent } from "./events.js";

export type Point = { x: number; y: number };
export type Cluster = { rigId: string; name: string; x: number; y: number; w: number; h: number };
export type Layout = { clusters: Cluster[]; nodes: Map<string, Point & { seat: SeatNode }>; width: number; height: number };

const PAD = 16;
const GAP = 14;
const TITLE = 26;
const LABEL = 22;

/** Each rig is a ring of seats inside a box; boxes flow left to right and wrap at `width`. */
export function layoutFleet(rigs: { rigId: string; name: string; seats: SeatNode[] }[], width: number): Layout {
  const clusters: Cluster[] = [];
  const nodes = new Map<string, Point & { seat: SeatNode }>();
  let x = 0, y = 0, rowH = 0;
  for (const rig of rigs) {
    const n = Math.max(1, rig.seats.length);
    const r = n === 1 ? 0 : Math.min(150, 34 + n * 13);
    const w = Math.max(170, 2 * r + 2 * PAD + 80);
    const h = TITLE + 2 * r + 2 * PAD + LABEL + 10;
    if (x > 0 && x + w > width) { x = 0; y += rowH + GAP; rowH = 0; }
    const c = { rigId: rig.rigId, name: rig.name, x, y, w, h };
    clusters.push(c);
    const cx = x + w / 2, cy = y + TITLE + PAD + r + 4;
    rig.seats.forEach((seat, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      nodes.set(seat.canonicalSessionName, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), seat });
    });
    x += w + GAP;
    rowH = Math.max(rowH, h);
  }
  return { clusters, nodes, width, height: y + rowH };
}

export type Message = { from: string; to: string; kind: string };

/** The events that are one seat talking to another. */
export function messageOf(ev: RigEvent): Message | null {
  const s = (k: string) => (typeof ev[k] === "string" ? (ev[k] as string) : null);
  if (ev.type === "queue.created") {
    const from = s("sourceSession"), to = s("destinationSession");
    return from && to && from !== to ? { from, to, kind: "new work" } : null;
  }
  if (ev.type === "queue.handed_off" || ev.type === "qitem.fallback_routed") {
    const from = s("fromSession") ?? s("sourceSession"), to = s("toSession") ?? s("destinationSession");
    return from && to && from !== to ? { from, to, kind: ev.type === "queue.handed_off" ? "handoff" : "rerouted" } : null;
  }
  return null;
}

/** Seats whose runtime hook said "running" recently. */
export function workingSession(ev: RigEvent): string | null {
  if (ev.type !== "agent.activity") return null;
  const act = ev.activity as { state?: string } | undefined;
  const session = ev.sessionName;
  return act?.state === "running" && typeof session === "string" ? session : null;
}

/** A gentle curve between two points so parallel edges and self-cluster edges stay readable. */
export function curve(a: Point, b: Point): string {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const k = Math.min(40, len / 4);
  return `M ${a.x} ${a.y} Q ${mx - (dy / len) * k} ${my + (dx / len) * k} ${b.x} ${b.y}`;
}
