// Pure screen-space math for the spatial renderer: tight camera framing,
// bounded label collision layout, and the scene budget. No three import, so
// it is unit-testable and the decisions the renderer makes are inspectable.

import type { SpatialModel, Vec3 } from "../../../lib/spatial-topology.js";

// ---------------------------------------------------------------------------
// Scene budget
// ---------------------------------------------------------------------------

/** Above these counts the 3D scene is not mounted; the full topology stays in
 *  the seat index / list (all seats searchable and selectable) and each rig
 *  remains openable in its own, smaller scene. Bounds mesh, material and
 *  label DOM work instead of silently thinning seats out of the scene. */
export const SPATIAL_SCENE_BUDGET = { seats: 400, links: 1200 } as const;

export interface SpatialBudgetVerdict {
  withinBudget: boolean;
  seats: number;
  links: number;
}

export function sceneBudgetVerdict(counts: SpatialModel["counts"]): SpatialBudgetVerdict {
  const seats = counts.agents;
  const links = counts.edges;
  return {
    withinBudget: seats <= SPATIAL_SCENE_BUDGET.seats && links <= SPATIAL_SCENE_BUDGET.links,
    seats,
    links,
  };
}

// ---------------------------------------------------------------------------
// Camera framing
// ---------------------------------------------------------------------------

type V = [number, number, number];

function sub(a: Vec3, b: Vec3): V {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): V {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(a: Vec3, fallback: V): V {
  const len = Math.hypot(a[0], a[1], a[2]);
  return Number.isFinite(len) && len > 1e-9 ? [a[0] / len, a[1] / len, a[2] / len] : fallback;
}

export interface FramingViewport {
  width: number;
  height: number;
  fovDeg: number;
  /** Pixels kept clear on the left/right and top/bottom edges (labels, HUD). */
  insetX?: number;
  insetY?: number;
}

export interface Framing {
  target: Vec3;
  distance: number;
}

/**
 * Tight perspective framing of an axis-aligned box seen along `direction`
 * (unit vector from target toward camera). Unlike a bounding-sphere fit this
 * projects the eight corners, recentres the target on their projected extent
 * and solves the minimum distance at which every corner lies inside the
 * (inset) frustum — so wide, flat rig decks fill the viewport instead of
 * sitting in a sea of empty stage.
 */
export function frameBox(min: Vec3, max: Vec3, direction: Vec3, view: FramingViewport, minDistance = 6): Framing {
  const finiteBox = [...min, ...max].every(Number.isFinite);
  const lo: Vec3 = finiteBox ? min : [-10, -1, -10];
  const hi: Vec3 = finiteBox ? max : [10, 4, 10];
  const d = unit(direction, [0, 1, 0]);
  const forward: V = [-d[0], -d[1], -d[2]];
  // Camera "right" from forward × world-up; looking straight down falls back to +X.
  const right = unit(cross(forward, [0, 1, 0]), [1, 0, 0]);
  const up = unit(cross(right, forward), [0, 0, -1]);

  const center: V = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const corners: Vec3[] = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);

  const rel = corners.map((p) => {
    const q = sub(p, center);
    return { x: dot(q, right), y: dot(q, up), z: dot(q, d) };
  });

  const width = Number.isFinite(view.width) && view.width > 0 ? view.width : 1;
  const height = Number.isFinite(view.height) && view.height > 0 ? view.height : 1;
  const fov = Number.isFinite(view.fovDeg) ? Math.min(Math.max(view.fovDeg, 10), 120) : 40;
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * (width / height);
  const fracX = Math.min(0.35, Math.max(0, (view.insetX ?? 0) / width));
  const fracY = Math.min(0.35, Math.max(0, (view.insetY ?? 0) / height));
  const effH = tanH * (1 - 2 * fracX);
  const effV = tanV * (1 - 2 * fracY);

  // Start from the orthographic centre of the projected extent, then correct
  // for perspective (near corners project larger) with a few fixed-point
  // passes: solve the distance, measure the projected extent's midpoint, and
  // move the target to it. Bounded and deterministic.
  let offX = 0;
  let offY = 0;
  {
    let lo = Infinity, hi = -Infinity, bot = Infinity, top = -Infinity;
    for (const p of rel) {
      lo = Math.min(lo, p.x); hi = Math.max(hi, p.x);
      bot = Math.min(bot, p.y); top = Math.max(top, p.y);
    }
    offX = (lo + hi) / 2;
    offY = (bot + top) / 2;
  }
  const solve = (ox: number, oy: number) => {
    let dist = minDistance;
    for (const p of rel) {
      dist = Math.max(dist, p.z + Math.abs(p.x - ox) / effH, p.z + Math.abs(p.y - oy) / effV);
    }
    return dist;
  };
  let distance = solve(offX, offY);
  for (let pass = 0; pass < 4 && Number.isFinite(distance); pass++) {
    let lo = Infinity, hi = -Infinity, bot = Infinity, top = -Infinity;
    for (const p of rel) {
      const depth = Math.max(distance - p.z, 1e-6);
      const sx = (p.x - offX) / depth;
      const sy = (p.y - offY) / depth;
      lo = Math.min(lo, sx); hi = Math.max(hi, sx);
      bot = Math.min(bot, sy); top = Math.max(top, sy);
    }
    offX += ((lo + hi) / 2) * distance;
    offY += ((bot + top) / 2) * distance;
    distance = solve(offX, offY);
  }
  if (!Number.isFinite(distance)) {
    distance = 60;
    offX = 0;
    offY = 0;
  }
  const target: Vec3 = [
    center[0] + right[0] * offX + up[0] * offY,
    center[1] + right[1] * offX + up[1] * offY,
    center[2] + right[2] * offX + up[2] * offY,
  ];
  return { target, distance };
}

// ---------------------------------------------------------------------------
// Label collision layout
// ---------------------------------------------------------------------------

export type LabelKind = "rig" | "pod" | "agent";

/** Lower tier wins placement. Forced labels are always shown. */
export const LABEL_TIER = {
  forced: 0,
  problem: 1,
  match: 2,
  rig: 3,
  pod: 4,
  agent: 5,
} as const;

export interface LabelCandidate {
  id: string;
  /** Anchor in viewport pixels (origin top-left). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** CSS2DObject.center semantics: 0..1 fraction of the box at the anchor. */
  cx: number;
  cy: number;
  tier: number;
  /** Lower depth (closer to camera) wins ties inside a tier. */
  depth: number;
  /** Slide horizontally inside the viewport instead of clipping (rig/pod
   *  names), as long as the anchor itself is on screen. */
  clampX?: boolean;
  /** Fallback anchors tried in order when the primary one does not fit
   *  (e.g. a seat name hanging below its puck instead of above it). */
  alternatives?: ReadonlyArray<LabelAnchor>;
}

export interface LabelAnchor {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LabelLayoutOptions {
  width: number;
  height: number;
  /** Viewport regions already occupied (camera HUD, legend). */
  occluders?: readonly Rect[];
  /** Kept clear between labels, px. */
  gap?: number;
  /** Margin from the viewport edge a non-forced label must respect, px. */
  edge?: number;
  /** Hard cap on non-forced labels shown at once (bounds DOM work). */
  maxVisible?: number;
}

export interface LabelLayoutResult {
  visible: Set<string>;
  /** Index of the anchor used per visible label: 0 = primary, n = alternatives[n-1]. */
  choice: Map<string, number>;
  /** Horizontal pixel shift applied to clamped labels (only non-zero entries). */
  offsets: Map<string, number>;
  /** Candidates suppressed by collision, viewport edge, occluders or the cap. */
  suppressed: number;
}

const CELL = 64;

function rectOf(c: { w: number; h: number }, a: LabelAnchor, gap: number): Rect {
  const left = a.x - a.cx * c.w - gap;
  const top = a.y - a.cy * c.h - gap;
  return { left, top, right: left + c.w + gap * 2, bottom: top + c.h + gap * 2 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Greedy, deterministic screen-space placement. Candidates are taken in
 * (tier, depth, id) order; each is shown only if its box stays inside the
 * viewport and clear of occluders and every already-placed box. Forced labels
 * (selected / hovered) are placed first and always shown. A uniform grid
 * keeps the overlap test near-linear, so cost is bounded by the candidate
 * count rather than quadratic in it.
 */
export function layoutLabels(candidates: readonly LabelCandidate[], options: LabelLayoutOptions): LabelLayoutResult {
  const gap = options.gap ?? 2;
  const edge = options.edge ?? 4;
  const maxVisible = options.maxVisible ?? 80;
  const order = [...candidates].sort(
    (a, b) => a.tier - b.tier || a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const grid = new Map<string, Rect[]>();
  const cellsOf = (r: Rect): string[] => {
    const keys: string[] = [];
    const x0 = Math.floor(r.left / CELL), x1 = Math.floor(r.right / CELL);
    const y0 = Math.floor(r.top / CELL), y1 = Math.floor(r.bottom / CELL);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) keys.push(`${gx}:${gy}`);
    return keys;
  };
  const occupy = (r: Rect) => {
    for (const k of cellsOf(r)) {
      const bucket = grid.get(k);
      if (bucket) bucket.push(r);
      else grid.set(k, [r]);
    }
  };
  const collides = (r: Rect) => cellsOf(r).some((k) => grid.get(k)?.some((o) => overlaps(o, r)) ?? false);

  for (const occluder of options.occluders ?? []) occupy(occluder);

  const visible = new Set<string>();
  const offsets = new Map<string, number>();
  const choice = new Map<string, number>();
  const inside = (r: Rect) => r.left >= edge - gap && r.top >= edge - gap
    && r.right <= options.width - edge + gap && r.bottom <= options.height - edge + gap;
  const clamp = (c: LabelCandidate, a: LabelAnchor, r: Rect): number => {
    if (!c.clampX || a.x < edge || a.x > options.width - edge) return 0;
    let dx = 0;
    if (r.left < edge - gap) dx = edge - gap - r.left;
    else if (r.right > options.width - edge + gap) dx = options.width - edge + gap - r.right;
    r.left += dx;
    r.right += dx;
    return dx;
  };
  let shown = 0;
  let suppressed = 0;
  for (const c of order) {
    const anchors: LabelAnchor[] = [{ x: c.x, y: c.y, cx: c.cx, cy: c.cy }, ...(c.alternatives ?? [])]
      .filter((a) => [a.x, a.y, a.cx, a.cy].every(Number.isFinite));
    if (anchors.length === 0 || !Number.isFinite(c.w) || !Number.isFinite(c.h)) {
      suppressed++;
      continue;
    }
    const forced = c.tier === LABEL_TIER.forced;
    if (!forced && shown >= maxVisible) {
      suppressed++;
      continue;
    }
    let placed: { index: number; rect: Rect; dx: number } | null = null;
    for (let i = 0; i < anchors.length && !placed; i++) {
      const r = rectOf(c, anchors[i]!, gap);
      const dx = clamp(c, anchors[i]!, r);
      if (inside(r) && !collides(r)) placed = { index: i, rect: r, dx };
    }
    if (!placed && forced) {
      // Selected/hovered always show: primary anchor even if crowded.
      const r = rectOf(c, anchors[0]!, gap);
      placed = { index: 0, rect: r, dx: clamp(c, anchors[0]!, r) };
    }
    if (!placed) {
      suppressed++;
      continue;
    }
    visible.add(c.id);
    choice.set(c.id, placed.index);
    if (placed.dx !== 0) offsets.set(c.id, placed.dx);
    occupy(placed.rect);
    if (!forced) shown++;
  }
  return { visible, choice, offsets, suppressed };
}

/**
 * Label box estimate from text length. The labels are set in JetBrains Mono
 * (advance 0.6em), so character counts give stable widths without forcing a
 * DOM layout read every frame. Sizes mirror spatial.css.
 */
export function estimateLabelSize(kind: LabelKind, text: string, meta: string | null): { w: number; h: number } {
  const len = (s: string | null) => (s ? [...s].length : 0);
  if (kind === "rig") {
    // 11px uppercase, 0.14em tracking; meta 9px, 0.08em; padding 7+8, border 2.
    const w = Math.max(len(text) * (11 * 0.74), len(meta) * (9 * 0.68)) + 17;
    return { w: Math.ceil(w), h: meta ? 32 : 20 };
  }
  if (kind === "pod") {
    // Single line: name (10px, 0.04em) + " · " + meta (9px); padding 6+6.
    const w = len(text) * (10 * 0.64) + (meta ? (len(meta) + 3) * (9 * 0.64) : 0) + 12;
    return { w: Math.ceil(w), h: 16 };
  }
  // Agent: name 10.5px over meta 9px; padding 14 + 6, border 2.
  const w = Math.max(len(text) * (10.5 * 0.6), len(meta) * (9 * 0.64)) + 22;
  return { w: Math.ceil(w), h: meta ? 32 : 19 };
}
