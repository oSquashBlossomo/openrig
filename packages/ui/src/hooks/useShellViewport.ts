// V1 attempt-3 Phase 2 — viewport-detection hook (per code-map AFTER tree).
//
// V1 attempt-3 Phase 5 P5-9: extracted as a standalone hook so non-AppShell
// surfaces (TopologyTerminalView, topology ScopePages) can degrade
// gracefully on mobile without prop-drilling isWideLayout from AppShell.
// Same WIDE_LAYOUT_BREAKPOINT (1024px) as AppShell — keeps the breakpoint
// in lockstep across consumers.

import { useEffect, useState } from "react";

const WIDE_LAYOUT_BREAKPOINT = 1024;
/** Shortest side of a tablet screen: every phone is narrower than this in
 *  one orientation, every iPad (mini included) is wider in both. */
const TABLET_MIN_SIDE = 600;
/** Widest touch tablet viewport (iPad Pro 13" landscape is 1376px). */
const TOUCH_TABLET_MAX_WIDTH = 1400;
/** Some input is a touchscreen. Unlike the primary `pointer`/`hover`, an
 *  attached mouse or trackpad does not turn this off. */
const ANY_TOUCH_QUERY = "(any-pointer: coarse)";

export interface ShellViewport {
  /** True when window.innerWidth >= 1024px (Tailwind lg breakpoint). */
  isWideLayout: boolean;
  /** Live innerWidth in px; useful for mid-band decisions (e.g., 768
   *  iPad-portrait breakpoint between mobile and desktop). */
  innerWidth: number;
  /** A touch-capable tablet in either orientation, never a phone: the
   *  viewport is at least 600px wide and the screen's short side is too
   *  (the screen, not the viewport height, so a soft keyboard never
   *  reclassifies it), up to iPad Pro landscape width, whatever its primary
   *  pointer (an attached trackpad or mouse keeps it a tablet). Lets the
   *  topology Graph keep the desktop canvas on a tablet below the 1024px
   *  shell breakpoint without moving that breakpoint. */
  isTouchTablet: boolean;
}

function readViewport(): ShellViewport {
  const { innerWidth, innerHeight, screen } = window;
  // Fall back to the viewport where the screen size is not reported.
  const shortSide = Math.min(screen?.width || innerWidth, screen?.height || innerHeight);
  const isTablet = innerWidth >= TABLET_MIN_SIDE && shortSide >= TABLET_MIN_SIDE;
  const touchCapable = (typeof window.matchMedia === "function" && window.matchMedia(ANY_TOUCH_QUERY).matches)
    || (window.navigator?.maxTouchPoints ?? 0) > 0;
  return {
    isWideLayout: innerWidth >= WIDE_LAYOUT_BREAKPOINT,
    innerWidth,
    isTouchTablet: isTablet && touchCapable && innerWidth <= TOUCH_TABLET_MAX_WIDTH,
  };
}

export function useShellViewport(): ShellViewport {
  const [state, setState] = useState<ShellViewport>(() => {
    if (typeof window === "undefined") {
      return { isWideLayout: true, innerWidth: WIDE_LAYOUT_BREAKPOINT, isTouchTablet: false };
    }
    return readViewport();
  });

  useEffect(() => {
    const handleResize = () => setState(readViewport());
    handleResize();
    window.addEventListener("resize", handleResize);
    // Input devices can come and go without a resize.
    const touchQuery = typeof window.matchMedia === "function" ? window.matchMedia(ANY_TOUCH_QUERY) : null;
    touchQuery?.addEventListener?.("change", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      touchQuery?.removeEventListener?.("change", handleResize);
    };
  }, []);

  return state;
}
