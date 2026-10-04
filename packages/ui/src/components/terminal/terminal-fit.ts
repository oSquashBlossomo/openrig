// Live terminal font fitting. Native cols/rows stay canonical: the browser only
// chooses an xterm font size for the available box. Below the readable floor the
// pane keeps that floor and the fit wrapper scrolls/pans instead of shrinking
// text into illegibility (155x37 on a 390px phone would otherwise be ~3.7px).
import { LIVE_TERMINAL_FONT_SIZE } from "./terminal-geometry.js";

export type LiveTerminalFitMode = "natural" | "width" | "contain";

/** Smallest fitted font on a fine-pointer desktop layout. */
export const LIVE_TERMINAL_MIN_READABLE_FONT_SIZE = 8;
/** Smallest fitted font on touch or phone-width layouts. */
export const LIVE_TERMINAL_MIN_TOUCH_FONT_SIZE = 11;
export const LIVE_TERMINAL_TOUCH_MEDIA_QUERY = "(pointer: coarse), (max-width: 639px)";

export function readableTerminalFontFloor(win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window): number {
  try {
    if (win?.matchMedia?.(LIVE_TERMINAL_TOUCH_MEDIA_QUERY).matches) return LIVE_TERMINAL_MIN_TOUCH_FONT_SIZE;
  } catch { /* matchMedia unavailable */ }
  return LIVE_TERMINAL_MIN_READABLE_FONT_SIZE;
}

export interface TerminalFontFitInput {
  mode: LiveTerminalFitMode;
  /** The native grid's pixel size at LIVE_TERMINAL_FONT_SIZE. */
  natural: { w: number; h: number };
  availableWidth: number;
  availableHeight: number;
  floor: number;
  maxUpscale: number;
}

export interface TerminalFontFit {
  fontSize: number;
  /** True when the readable floor, not the box, chose the size: the wrapper pans. */
  overflows: boolean;
}

export function fitTerminalFontSize({ mode, natural, availableWidth, availableHeight, floor, maxUpscale }: TerminalFontFitInput): TerminalFontFit | null {
  if (mode === "natural") return null;
  if (natural.w <= 0 || natural.h <= 0 || availableWidth <= 0) return null;
  const scale = mode === "contain" && availableHeight > 0
    ? Math.min(maxUpscale, availableWidth / natural.w, availableHeight / natural.h)
    : Math.min(1, availableWidth / natural.w); // "width": fit width, never upscale
  const fitted = LIVE_TERMINAL_FONT_SIZE * scale;
  return fitted < floor ? { fontSize: floor, overflows: true } : { fontSize: fitted, overflows: false };
}
