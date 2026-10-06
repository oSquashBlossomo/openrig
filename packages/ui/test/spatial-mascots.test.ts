// Seat figures: routing comes only from the configured runtime and node kind;
// each figure is real merged geometry (not a puck) with its recognisable
// parts, within a bounded triangle budget, plus the required attribution.

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Color, type BufferGeometry } from "three";
import {
  CLAWD_COLORS,
  CLAWD_DIM,
  FIGURE_SIZE,
  MASCOT_ATTRIBUTION,
  NULL_COLORS,
  NULL_FACE_TEXT,
  NULL_GLYPHS,
  buildMascotGeometries,
  mascotKindFor,
} from "../src/components/topology/spatial/spatial-mascots.js";

const figures = buildMascotGeometries();
afterAll(() => {
  for (const f of Object.values(figures)) { f.body.dispose(); f.glow?.dispose(); }
});

const triangles = (g: BufferGeometry) => g.getAttribute("position").count / 3;

/** Vertices whose colour equals `hex` (linear working space), with positions. */
function verticesColored(g: BufferGeometry, hex: string): Array<[number, number, number]> {
  const c = new Color(hex);
  const pos = g.getAttribute("position");
  const col = g.getAttribute("color");
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(col.getX(i) - c.r) < 1e-4 && Math.abs(col.getY(i) - c.g) < 1e-4 && Math.abs(col.getZ(i) - c.b) < 1e-4) {
      out.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
    }
  }
  return out;
}

describe("mascotKindFor", () => {
  it("routes by configured runtime: Claude → Clawd, Codex → Null, anything else → neutral", () => {
    expect(mascotKindFor({ runtime: "claude-code", nodeKind: "agent" })).toBe("clawd");
    expect(mascotKindFor({ runtime: "codex", nodeKind: "agent" })).toBe("null");
    for (const runtime of ["pi", "omp", "terminal", null, "", "something-else"]) {
      expect(mascotKindFor({ runtime, nodeKind: "agent" })).toBe("neutral");
    }
  });
  it("infrastructure is a server block regardless of runtime", () => {
    expect(mascotKindFor({ runtime: "claude-code", nodeKind: "infrastructure" })).toBe("infrastructure");
  });
});

describe("figure geometry", () => {
  it("every figure stands on y = 0, is centred, has vertex colours and stays within a small triangle budget", () => {
    for (const [kind, f] of Object.entries(figures)) {
      const box = f.body.boundingBox!;
      expect(box.min.y, kind).toBeCloseTo(0, 5);
      expect(Math.abs(box.min.x + box.max.x), kind).toBeLessThan(1e-3);
      expect(f.body.getAttribute("color"), kind).toBeTruthy();
      expect(f.body.getAttribute("normal"), kind).toBeTruthy();
      expect(triangles(f.body) + (f.glow ? triangles(f.glow) : 0), kind).toBeLessThan(1200);
    }
  });

  it("Clawd is the gallery's seven solids plus two eyes (12 triangles each), coral body with dark eyes on the front", () => {
    const clawd = figures.clawd;
    expect(triangles(clawd.body)).toBe(9 * 12);
    expect(clawd.width).toBeCloseTo(FIGURE_SIZE.clawdWidth, 5);
    // Proportions survive scaling: height / width = (LH + BH) / (BW + 2 AW).
    const D = CLAWD_DIM;
    expect(clawd.height / clawd.width).toBeCloseTo((D.LH + D.BH) / (D.BW + 2 * D.AW), 5);
    const eyes = verticesColored(clawd.body, CLAWD_COLORS.eye);
    expect(eyes.length).toBe(2 * 36);
    const frontZ = clawd.body.boundingBox!.max.z;
    expect(Math.max(...eyes.map((v) => v[2]))).toBeCloseTo(frontZ, 5); // eyes are the front-most surface
    expect(new Set(eyes.map((v) => Math.sign(v[0])))).toEqual(new Set([-1, 1])); // one each side
    expect(verticesColored(clawd.body, CLAWD_COLORS.leg).length).toBe(4 * 36);
  });

  it("Null has a dark head, raised orange NULL lettering on the face, limbs and a curved antenna above the head", () => {
    const nul = figures.null;
    expect(nul.height).toBeCloseTo(FIGURE_SIZE.nullHeight, 5);
    expect(nul.glow).not.toBeNull();
    // Glow lettering: exactly the lit pixels of N, U, L, L (+ emblem parts).
    const lit = [...NULL_FACE_TEXT].reduce((n, ch) => n + NULL_GLYPHS[ch as keyof typeof NULL_GLYPHS].join("").split("").filter((p) => p === "X").length, 0);
    const letters = verticesColored(nul.glow!, NULL_COLORS.glow).filter((v) => v[1] > nul.height * 0.4);
    expect(letters.length).toBe(lit * 36);
    // Letters stand proud of the face screen (the front of the head).
    const screen = verticesColored(nul.body, NULL_COLORS.screen);
    expect(Math.min(...letters.map((v) => v[2]))).toBeGreaterThanOrEqual(Math.max(...screen.map((v) => v[2])) - 1e-6);
    // Antenna: metal geometry rises well above the top of the head.
    const headTop = Math.max(...verticesColored(nul.body, NULL_COLORS.head).map((v) => v[1]));
    const metalTop = Math.max(...verticesColored(nul.body, NULL_COLORS.metal).map((v) => v[1]));
    expect(metalTop).toBeGreaterThan(headTop + nul.height * 0.1);
    expect(metalTop).toBeCloseTo(nul.height, 5);
  });
});

describe("attribution", () => {
  it("keeps the MIT notice for Clawd and the CC BY 4.0 reconstruction notice for Null next to the module", () => {
    expect(MASCOT_ATTRIBUTION.clawd).toContain("ChetasLua");
    expect(MASCOT_ATTRIBUTION.clawd).toContain("Henrik");
    expect(MASCOT_ATTRIBUTION.clawd).toContain("MIT");
    expect(MASCOT_ATTRIBUTION.null).toContain("Amit Sharma");
    expect(MASCOT_ATTRIBUTION.null).toContain("CC BY 4.0");
    expect(MASCOT_ATTRIBUTION.null).toMatch(/reconstruction/i);
    const notice = readFileSync(path.resolve(__dirname, "../src/components/topology/spatial/SPATIAL-MASCOTS-NOTICE.md"), "utf8");
    expect(notice).toContain("Copyright (c) 2026 ChetasLua (styles 1–20 and the engine)");
    expect(notice).toContain("Copyright (c) 2026 Henrik (styles 21–28 and tooling)");
    expect(notice).toContain("The above copyright notice and this permission notice shall be included in all");
    expect(notice).toContain("CC BY 4.0");
  });
});
