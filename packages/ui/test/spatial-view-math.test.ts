// Pure screen-space math behind the spatial renderer: tight framing, label
// collision layout and the scene budget. These prove the geometry decisions;
// real-pixel composition still needs a browser pass.

import { describe, it, expect } from "vitest";
import {
  LABEL_TIER,
  SPATIAL_SCENE_BUDGET,
  estimateLabelSize,
  frameBox,
  layoutLabels,
  leaderLine,
  sceneBudgetVerdict,
  nearestWithin,
  trafficPhase,
  trafficBeads,
  TRAFFIC_BEADS,
  TRAFFIC_TRAVEL_MS,
  TRAFFIC_TOTAL_MS,
  COMPACT_LABEL_MAX_WIDTH_PX,
  type LabelCandidate,
  type Rect,
} from "../src/components/topology/spatial/spatial-view-math.js";
import { SPATIAL_CAMERA_DIRECTIONS, fitDistance, type Vec3 } from "../src/lib/spatial-topology.js";

function project(p: Vec3, target: Vec3, dir: Vec3, distance: number, fovDeg: number, width: number, height: number) {
  // Camera at target + dir*distance looking at target; returns pixel coords.
  const cam: Vec3 = [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + dir[2] * distance];
  const f: Vec3 = [-dir[0], -dir[1], -dir[2]];
  const rRaw: Vec3 = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0];
  const rLen = Math.hypot(...rRaw) || 1;
  const r: Vec3 = rLen > 1e-9 ? [rRaw[0] / rLen, rRaw[1] / rLen, rRaw[2] / rLen] : [1, 0, 0];
  const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const q: Vec3 = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
  const depth = q[0] * f[0] + q[1] * f[1] + q[2] * f[2];
  const x = (q[0] * r[0] + q[1] * r[1] + q[2] * r[2]) / depth;
  const y = (q[0] * u[0] + q[1] * u[1] + q[2] * u[2]) / depth;
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * (width / height);
  return { px: (x / tanH + 1) * 0.5 * width, py: (1 - y / tanV) * 0.5 * height };
}

function corners(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

describe("frameBox", () => {
  const wideFlat = { min: [-60, -0.6, -20] as Vec3, max: [60, 5, 20] as Vec3 };
  const views = [
    { name: "desktop 1440x900 stage", width: 1030, height: 700 },
    { name: "tall 1440x1344 stage", width: 1030, height: 1150 },
    { name: "phone 390x844 stage", width: 358, height: 472 },
  ];

  for (const view of views) {
    it(`keeps every corner inside the inset viewport (${view.name})`, () => {
      const dir = SPATIAL_CAMERA_DIRECTIONS.iso;
      const insetX = 40;
      const insetY = 36;
      const { target, distance } = frameBox(wideFlat.min, wideFlat.max, dir, { width: view.width, height: view.height, fovDeg: 38, insetX, insetY });
      expect(Number.isFinite(distance)).toBe(true);
      const pts = corners(wideFlat.min, wideFlat.max).map((p) => project(p, target, dir, distance, 38, view.width, view.height));
      for (const p of pts) {
        expect(p.px).toBeGreaterThanOrEqual(insetX - 0.5);
        expect(p.px).toBeLessThanOrEqual(view.width - insetX + 0.5);
        expect(p.py).toBeGreaterThanOrEqual(insetY - 0.5);
        expect(p.py).toBeLessThanOrEqual(view.height - insetY + 0.5);
      }
      // Tight: the box spans most of the limiting axis instead of floating.
      const xs = pts.map((p) => p.px);
      const ys = pts.map((p) => p.py);
      const spanX = (Math.max(...xs) - Math.min(...xs)) / (view.width - insetX * 2);
      const spanY = (Math.max(...ys) - Math.min(...ys)) / (view.height - insetY * 2);
      expect(Math.max(spanX, spanY)).toBeGreaterThan(0.9);
    });
  }

  it("is closer than the bounding-sphere fit for a wide flat deck", () => {
    const { distance } = frameBox(wideFlat.min, wideFlat.max, SPATIAL_CAMERA_DIRECTIONS.iso, { width: 1030, height: 1150, fovDeg: 38 });
    const radius = Math.hypot(120, 5.6, 40) / 2;
    expect(distance).toBeLessThan(fitDistance(radius, 38, 1030 / 1150, 1.08));
  });

  it("handles the top view (direction parallel to world up) and degenerate input", () => {
    const top = frameBox(wideFlat.min, wideFlat.max, [0, 1, 0], { width: 800, height: 600, fovDeg: 38 });
    expect(Number.isFinite(top.distance)).toBe(true);
    expect(top.target.every(Number.isFinite)).toBe(true);
    const bad = frameBox([NaN, 0, 0], [1, 1, 1], [0, 0, 0], { width: 0, height: NaN, fovDeg: NaN });
    expect(Number.isFinite(bad.distance)).toBe(true);
    expect(bad.target.every(Number.isFinite)).toBe(true);
  });
});

function cand(id: string, x: number, y: number, tier: number, extra: Partial<LabelCandidate> = {}): LabelCandidate {
  return { id, x, y, w: 100, h: 30, cx: 0.5, cy: 1, tier, depth: 0, ...extra };
}

function boxOf(c: LabelCandidate, dx = 0): Rect {
  const left = c.x - c.cx * c.w + dx;
  const top = c.y - c.cy * c.h;
  return { left, top, right: left + c.w, bottom: top + c.h };
}

function overlap(a: Rect, b: Rect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("layoutLabels", () => {
  it("never shows two overlapping non-forced labels and keeps higher tiers", () => {
    const candidates = [
      cand("agent:a", 200, 200, LABEL_TIER.agent),
      cand("rig:r", 210, 205, LABEL_TIER.rig),
      cand("pod:p", 220, 190, LABEL_TIER.pod),
      cand("agent:urgent", 230, 210, LABEL_TIER.problem),
      cand("agent:far", 600, 300, LABEL_TIER.agent),
    ];
    const { visible, suppressed } = layoutLabels(candidates, { width: 800, height: 500 });
    expect(visible.has("agent:urgent")).toBe(true);
    expect(visible.has("agent:far")).toBe(true);
    expect(visible.has("agent:a")).toBe(false);
    expect(suppressed).toBe(3);
    const shown = candidates.filter((c) => visible.has(c.id)).map((c) => boxOf(c));
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(overlap(shown[i]!, shown[j]!)).toBe(false);
  });

  it("always shows forced (selected/hovered) labels, even off the edge, and others avoid them", () => {
    const { visible } = layoutLabels(
      [cand("agent:sel", 5, 10, LABEL_TIER.forced), cand("rig:r", 30, 15, LABEL_TIER.rig), cand("agent:x", 400, 200, LABEL_TIER.agent)],
      { width: 800, height: 500 },
    );
    expect(visible.has("agent:sel")).toBe(true);
    expect(visible.has("rig:r")).toBe(false);
    expect(visible.has("agent:x")).toBe(true);
  });

  it("respects occluders (camera HUD, legend) and the stage edge", () => {
    const hud: Rect = { left: 750, top: 10, right: 790, bottom: 200 };
    const { visible } = layoutLabels(
      [cand("agent:under-hud", 760, 100, LABEL_TIER.agent), cand("agent:clipped", 400, 10, LABEL_TIER.agent), cand("agent:ok", 400, 300, LABEL_TIER.agent)],
      { width: 800, height: 500, occluders: [hud] },
    );
    expect([...visible]).toEqual(["agent:ok"]);
  });

  it("slides clamped rig names inside the stage instead of clipping them", () => {
    const rig = cand("rig:edge", 760, 200, LABEL_TIER.rig, { cx: 0, cy: 0.5, w: 160, clampX: true });
    const { visible, offsets } = layoutLabels([rig], { width: 800, height: 500, edge: 4, gap: 2 });
    expect(visible.has("rig:edge")).toBe(true);
    const dx = offsets.get("rig:edge")!;
    expect(dx).toBeLessThan(0);
    const box = boxOf(rig, dx);
    expect(box.right).toBeLessThanOrEqual(800 - 4 + 2);
    // Anchor off-stage: not clamped onto the stage.
    const off = layoutLabels([cand("rig:off", 900, 200, LABEL_TIER.rig, { cx: 0, clampX: true })], { width: 800, height: 500 });
    expect(off.visible.size).toBe(0);
  });

  it("caps non-forced labels and stays bounded for thousands of candidates", () => {
    const many: LabelCandidate[] = [];
    for (let i = 0; i < 5000; i++) many.push(cand(`agent:${i}`, (i * 37) % 1400, (i * 53) % 900, LABEL_TIER.agent, { w: 20, h: 10 }));
    many.push(cand("agent:sel", 700, 450, LABEL_TIER.forced));
    const t0 = performance.now();
    const { visible, suppressed } = layoutLabels(many, { width: 1400, height: 900, maxVisible: 80 });
    const elapsed = performance.now() - t0;
    expect(visible.has("agent:sel")).toBe(true);
    expect(visible.size).toBe(81);
    expect(suppressed).toBe(5000 - 80);
    expect(elapsed).toBeLessThan(250);
  });

  it("falls back to an alternative anchor before giving up a label", () => {
    const seat = cand("agent:urgent", 300, 200, LABEL_TIER.problem);
    const rig = cand("rig:r", 290, 190, LABEL_TIER.rig, {
      cx: 0, cy: 0.5, clampX: true,
      alternatives: [{ x: 300, y: 260, cx: 0, cy: 0.5 }],
    });
    const { visible, choice } = layoutLabels([rig, seat], { width: 800, height: 500 });
    expect(visible.has("agent:urgent")).toBe(true);
    expect(visible.has("rig:r")).toBe(true);
    expect(choice.get("rig:r")).toBe(1);
    expect(choice.get("agent:urgent")).toBe(0);
  });

  it("is deterministic and drops non-finite projections", () => {
    const input = [cand("agent:b", 300, 200, LABEL_TIER.agent), cand("agent:a", 305, 202, LABEL_TIER.agent), cand("agent:nan", NaN, 1, LABEL_TIER.forced)];
    const one = layoutLabels(input, { width: 800, height: 500 });
    const two = layoutLabels([...input].reverse(), { width: 800, height: 500 });
    expect([...one.visible]).toEqual(["agent:a"]);
    expect([...two.visible]).toEqual(["agent:a"]);
  });
});

describe("estimateLabelSize", () => {
  it("grows with text and has finite, positive boxes for every kind", () => {
    for (const kind of ["rig", "pod", "agent"] as const) {
      const short = estimateLabelSize(kind, "ab", "x");
      const long = estimateLabelSize(kind, "a-much-longer-seat-name", "x");
      expect(short.w).toBeGreaterThan(0);
      expect(short.h).toBeGreaterThan(0);
      expect(long.w).toBeGreaterThan(short.w);
    }
  });
});

describe("sceneBudgetVerdict", () => {
  it("rejects scenes above the seat or link budget", () => {
    const base = { rigs: 1, pods: 1, agents: 10, edges: 10 };
    expect(sceneBudgetVerdict(base).withinBudget).toBe(true);
    expect(sceneBudgetVerdict({ ...base, agents: SPATIAL_SCENE_BUDGET.seats }).withinBudget).toBe(true);
    expect(sceneBudgetVerdict({ ...base, agents: SPATIAL_SCENE_BUDGET.seats + 1 }).withinBudget).toBe(false);
    expect(sceneBudgetVerdict({ ...base, edges: SPATIAL_SCENE_BUDGET.links + 1 }).withinBudget).toBe(false);
  });
});

// Phone/compact density: one-line seat names and quieter rig/pod names, so a
// 430px stage keeps the actual scene visible. Sizes are estimates the
// collision pass relies on; they must shrink for compact and stay positive.
describe("compact label density", () => {
  it("compact boxes are smaller than full ones for every kind, and a seat name drops its status line", () => {
    for (const kind of ["rig", "pod", "agent"] as const) {
      const full = estimateLabelSize(kind, "coordinator", "running · 2 pending");
      const compact = estimateLabelSize(kind, "coordinator", null, "compact");
      expect(compact.w).toBeGreaterThan(0);
      expect(compact.h).toBeGreaterThan(0);
      expect(compact.w * compact.h).toBeLessThan(full.w * full.h);
    }
    const nameOnly = estimateLabelSize("agent", "coordinator", null, "compact");
    const withStatus = estimateLabelSize("agent", "coordinator", "needs input", "compact");
    expect(nameOnly.h).toBeLessThan(withStatus.h);
  });

  it("caps a compact seat name's width (the full name stays in the card and index)", () => {
    const long = estimateLabelSize("agent", "x".repeat(120), null, "compact");
    expect(long.w).toBeLessThanOrEqual(COMPACT_LABEL_MAX_WIDTH_PX);
  });
});

describe("nearestWithin (touch pick tolerance)", () => {
  const points = [
    { key: "a", x: 100, y: 100 },
    { key: "b", x: 130, y: 100 },
    { key: "c", x: 400, y: 300 },
  ];
  it("returns the closest point inside the radius", () => {
    expect(nearestWithin(points, 112, 100, 24)).toBe("a");
    expect(nearestWithin(points, 120, 101, 24)).toBe("b");
  });
  it("returns null when nothing is within the radius (an empty-space tap still clears)", () => {
    expect(nearestWithin(points, 250, 200, 24)).toBeNull();
  });
  it("breaks an exact tie by key, deterministically", () => {
    expect(nearestWithin([{ key: "z", x: 0, y: 0 }, { key: "m", x: 20, y: 0 }], 10, 0, 24)).toBe("m");
  });
  it("ignores non-finite projections", () => {
    expect(nearestWithin([{ key: "a", x: Number.NaN, y: 0 }], 0, 0, 24)).toBeNull();
  });
});

describe("trafficPhase (real activity arcs)", () => {
  const T0 = 1_760_000_000_000;
  it("travels from sender to receiver over the travel time, then fades, then is gone", () => {
    const start = trafficPhase(T0, T0, false);
    expect(start.visible && start.headVisible).toBe(true);
    expect(start.head).toBe(0);
    const mid = trafficPhase(T0 + TRAFFIC_TRAVEL_MS / 2, T0, false);
    expect(mid.head).toBeCloseTo(0.5, 5);
    expect(mid.trailTo).toBe(mid.head);
    const arrived = trafficPhase(T0 + TRAFFIC_TRAVEL_MS + 1, T0, false);
    expect(arrived.headVisible).toBe(false);
    expect(arrived.arrival).toBeGreaterThan(0.9);
    const late = trafficPhase(T0 + TRAFFIC_TOTAL_MS - 10, T0, false);
    expect(late.alpha).toBeLessThan(0.05);
    expect(trafficPhase(T0 + TRAFFIC_TOTAL_MS, T0, false).visible).toBe(false);
  });
  it("a record older than the window never animates (cached / replayed events)", () => {
    expect(trafficPhase(T0 + 60_000, T0, false).visible).toBe(false);
    expect(trafficPhase(T0 + 60_000, T0, true).visible).toBe(false);
  });
  it("a future timestamp (clock skew) starts now instead of waiting", () => {
    const p = trafficPhase(T0, T0 + 5_000, false);
    expect(p.visible).toBe(true);
    expect(p.head).toBe(0);
  });
  it("reduced motion shows the whole arc and arrival statically, for the same window", () => {
    const a = trafficPhase(T0 + 100, T0, true);
    const b = trafficPhase(T0 + 3_000, T0, true);
    expect(a).toEqual(b);
    expect(a.headVisible).toBe(false);
    expect([a.trailFrom, a.trailTo]).toEqual([0, 1]);
  });
  it("non-finite times are invisible", () => {
    expect(trafficPhase(Number.NaN, T0, false).visible).toBe(false);
  });
});

// Labels never cover a figure: projected silhouettes are hard space. A
// selected (forced) label crowded by other labels still moves to an anchor
// clear of figures rather than sitting on one.
describe("layoutLabels silhouettes", () => {
  const box = (id: string, x: number, y: number, tier: number, alternatives?: LabelCandidate["alternatives"]): LabelCandidate =>
    ({ id, x, y, w: 80, h: 16, cx: 0.5, cy: 0.5, tier, depth: 0, ...(alternatives ? { alternatives } : {}) });
  const figure: Rect = { left: 160, top: 100, right: 240, bottom: 200 };

  it("an ambient label over a figure is suppressed or moved to a clear anchor", () => {
    const over = layoutLabels([box("a", 200, 150, LABEL_TIER.agent)], { width: 800, height: 500, silhouettes: [figure] });
    expect(over.visible.has("a")).toBe(false);
    const moved = layoutLabels([box("a", 200, 150, LABEL_TIER.agent, [{ x: 200, y: 220, cx: 0.5, cy: 0.5 }])], { width: 800, height: 500, silhouettes: [figure] });
    expect(moved.visible.has("a")).toBe(true);
    expect(moved.choice.get("a")).toBe(1);
  });

  it("a forced label whose primary anchor covers a figure takes the clear alternative, even when a label crowds it", () => {
    const crowd = box("crowd", 200, 60, LABEL_TIER.problem);
    const selected = box("sel", 200, 150, LABEL_TIER.forced, [{ x: 200, y: 70, cx: 0.5, cy: 0.5 }]);
    const r = layoutLabels([selected, crowd], { width: 800, height: 500, silhouettes: [figure] });
    expect(r.visible.has("sel")).toBe(true);
    expect(r.choice.get("sel")).toBe(1); // above the figure, beside a crowded label, never on the body
  });

  it("with no clear anchor at all, a forced label still shows (primary)", () => {
    const r = layoutLabels([box("sel", 200, 150, LABEL_TIER.forced)], { width: 800, height: 500, silhouettes: [figure] });
    expect(r.visible.has("sel")).toBe(true);
    expect(r.choice.get("sel")).toBe(0);
  });
});

describe("trafficBeads (travelling sparks)", () => {
  const T0 = 1_760_000_000_000;
  it("trail behind the head while travelling: ordered, spaced, shrinking and dimming, inside the visible trail", () => {
    const phase = trafficPhase(T0 + TRAFFIC_TRAVEL_MS * 0.6, T0, false);
    const beads = trafficBeads(phase);
    expect(beads.length).toBeGreaterThan(0);
    expect(beads.length).toBeLessThanOrEqual(TRAFFIC_BEADS);
    let previous = { t: phase.head, size: 1.01, intensity: 1.01 };
    for (const b of beads) {
      expect(b.t).toBeLessThan(previous.t);
      expect(b.t).toBeGreaterThanOrEqual(phase.trailFrom);
      expect(b.size).toBeLessThan(previous.size);
      expect(b.intensity).toBeLessThan(previous.intensity);
      previous = b;
    }
  });
  it("none at the very start (no trail yet), after arrival, under reduced motion, or when invisible", () => {
    expect(trafficBeads(trafficPhase(T0, T0, false))).toEqual([]);
    expect(trafficBeads(trafficPhase(T0 + TRAFFIC_TRAVEL_MS + 10, T0, false))).toEqual([]);
    expect(trafficBeads(trafficPhase(T0 + 500, T0, true))).toEqual([]);
    expect(trafficBeads(trafficPhase(T0 + TRAFFIC_TOTAL_MS, T0, false))).toEqual([]);
  });
});

describe("layoutLabels relocation (plan-view seat names)", () => {
  const rect = (c: LabelCandidate, s = { dx: 0, dy: 0 }): Rect => {
    const b = boxOf(c);
    return { left: b.left + s.dx, top: b.top + s.dy, right: b.right + s.dx, bottom: b.bottom + s.dy };
  };
  const hit = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  it("moves a colliding relocatable name to the nearest free spot instead of suppressing it", () => {
    const first = cand("agent:a", 300, 200, LABEL_TIER.match);
    const second = cand("agent:b", 310, 205, LABEL_TIER.match, { relocate: true });
    const blocker: Rect = { left: 240, top: 210, right: 380, bottom: 260 };
    const { visible, shifts, choice, suppressed } = layoutLabels([first, second], { width: 800, height: 500, silhouettes: [blocker] });
    expect([...visible].sort()).toEqual(["agent:a", "agent:b"]);
    expect(suppressed).toBe(0);
    expect(choice.get("agent:b")).toBe(0);
    const moved = rect(second, shifts.get("agent:b"));
    expect(hit(moved, rect(first))).toBe(false);
    expect(hit(moved, blocker)).toBe(false);
    expect(Math.hypot(shifts.get("agent:b")!.dx, shifts.get("agent:b")!.dy)).toBeLessThan(60);
  });

  it("leaves non-relocatable labels (angled view) suppressed, and stops at the probe budget", () => {
    const a = cand("agent:a", 300, 200, LABEL_TIER.match);
    expect(layoutLabels([a, cand("agent:b", 310, 205, LABEL_TIER.match)], { width: 800, height: 500 }).visible.has("agent:b")).toBe(false);
    const capped = layoutLabels([a, cand("agent:b", 310, 205, LABEL_TIER.match, { relocate: true })], { width: 800, height: 500, relocateBudget: 0 });
    expect(capped.visible.has("agent:b")).toBe(false);
    expect(capped.suppressed).toBe(1);
  });

  it("draws a leader from the moved box edge back to the anchor, none for a box still on it", () => {
    // Anchor at the box's top centre; box moved 40px down.
    const line = leaderLine({ w: 80, h: 16, cx: 0.5, cy: 0 }, 0, 40)!;
    expect(line).toEqual({ x: 40, y: 0, length: 40, angle: Math.round(-Math.PI / 2 * 1000) / 1000 });
    expect(leaderLine({ w: 80, h: 16, cx: 0.5, cy: 0 }, 2, 2)).toBeNull();
  });
});

describe("layoutLabels relocation bounds", () => {
  it("never pulls an off-screen seat's name into view", () => {
    const off = cand("agent:off", -40, 200, LABEL_TIER.match, { relocate: true });
    const result = layoutLabels([off], { width: 800, height: 500 });
    expect(result.visible.has("agent:off")).toBe(false);
    expect(result.shifts.size).toBe(0);
  });
});
