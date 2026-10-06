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
// Three-free figure spec for the spatial scene: which figure a seat gets,
// the Clawd dimensions/colours, the Null face glyphs/colours and the
// attribution. Safe to import from the (non-three) view chunk, e.g. to draw a
// matching flat portrait in the workspace. Geometry is built from this in
// spatial-mascots.ts (renderer chunk only).
//
// Provenance: see ./SPATIAL-MASCOTS-NOTICE.md (Clawd: MIT, ChetasLua and
// Henrik; Null: volumetric reconstruction of Amit Sharma's CC BY 4.0 sprite).

import { normalizeRuntimeBrandId } from "../../../lib/runtime-brand.js";

export type MascotKind = "clawd" | "null" | "neutral" | "infrastructure";

export const MASCOT_ATTRIBUTION = {
  clawd:
    "Clawd figure geometry adapted from the Claude Mascot Style Gallery engine — MIT License, Copyright (c) 2026 ChetasLua (styles 1–20 and the engine), Copyright (c) 2026 Henrik (styles 21–28 and tooling). Unofficial fan work, not an official Anthropic model.",
  null:
    "Null figure is a volumetric reconstruction of “Null” from “Codex Pets — Nine Pixel Companions” by Amit Sharma (Figma Community, CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). Reinterpreted from flat pixel art as 3D geometry; not an exported original mesh.",
} as const;

/** Route a seat to its figure. Runtime and node kind only. */
export function mascotKindFor(agent: { runtime: string | null; nodeKind: "agent" | "infrastructure" }): MascotKind {
  if (agent.nodeKind === "infrastructure") return "infrastructure";
  const brand = normalizeRuntimeBrandId(agent.runtime);
  if (brand === "claude-code") return "clawd";
  if (brand === "codex") return "null";
  return "neutral";
}

// Clawd, in the gallery's model units. LH 2.8 leg length; body 12 x 9 x 6;
// arms 2.4 x 2.6 x 2.4 centred 4.1 above the body bottom; legs 1.2 x 1.3 at
// [x, z]; eyes 1.2 x 2.0 centred at x ±3.6, 6.4 above the body bottom, on the
// front (+z) face.
export const CLAWD_DIM = {
  LH: 2.8, BW: 12, BH: 9, BD: 6,
  AW: 2.4, AH: 2.6, AD: 2.4, AY: 4.1,
  LW: 1.2, LD: 1.3,
  LEGS: [[-4.85, 1.45], [-2.55, -1.45], [2.55, -1.45], [4.85, 1.45]] as ReadonlyArray<readonly [number, number]>,
  EX: 3.6, EY: 6.4, EW: 1.2, EH: 2.0,
} as const;

export const CLAWD_COLORS = { body: "#d97757", leg: "#c76a4c", eye: "#1f1412" } as const;

// 4x5 pixel letters for the face ("NULL"), rows top to bottom.
export const NULL_GLYPHS: Record<"N" | "U" | "L", readonly string[]> = {
  N: ["X..X", "XX.X", "X.XX", "X..X", "X..X"],
  U: ["X..X", "X..X", "X..X", "X..X", ".XX."],
  L: ["X...", "X...", "X...", "X...", "XXXX"],
};
export const NULL_FACE_TEXT = "NULL";
// Charcoal rather than pure black so the robot keeps its form under the
// key/rim/fill; the face screen stays near-black behind the orange NULL.
export const NULL_COLORS = { body: "#26262b", head: "#202025", screen: "#08080a", metal: "#34343a", glow: "#f0642a" } as const;
