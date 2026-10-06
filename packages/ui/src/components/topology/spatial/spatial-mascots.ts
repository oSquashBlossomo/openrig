/*! @license
 * Clawd figure geometry adapted from the Claude Mascot Style Gallery engine
 * (https://github.com/henrik-thevibe/Claude-Mascot-Style-Gallery).
 *
 * MIT License
 *
 * Copyright (c) 2026 ChetasLua (styles 1–20 and the engine)
 * Copyright (c) 2026 Henrik (styles 21–28 and tooling)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Null figure: volumetric reconstruction of “Null” from “Codex Pets — Nine
 * Pixel Companions” by Amit Sharma (Figma Community), CC BY 4.0,
 * https://creativecommons.org/licenses/by/4.0/ — reinterpreted from flat pixel
 * art as 3D geometry; not an exported original mesh.
 */
// Seat figures for the spatial scene. Imported only by the lazy renderer
// chunk (it pulls three), never by the view.
//
// Every figure is ONE merged BufferGeometry with per-vertex colours, so a
// seat costs one draw call for its body (plus one shared glow mesh for the
// Codex face), whatever the seat count. Geometry is built once per renderer
// mount and shared by every seat of that kind.
//
// Which figure a seat gets comes ONLY from the graph's configured runtime
// (`agent.runtime`) and node kind; model strings, roles and display names
// never attest a runtime. Anything that is not a recognised Claude or Codex
// runtime gets an honest neutral stele; infrastructure gets a server block.
//
// Provenance (see ./SPATIAL-MASCOTS-NOTICE.md for the full notices):
//   - Clawd: the seven solids (body, two arms, four legs) and eye placement
//     are adapted from the DIM/LEGS/eye definitions of the MIT-licensed
//     "Claude Mascot Style Gallery" engine (henrik-thevibe/
//     Claude-Mascot-Style-Gallery, index.html; engine by ChetasLua, tooling by
//     Henrik). Unofficial fan work, not an official Anthropic model. Colours
//     are the gallery's canonical palette (body #d97757, leg #c76a4c,
//     eye #1f1412).
//   - Null: a VOLUMETRIC RECONSTRUCTION, made for this renderer, of the
//     "Null" pet from "Codex Pets — Nine Pixel Companions" by Amit Sharma
//     (Figma Community file 1673261581276170811, CC BY 4.0). The original is
//     flat pixel art; no source mesh was available or used. Changes: the flat
//     sprite was reinterpreted as solid boxes, a tube antenna and torus parts.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  QuadraticBezierCurve3,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CLAWD_COLORS, CLAWD_DIM, NULL_COLORS, NULL_FACE_TEXT, NULL_GLYPHS, type MascotKind } from "./spatial-mascot-spec.js";

// Three-free spec (routing, dimensions, colours, glyphs, attribution) lives in
// spatial-mascot-spec.ts so the view can draw a matching portrait without
// pulling three into its chunk; re-exported here for renderer callers.
export { CLAWD_COLORS, CLAWD_DIM, MASCOT_ATTRIBUTION, NULL_COLORS, NULL_FACE_TEXT, NULL_GLYPHS, mascotKindFor, type MascotKind } from "./spatial-mascot-spec.js";


/** World-unit figure sizes (seats are 4.4 apart; plinths 3.7 wide). Clawd is
 *  sized by its arm span, the others by height. */
export const FIGURE_SIZE = { clawdWidth: 4.1, nullHeight: 3.9, neutralHeight: 2.6, infrastructureHeight: 2.2 } as const;

export interface MascotGeometry {
  /** Merged body, vertex-coloured, base at y = 0, centred on x/z. */
  body: BufferGeometry;
  /** Emissive detail (Codex face lettering, server lamps), same frame. */
  glow: BufferGeometry | null;
  /** World-unit height and width after scaling. */
  height: number;
  width: number;
}

type Rgb = readonly [number, number, number];

/** sRGB hex → linear working-space RGB (three's vertex colours are linear). */
function rgb(hex: string): Rgb {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

function painted(geometry: BufferGeometry, color: Rgb): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  const count = g.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set(color, i * 3);
  g.setAttribute("color", new Float32BufferAttribute(colors, 3));
  // Merging requires identical attribute sets.
  if (!g.getAttribute("uv")) g.setAttribute("uv", new Float32BufferAttribute(new Float32Array(count * 2), 2));
  return g;
}

/** Axis-aligned solid from min to max corners, painted one colour. */
function solid(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: Rgb): BufferGeometry {
  const g = new BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return painted(g, color);
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error("mascot geometry merge failed");
  return merged;
}

/** Recentre on x/z with the base at y = 0 and scale to `height` (or `width`). */
function fit(body: BufferGeometry, glow: BufferGeometry | null, target: { height?: number; width?: number }): MascotGeometry {
  body.computeBoundingBox();
  const box = body.boundingBox!;
  const size = new Vector3();
  box.getSize(size);
  const scale = target.width !== undefined ? target.width / size.x : (target.height ?? 1) / size.y;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  for (const g of glow ? [body, glow] : [body]) {
    g.translate(-cx, -box.min.y, -cz);
    g.scale(scale, scale, scale);
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
  return { body, glow, height: size.y * scale, width: size.x * scale };
}

// --- Clawd (MIT gallery geometry; dimensions in spatial-mascot-spec.ts) ----
function buildClawd(): MascotGeometry {
  const D = CLAWD_DIM;
  const body = rgb(CLAWD_COLORS.body);
  const leg = rgb(CLAWD_COLORS.leg);
  const eye = rgb(CLAWD_COLORS.eye);
  const parts: BufferGeometry[] = [
    solid(-D.BW / 2, D.LH, -D.BD / 2, D.BW / 2, D.LH + D.BH, D.BD / 2, body),
  ];
  const ay = D.LH + D.AY;
  // Arms overlap the body by 0.3 as in the gallery, so the joint never gaps.
  parts.push(solid(-D.BW / 2 - D.AW, ay - D.AH / 2, -D.AD / 2, -D.BW / 2 + 0.3, ay + D.AH / 2, D.AD / 2, body));
  parts.push(solid(D.BW / 2 - 0.3, ay - D.AH / 2, -D.AD / 2, D.BW / 2 + D.AW, ay + D.AH / 2, D.AD / 2, body));
  for (const [lx, lz] of D.LEGS) {
    parts.push(solid(lx - D.LW / 2, 0, lz - D.LD / 2, lx + D.LW / 2, D.LH + 0.45, lz + D.LD / 2, leg));
  }
  // Eyes: shallow solids standing just proud of the front face (the gallery
  // projects them as polygons; a real mesh needs a little depth).
  const ey = D.LH + D.EY;
  for (const side of [-1, 1]) {
    const ex = side * D.EX;
    parts.push(solid(ex - D.EW / 2, ey - D.EH / 2, D.BD / 2 - 0.05, ex + D.EW / 2, ey + D.EH / 2, D.BD / 2 + 0.22, eye));
  }
  return fit(merge(parts), null, { width: FIGURE_SIZE.clawdWidth });
}

// --- Null (volumetric reconstruction of the CC BY 4.0 pixel sprite) --------
/** Pixel boxes spelling `text` on a plane facing +z, centred at (cx, cy). */
function pixelText(text: string, cx: number, cy: number, z: number, px: number, color: Rgb): BufferGeometry[] {
  const letters = [...text].map((ch) => NULL_GLYPHS[ch as keyof typeof NULL_GLYPHS]);
  const cols = letters.length * 4 + (letters.length - 1);
  const left = cx - (cols * px) / 2;
  const top = cy + (5 * px) / 2;
  const parts: BufferGeometry[] = [];
  letters.forEach((rows, li) => {
    rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== "X") continue;
        const x0 = left + (li * 5 + c) * px;
        const y1 = top - r * px;
        // A hair narrower than the cell keeps the pixel structure readable.
        parts.push(solid(x0 + px * 0.06, y1 - px * 0.94, z, x0 + px * 0.94, y1 - px * 0.06, z + 0.22, color));
      }
    });
  });
  return parts;
}

function buildNull(): MascotGeometry {
  const body = rgb(NULL_COLORS.body);
  const head = rgb(NULL_COLORS.head);
  const screen = rgb(NULL_COLORS.screen);
  const metal = rgb(NULL_COLORS.metal);
  const glow = rgb(NULL_COLORS.glow);
  const parts: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    parts.push(solid(side * 0.4, 0, -1.2, side * 2.4, 0.7, 1.5, metal)); // feet
    parts.push(solid(side * 0.7, 0.7, -0.7, side * 2.0, 2.5, 0.7, body)); // legs
    parts.push(solid(side * 2.9, 3.0, -0.7, side * 4.1, 5.6, 0.7, body)); // arms
    parts.push(solid(side * 3.0, 2.5, -0.8, side * 4.2, 3.0, 0.8, metal)); // hands
  }
  parts.push(solid(-2.9, 2.4, -2.0, 2.9, 6.0, 2.0, body)); // torso
  parts.push(solid(-1.0, 6.0, -1.0, 1.0, 6.6, 1.0, metal)); // neck
  parts.push(solid(-4.6, 6.6, -3.6, 4.6, 14.4, 3.6, head)); // head
  parts.push(solid(-3.8, 7.5, 3.55, 3.8, 13.5, 3.85, screen)); // face screen
  // Ear bolts.
  for (const side of [-1, 1]) {
    const bolt = new CylinderGeometry(0.5, 0.5, 0.6, 10);
    bolt.rotateZ(Math.PI / 2);
    bolt.translate(side * 4.9, 11.2, 0);
    parts.push(painted(bolt, metal));
  }
  // Curved antenna with a ring at its tip.
  const stalk = new TubeGeometry(new QuadraticBezierCurve3(new Vector3(1.2, 14.3, 0), new Vector3(3.0, 17.0, 0.3), new Vector3(0.7, 18.7, 0)), 12, 0.2, 5, false);
  parts.push(painted(stalk, metal));
  const ring = new TorusGeometry(0.75, 0.2, 5, 14);
  ring.translate(0.45, 19.45, 0);
  parts.push(painted(ring, metal));
  // Glow: NULL lettering on the screen and the null-set emblem on the chest.
  const glowParts = pixelText(NULL_FACE_TEXT, 0, 10.7, 3.85, 0.36, glow);
  const emblem = new TorusGeometry(0.78, 0.16, 5, 16);
  emblem.translate(0, 4.2, 2.06);
  glowParts.push(painted(emblem, glow));
  const slash = new BoxGeometry(0.22, 2.2, 0.2);
  slash.rotateZ(-0.62);
  slash.translate(0, 4.2, 2.12);
  glowParts.push(painted(slash, glow));
  return fit(merge(parts), merge(glowParts), { height: FIGURE_SIZE.nullHeight });
}

// --- Neutral and infrastructure -------------------------------------------
function buildNeutral(): MascotGeometry {
  const stone = rgb("#56524d");
  const cap = rgb("#6f6a63");
  return fit(merge([
    solid(-1.4, 0, -0.55, 1.4, 4.6, 0.55, stone),
    solid(-1.55, 4.6, -0.7, 1.55, 5.0, 0.7, cap),
    solid(-0.9, 2.1, 0.55, 0.9, 2.3, 0.62, cap),
  ]), null, { height: FIGURE_SIZE.neutralHeight });
}

function buildInfrastructure(): MascotGeometry {
  const shell = rgb("#2b2b2f");
  const lamp = rgb("#9fc4e8");
  const slits: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) slits.push(solid(-1.1, 1.0 + i * 1.2, 1.42, 1.1, 1.25 + i * 1.2, 1.5, lamp));
  return fit(merge([solid(-1.8, 0, -1.4, 1.8, 4.6, 1.4, shell)]), merge(slits), { height: FIGURE_SIZE.infrastructureHeight });
}

/** All figures, built once per renderer mount and shared by every seat. */
export function buildMascotGeometries(): Record<MascotKind, MascotGeometry> {
  return { clawd: buildClawd(), null: buildNull(), neutral: buildNeutral(), infrastructure: buildInfrastructure() };
}
