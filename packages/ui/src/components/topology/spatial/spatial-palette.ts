// Spatial palette — resolves the vellum theme tokens (CSS custom properties
// holding "H S% L%" triplets) into plain HSL numbers the lazy three.js
// renderer can apply. No three import here, so the palette is readable by the
// light chunk and unit-testable.
//
// Status accents are the same hues as the shared activity palette
// (activity-visuals.ts: emerald / amber / slate / stone) plus the tertiary
// "red ink" token for blocked seats, tuned per theme so they read as restrained
// luminous accents over paper rather than neon.

import type { SpatialTone } from "../../../lib/spatial-topology.js";

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..100
  l: number; // 0..100
}

export interface SpatialPalette {
  theme: "light" | "dark";
  background: Hsl;
  ground: Hsl;
  grid: Hsl;
  deck: Hsl;
  deckEdge: Hsl;
  platform: Hsl;
  platformEdge: Hsl;
  ink: Hsl;
  inkMuted: Hsl;
  link: Hsl;
  linkActive: Hsl;
  selection: Hsl;
  tones: Record<SpatialTone, Hsl>;
  /** Night Atelier scene materials and lights (renderer only). */
  atelier: AtelierPalette;
}

/** Scene materials and lighting for the sculptural stage. Dark theme: warm
 *  charcoal stone under a warm key and a cool rim. Light theme: the same
 *  composition in pale limestone, so the DOM labels' theme ink stays legible
 *  over the stage. Intensities are three.js units (decay-free lights). */
export interface AtelierPalette {
  stage: Hsl;
  floor: Hsl;
  floorLine: Hsl;
  slab: Hsl;
  slabEdge: Hsl;
  dais: Hsl;
  plinth: Hsl;
  plinthEdge: Hsl;
  hemiSky: Hsl;
  hemiGround: Hsl;
  hemiIntensity: number;
  key: Hsl;
  keyIntensity: number;
  rim: Hsl;
  rimIntensity: number;
  /** Soft front fill so dark figures (Null) keep their form. */
  fill: Hsl;
  fillIntensity: number;
  spot: Hsl;
  spotIntensity: number;
  link: Hsl;
  linkActive: Hsl;
  traffic: Hsl;
  trafficCore: Hsl;
  selection: Hsl;
  shadowOpacity: number;
  exposure: number;
}

// Stone is lit enough to read grain and edges (warm, never neon); the
// selection spotlight is a gentle pool, so a selected coral Clawd stays coral.
const ATELIER_DARK: AtelierPalette = {
  stage: { h: 30, s: 8, l: 8 },
  floor: { h: 30, s: 7, l: 10.5 },
  floorLine: { h: 30, s: 8, l: 17 },
  slab: { h: 28, s: 7, l: 17 },
  slabEdge: { h: 32, s: 12, l: 32 },
  dais: { h: 28, s: 7, l: 21 },
  plinth: { h: 28, s: 8, l: 24 },
  plinthEdge: { h: 32, s: 12, l: 38 },
  hemiSky: { h: 35, s: 25, l: 70 },
  hemiGround: { h: 28, s: 14, l: 8 },
  hemiIntensity: 0.85,
  key: { h: 34, s: 62, l: 84 },
  keyIntensity: 2.0,
  rim: { h: 212, s: 40, l: 74 },
  rimIntensity: 1.4,
  fill: { h: 30, s: 25, l: 80 },
  fillIntensity: 0.65,
  spot: { h: 36, s: 70, l: 80 },
  spotIntensity: 1.0,
  link: { h: 30, s: 10, l: 46 },
  linkActive: { h: 38, s: 72, l: 62 },
  traffic: { h: 38, s: 95, l: 62 },
  trafficCore: { h: 44, s: 100, l: 86 },
  selection: { h: 38, s: 90, l: 66 },
  shadowOpacity: 0.6,
  exposure: 1.0,
};

const ATELIER_LIGHT: AtelierPalette = {
  stage: { h: 40, s: 14, l: 90 },
  floor: { h: 40, s: 12, l: 86 },
  floorLine: { h: 38, s: 10, l: 76 },
  slab: { h: 38, s: 10, l: 82 },
  slabEdge: { h: 34, s: 10, l: 62 },
  dais: { h: 38, s: 9, l: 80 },
  plinth: { h: 36, s: 9, l: 77 },
  plinthEdge: { h: 34, s: 10, l: 60 },
  hemiSky: { h: 40, s: 30, l: 96 },
  hemiGround: { h: 30, s: 10, l: 52 },
  hemiIntensity: 1.0,
  key: { h: 36, s: 60, l: 92 },
  keyIntensity: 1.9,
  rim: { h: 212, s: 30, l: 80 },
  rimIntensity: 0.8,
  fill: { h: 38, s: 20, l: 92 },
  fillIntensity: 0.5,
  spot: { h: 38, s: 70, l: 78 },
  spotIntensity: 0.8,
  link: { h: 30, s: 8, l: 56 },
  linkActive: { h: 28, s: 80, l: 42 },
  traffic: { h: 28, s: 88, l: 46 },
  trafficCore: { h: 34, s: 96, l: 58 },
  selection: { h: 28, s: 85, l: 44 },
  shadowOpacity: 0.32,
  exposure: 1.0,
};

export function parseHslTriplet(raw: string | null | undefined): Hsl | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%$/);
  if (!match) return null;
  const h = Number(match[1]);
  const s = Number(match[2]);
  const l = Number(match[3]);
  if (![h, s, l].every(Number.isFinite)) return null;
  return { h: ((h % 360) + 360) % 360, s: Math.min(100, Math.max(0, s)), l: Math.min(100, Math.max(0, l)) };
}

const LIGHT_FALLBACK = {
  background: { h: 47, s: 20, l: 97 },
  surfaceLow: { h: 80, s: 10, l: 95 },
  surface: { h: 80, s: 10, l: 92 },
  surfaceLowest: { h: 0, s: 0, l: 100 },
  onSurface: { h: 120, s: 8, l: 19 },
  onSurfaceVariant: { h: 108, s: 5, l: 36 },
  outline: { h: 108, s: 4, l: 47 },
  outlineVariant: { h: 108, s: 4, l: 68 },
  secondary: { h: 213, s: 15, l: 39 },
  tertiary: { h: 1, s: 63, l: 42 },
};

const DARK_FALLBACK = {
  background: { h: 120, s: 8, l: 7 },
  surfaceLow: { h: 120, s: 5, l: 9 },
  surface: { h: 120, s: 5, l: 8.5 },
  surfaceLowest: { h: 120, s: 6, l: 9.5 },
  onSurface: { h: 100, s: 10, l: 90 },
  onSurfaceVariant: { h: 108, s: 6, l: 66 },
  outline: { h: 108, s: 5, l: 40 },
  outlineVariant: { h: 108, s: 6, l: 32 },
  secondary: { h: 213, s: 30, l: 70 },
  tertiary: { h: 2, s: 72, l: 64 },
};

function shift(c: Hsl, dl: number, ds = 0): Hsl {
  return { h: c.h, s: Math.min(100, Math.max(0, c.s + ds)), l: Math.min(100, Math.max(0, c.l + dl)) };
}

/** Read tokens from the document root. `theme` comes from ThemeProvider. */
export function readSpatialPalette(theme: "light" | "dark", root?: Element | null): SpatialPalette {
  const fallback = theme === "dark" ? DARK_FALLBACK : LIGHT_FALLBACK;
  let style: CSSStyleDeclaration | null = null;
  try {
    const el = root ?? (typeof document !== "undefined" ? document.documentElement : null);
    style = el && typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  } catch {
    style = null;
  }
  const token = (name: string, fb: Hsl): Hsl => parseHslTriplet(style?.getPropertyValue(name)) ?? fb;

  const background = token("--background", fallback.background);
  const surfaceLow = token("--surface-container-low", fallback.surfaceLow);
  const surface = token("--surface-container", fallback.surface);
  const surfaceLowest = token("--surface-container-lowest", fallback.surfaceLowest);
  const onSurface = token("--on-surface", fallback.onSurface);
  const onSurfaceVariant = token("--on-surface-variant", fallback.onSurfaceVariant);
  const outline = token("--outline", fallback.outline);
  const outlineVariant = token("--outline-variant", fallback.outlineVariant);
  const secondary = token("--secondary", fallback.secondary);
  const tertiary = token("--tertiary", fallback.tertiary);
  const dark = theme === "dark";

  return {
    theme,
    background,
    ground: dark ? shift(background, 1.5) : shift(background, -1.5),
    grid: dark ? shift(outlineVariant, -6) : shift(outlineVariant, 10),
    deck: dark ? shift(surfaceLowest, 3) : surfaceLow,
    deckEdge: outline,
    platform: dark ? shift(surface, 8) : surfaceLowest,
    platformEdge: dark ? shift(outlineVariant, 10) : outline,
    ink: onSurface,
    inkMuted: onSurfaceVariant,
    link: dark ? shift(secondary, -8) : shift(secondary, 18, -2),
    linkActive: dark ? { h: 160, s: 70, l: 58 } : { h: 160, s: 84, l: 34 },
    selection: dark ? { h: 45, s: 95, l: 70 } : onSurface,
    tones: {
      active: dark ? { h: 158, s: 64, l: 52 } : { h: 160, s: 84, l: 39 },
      needs_input: dark ? { h: 38, s: 92, l: 58 } : { h: 38, s: 92, l: 50 },
      blocked: tertiary,
      idle: dark ? { h: 215, s: 20, l: 62 } : { h: 215, s: 20, l: 65 },
      unknown: dark ? { h: 30, s: 6, l: 46 } : { h: 24, s: 6, l: 78 },
      offline: dark ? { h: 30, s: 4, l: 32 } : { h: 24, s: 5, l: 86 },
    },
    atelier: dark ? ATELIER_DARK : ATELIER_LIGHT,
  };
}

export function hslCss(c: Hsl, alpha?: number): string {
  return alpha === undefined
    ? `hsl(${c.h} ${c.s}% ${c.l}%)`
    : `hsl(${c.h} ${c.s}% ${c.l}% / ${alpha})`;
}
