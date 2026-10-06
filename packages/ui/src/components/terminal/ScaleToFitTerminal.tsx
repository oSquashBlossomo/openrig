// Scale static preview excerpts to their available container. Live terminals
// use FocusedTerminal's font fitting and actual native pane geometry instead;
// CSS transforms would break xterm mouse/selection coordinates.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Upscale ceiling for "contain" mode: filling a big panel is worth a moderate
// CSS-transform upscale, but past ~2x the xterm text starts to soften, so cap it.
const MAX_CONTAIN_SCALE = 2;

interface ScaleToFitTerminalProps {
  children: ReactNode;
  /** Optional testid for the outer (fit) container. */
  testId?: string;
  className?: string;
  /**
   * "width" (default): fit available width, never upscale, top-left - for the
   * grid/graph/table cells. "contain": fit both axes of the container with upscale
   * (capped) + centered - for the node-detail panel's big dedicated area.
   */
  fit?: "width" | "contain";
}

export function ScaleToFitTerminal({ children, testId, className, fit = "width" }: ScaleToFitTerminalProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [boxHeight, setBoxHeight] = useState<number | undefined>(undefined);
  const contain = fit === "contain";

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      const availableWidth = outer.clientWidth;
      // scrollWidth/Height report the UN-transformed natural size of the fixed
      // preview block, regardless of the scale transform already applied.
      const naturalWidth = inner.scrollWidth;
      const naturalHeight = inner.scrollHeight;
      if (naturalWidth <= 0 || naturalHeight <= 0 || availableWidth <= 0) return;
      if (contain) {
        // Fit BOTH axes of the container, allow upscale (capped), keep aspect.
        const availableHeight = outer.clientHeight;
        if (availableHeight <= 0) return;
        const next = Math.min(
          MAX_CONTAIN_SCALE,
          availableWidth / naturalWidth,
          availableHeight / naturalHeight,
        );
        setScale(next);
        // Outer already fills the panel (h-full); the inner is centered by flex.
        setBoxHeight(undefined);
      } else {
        // Fit width, never upscale; reserve the scaled height so layout flows.
        const next = Math.min(1, availableWidth / naturalWidth);
        setScale(next);
        setBoxHeight(naturalHeight * next);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [contain]);

  if (contain) {
    return (
      <div
        ref={outerRef}
        data-testid={testId}
        className={
          className
            ? `flex h-full w-full items-center justify-center overflow-hidden ${className}`
            : "flex h-full w-full items-center justify-center overflow-hidden"
        }
      >
        <div
          ref={innerRef}
          style={{ width: "max-content", transform: `scale(${scale})`, transformOrigin: "center center" }}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={outerRef}
      data-testid={testId}
      className={className ? `w-full overflow-hidden ${className}` : "w-full overflow-hidden"}
      style={{ height: boxHeight }}
    >
      <div
        ref={innerRef}
        style={{ width: "max-content", transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        {children}
      </div>
    </div>
  );
}
