// Canvas renderer for the fleet map. Everything here is a pure function of a
// Scene; the view owns the animation loop and the input.
import { shortModel } from "../model.js";
import { control, curvePoint, type GNode, type GRig, type Message, type Model } from "./model.js";

export type View = { x: number; y: number; k: number };
export type Theme = {
  bg: string; panel: string; line: string; text: string; muted: string; accent: string;
  ok: string; busy: string; warn: string; bad: string; off: string; light: boolean;
};
export type Scene = {
  model: Model;
  messages: Message[];
  now: number;
  selected: string | null;
  hovered: string | null;
  view: View;
  width: number;
  height: number;
  dpr: number;
  motion: boolean;
  theme: Theme;
};

export const PULSE_MS = 1800;
export const TRAFFIC_MS = 90_000;
const TRAIL = 12;
const NODE_R = 9;

export function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bg: v("--bg"), panel: v("--panel"), line: v("--line"), text: v("--text"), muted: v("--muted"), accent: v("--accent"),
    ok: v("--c-ok"), busy: v("--c-busy"), warn: v("--c-warn"), bad: v("--c-bad"), off: v("--c-off"),
    light: cs.getPropertyValue("color-scheme").trim() === "light",
  };
}

const KIND_COLOR: Record<Message["kind"], string> = { "new work": "#5aa9ff", handoff: "#b48cff", rerouted: "#f0a35e" };

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function rgba(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0) / 4294967295;
}

export function toneColor(t: Theme, tone: GNode["tone"]): string {
  return tone === "ok" ? t.ok : tone === "busy" ? t.busy : tone === "warn" ? t.warn : tone === "bad" ? t.bad : t.off;
}

export type Traffic = { a: GNode; b: GNode; count: number; last: number; kind: Message["kind"] };

/** Live pulses and 90 s traffic from the message list, resolved to nodes. */
export function signals(model: Model, messages: Message[], now: number): { pulses: (Message & { a: GNode; b: GNode; t: number })[]; traffic: Traffic[] } {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const pulses: (Message & { a: GNode; b: GNode; t: number })[] = [];
  const traffic = new Map<string, Traffic>();
  for (const m of messages) {
    const age = now - m.at;
    if (age < 0 || age > TRAFFIC_MS) continue;
    const a = byId.get(m.from), b = byId.get(m.to);
    if (!a || !b) continue;
    if (age <= PULSE_MS) pulses.push({ ...m, a, b, t: age / PULSE_MS });
    const key = `${m.from}→${m.to}`;
    const cur = traffic.get(key);
    if (cur) { cur.count++; if (m.at > cur.last) { cur.last = m.at; cur.kind = m.kind; } }
    else traffic.set(key, { a, b, count: 1, last: m.at, kind: m.kind });
  }
  return { pulses, traffic: [...traffic.values()] };
}

function neighbourhood(model: Model, traffic: Traffic[], id: string | null): Set<string> | null {
  if (!id) return null;
  const set = new Set([id]);
  for (const l of model.links) {
    const s = typeof l.source === "string" ? l.source : l.source.id;
    const t = typeof l.target === "string" ? l.target : l.target.id;
    if (s === id) set.add(t);
    if (t === id) set.add(s);
  }
  for (const tr of traffic) { if (tr.a.id === id) set.add(tr.b.id); if (tr.b.id === id) set.add(tr.a.id); }
  return set;
}

export function draw(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { theme: T, view, width: W, height: H, dpr } = s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, W, H);

  // World-space dot grid, fading out when zoomed far away.
  const gridAlpha = Math.min(0.18, 0.05 + 0.1 * view.k) * (T.light ? 1.6 : 1);
  if (view.k > 0.3) {
    const step = 48;
    const x0 = Math.floor(-view.x / view.k / step) * step, x1 = (W - view.x) / view.k;
    const y0 = Math.floor(-view.y / view.k / step) * step, y1 = (H - view.y) / view.k;
    ctx.fillStyle = rgba(T.text, gridAlpha);
    for (let gx = x0; gx < x1; gx += step) for (let gy = y0; gy < y1; gy += step) {
      ctx.fillRect(gx * view.k + view.x - 0.5, gy * view.k + view.y - 0.5, 1, 1);
    }
  }
  // Vignette.
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, T.light ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.45)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  const { pulses, traffic } = signals(s.model, s.messages, s.now);
  const focus = neighbourhood(s.model, traffic, s.selected);
  const nodeById = new Map(s.model.nodes.map((n) => [n.id, n]));
  const rigOf = new Map<string, GRig>();
  for (const r of s.model.rigs) for (const id of r.nodeIds) rigOf.set(id, r);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  // Rig territories: soft additive glow around each seat in its rig's colour.
  ctx.globalCompositeOperation = T.light ? "multiply" : "lighter";
  for (const n of s.model.nodes) {
    const r = rigOf.get(n.id);
    if (!r) continue;
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 70);
    g.addColorStop(0, rgba(r.color, T.light ? 0.12 : 0.11));
    g.addColorStop(1, rgba(r.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(n.x, n.y, 70, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // Delegation and observation links.
  for (const l of s.model.links) {
    const a = typeof l.source === "string" ? nodeById.get(l.source) : l.source;
    const b = typeof l.target === "string" ? nodeById.get(l.target) : l.target;
    if (!a || !b) continue;
    const dim = focus && !(focus.has(a.id) && focus.has(b.id));
    const c = control(a, b);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    ctx.setLineDash(l.kind === "can_observe" ? [3, 5] : []);
    ctx.strokeStyle = rgba(T.text, (l.kind === "can_observe" ? 0.1 : 0.2) * (dim ? 0.3 : 1));
    ctx.lineWidth = l.kind === "can_observe" ? 1 : 1.4;
    ctx.stroke();
    if (l.kind === "delegates_to") {
      // Arrow head at the target edge.
      const p = curvePoint(a, b, 0.86), q = curvePoint(a, b, 0.9);
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      const tip = curvePoint(a, b, 1 - (NODE_R + 6) / (Math.hypot(b.x - a.x, b.y - a.y) || 1));
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - 7 * Math.cos(ang - 0.45), tip.y - 7 * Math.sin(ang - 0.45));
      ctx.lineTo(tip.x - 7 * Math.cos(ang + 0.45), tip.y - 7 * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fillStyle = rgba(T.text, 0.25 * (dim ? 0.3 : 1));
      ctx.fill();
    }
  }
  ctx.setLineDash([]);

  // Recent traffic: weight by count, brightness by recency.
  for (const tr of traffic) {
    const recency = 1 - (s.now - tr.last) / TRAFFIC_MS;
    const dim = focus && !(focus.has(tr.a.id) && focus.has(tr.b.id));
    const c = control(tr.a, tr.b);
    ctx.beginPath(); ctx.moveTo(tr.a.x, tr.a.y); ctx.quadraticCurveTo(c.x, c.y, tr.b.x, tr.b.y);
    ctx.strokeStyle = rgba(KIND_COLOR[tr.kind], (0.18 + 0.5 * recency) * (dim ? 0.25 : 1));
    ctx.lineWidth = 1 + Math.min(4, Math.log2(tr.count + 1) * 1.4);
    ctx.lineCap = "round";
    ctx.stroke();
  }

  // Message comets.
  for (const p of pulses) {
    const col = KIND_COLOR[p.kind];
    const trail = s.motion ? TRAIL : 1;
    for (let i = trail - 1; i >= 0; i--) {
      const tt = ease(p.t) - i * 0.028;
      if (tt < 0) continue;
      const pt = curvePoint(p.a, p.b, tt);
      const f = 1 - i / trail;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 1 + 3.5 * f, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.15 + 0.7 * f);
      ctx.fill();
    }
    const head = curvePoint(p.a, p.b, ease(p.t));
    const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 18);
    g.addColorStop(0, rgba(col, 0.55)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(head.x, head.y, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(head.x, head.y, 2.6, 0, Math.PI * 2); ctx.fill();
    // Arrival flash on the receiving seat.
    if (p.t > 0.88) {
      const f = (p.t - 0.88) / 0.12;
      ctx.beginPath(); ctx.arc(p.b.x, p.b.y, NODE_R + 4 + 16 * f, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(col, (1 - f) * 0.8); ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // Seats.
  for (const n of s.model.nodes) {
    const dim = focus && !focus.has(n.id);
    ctx.globalAlpha = dim ? 0.28 : 1;
    const col = toneColor(T, n.tone);
    const breathe = n.working && s.motion ? 1.2 * Math.sin(s.now / 320 + hash(n.id) * 6.28) : 0;
    const r = NODE_R + breathe + (s.selected === n.id ? 1.5 : 0);
    if (n.working && s.motion) {
      for (let i = 0; i < 2; i++) {
        const phase = (s.now / 1700 + hash(n.id) + i * 0.5) % 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, NODE_R + 4 + 20 * phase, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(T.busy, (1 - phase) * 0.45); ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    if (n.needsInput) {
      const a = 0.55 + (s.motion ? 0.4 * Math.sin(s.now / 260) : 0.2);
      ctx.beginPath(); ctx.arc(n.x, n.y, NODE_R + 9, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(T.warn, a); ctx.lineWidth = 2.5; ctx.stroke();
    }
    if (n.ctx !== null) {
      const band = n.ctx >= 85 ? T.bad : n.ctx >= 60 ? T.warn : T.ok;
      ctx.beginPath(); ctx.arc(n.x, n.y, NODE_R + 5, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(T.text, 0.12); ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(n.x, n.y, NODE_R + 5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * n.ctx) / 100);
      ctx.strokeStyle = band; ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = T.bg; ctx.stroke();
    if (n.seat.runtime === "codex") { // a small core mark distinguishes the runtime at a glance
      ctx.beginPath(); ctx.arc(n.x, n.y, 3, 0, Math.PI * 2); ctx.fillStyle = rgba(T.bg, 0.55); ctx.fill();
    }
    if (n.blocked > 0) {
      ctx.beginPath(); ctx.arc(n.x + NODE_R, n.y - NODE_R, 4, 0, Math.PI * 2);
      ctx.fillStyle = T.bad; ctx.fill(); ctx.strokeStyle = T.bg; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (s.selected === n.id || s.hovered === n.id) {
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = s.selected === n.id ? T.text : rgba(T.text, 0.5); ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // Screen-space labels: rigs always, seats once zoomed in enough.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const label = (text: string, x: number, y: number, font: string, color: string) => {
    ctx.font = font;
    ctx.lineWidth = 3; ctx.strokeStyle = rgba(T.bg, 0.85); ctx.lineJoin = "round";
    ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
  };
  for (const rig of s.model.rigs) {
    const ns = rig.nodeIds.map((id) => nodeById.get(id)).filter(Boolean) as GNode[];
    if (ns.length === 0) continue;
    const cx = ns.reduce((a, n) => a + n.x, 0) / ns.length;
    const top = Math.min(...ns.map((n) => n.y));
    const sx = cx * view.k + view.x, sy = top * view.k + view.y - 30;
    const working = ns.filter((n) => n.working).length, needs = ns.filter((n) => n.tone === "warn").length;
    const big = view.k < 0.55;
    label(rig.name, sx, sy, `600 ${big ? 15 : 12.5}px ${FONT}`, rig.color);
    const parts = [`${ns.length} seat${ns.length === 1 ? "" : "s"}`];
    if (working) parts.push(`${working} working`);
    if (needs) parts.push(`${needs} need you`);
    label(parts.join(" · "), sx, sy + 14, `10.5px ${FONT}`, T.muted);
  }
  if (view.k >= 0.55) {
    // Labels are screen-sized while spacing is world-sized, so at low zoom they can collide.
    // Place them greedily: selected and hovered first, then working, then the rest; a label that
    // would overlap one already placed is skipped until the person zooms in.
    ctx.font = `12px ${MONO}`;
    const tiers = view.k >= 1.25 ? (view.k >= 1.8 ? 3 : 2) : 1;
    const boxH = 14 + (tiers - 1) * 12;
    const rank = (n: GNode) => (n.id === s.selected || n.id === s.hovered ? 0 : n.working || n.needsInput ? 1 : n.tone === "warn" ? 2 : 3);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const overlaps = (r: { x: number; y: number; w: number; h: number }) =>
      placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
    const ordered = [...s.model.nodes].sort((a, b) => rank(a) - rank(b));
    for (const n of ordered) {
      const dim = focus && !focus.has(n.id);
      const sx = n.x * view.k + view.x, sy = n.y * view.k + view.y + (NODE_R + 8) * view.k + 12;
      const w = ctx.measureText(n.seat.logicalId).width + 8;
      const box = { x: sx - w / 2, y: sy - 11, w, h: boxH };
      if (rank(n) > 0 && overlaps(box)) continue;
      placed.push(box);
      label(n.seat.logicalId, sx, sy, `12px ${MONO}`, rgba(T.text, dim ? 0.35 : 0.92));
      if (tiers >= 2) {
        const bits = [n.seat.runtime ?? "", shortModel(n.seat.model)].filter(Boolean);
        if (n.ctx !== null) bits.push(`${n.ctx}%`);
        label(bits.join(" · "), sx, sy + 12, `10.5px ${FONT}`, rgba(T.muted, dim ? 0.4 : 1));
        if (tiers >= 3 && n.activity) label(n.activity.slice(0, 36), sx, sy + 24, `10.5px ${FONT}`, rgba(T.busy, dim ? 0.4 : 0.95));
      }
    }
  }
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

export function hitTest(model: Model, view: View, sx: number, sy: number): GNode | null {
  const wx = (sx - view.x) / view.k, wy = (sy - view.y) / view.k;
  const reach = Math.max(16, 16 / view.k);
  let best: GNode | null = null, bd = reach;
  for (const n of model.nodes) {
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

export function fitView(nodes: { x: number; y: number }[], width: number, height: number, pad = 70, maxK = 1.6): View {
  if (nodes.length === 0 || width === 0 || height === 0) return { x: width / 2, y: height / 2, k: 1 };
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + 40, minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 50;
  const k = Math.max(0.2, Math.min(maxK, (width - 2 * pad) / Math.max(1, maxX - minX), (height - 2 * pad) / Math.max(1, maxY - minY)));
  return { k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k };
}
