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
  sceneBudgetVerdict,
  nearestWithin,
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
