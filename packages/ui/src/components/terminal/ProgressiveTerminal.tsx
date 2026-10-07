// OPR.0.4.0.1 — the ONE reusable progressive-live terminal (AC-3).
//
// Default-static -> click-inside-to-go-live (founder directive): on open it shows
// the cheap static polling preview (SessionPreviewPane); a click anywhere inside
// upgrades THAT terminal to a live, typeable FocusedTerminal. Going live consults
// the global LiveTerminalProvider cap: if over MAX_LIVE_TERMINALS the OLDEST live
// terminal is evicted back to static (its revert callback runs, closing its WS).
// Static previews are uncapped (cheap polling). Used by all three surfaces.

import { useCallback, useEffect, useRef, useState } from "react";
import { FocusedTerminal } from "./FocusedTerminal.js";
import { StaticTerminalPlate } from "./StaticTerminalPlate.js";
import { ScaleToFitTerminal } from "./ScaleToFitTerminal.js";
import { useLiveTerminal } from "./LiveTerminalProvider.js";

// OPR.0.4.0.39: the static fetches a deeper history than the visible landscape window
// so you can SCROLL BACK through it (the compact <pre> caps the visible height with
// max-h + overflow-y); the live xterm scrolls its own buffer.
const STATIC_HISTORY_LINES = 100;

// OPR.0.4.0.39 FR-1: the shared static-terminal plate now owns
// SMOKED_STATIC_PLATE_CLASS; re-export here for existing importers.
export { SMOKED_STATIC_PLATE_CLASS } from "./StaticTerminalPlate.js";

interface ProgressiveTerminalProps {
  sessionName: string;
  /** Stable global key for the cap registry (e.g. `${rigId}:${logicalId}`). */
  terminalKey: string;
  lines?: number;
  testIdPrefix?: string;
  className?: string;
  /** OPR.0.4.0.1: notified when this terminal flips static<->live, so a host
   *  (e.g. the popover) can size its shell to the wide live plate when live and
   *  stay compact when static. */
  onLiveChange?: (isLive: boolean) => void;
  /** OPR.0.4.0.39: scale-to-fit mode. "width" (default) fits the column width and
   *  never upscales (grid/graph/table cells). "contain" fills a big dedicated
   *  container on both axes (capped upscale, centered) - the node-detail panel. */
  fit?: "width" | "contain";
  /** OPR.0.4.4.20 delta-C: forwarded to FocusedTerminal when this terminal goes
   *  live — one pre-populated text frame, no Enter (see FocusedTerminal). */
  initialText?: string;
}

export function ProgressiveTerminal({
  sessionName,
  terminalKey,
  // OPR.0.4.0.39: fetch deeper history so the static landscape window can scroll back.
  lines = STATIC_HISTORY_LINES,
  testIdPrefix = "progressive-terminal",
  className,
  onLiveChange,
  fit = "width",
  initialText,
}: ProgressiveTerminalProps) {
  // Live mode belongs to the exact cap key + session it was opened for: a host
  // that reuses this component for another seat or session starts static
  // again, so a live socket never carries over to a session the operator did
  // not make live (or one that holds no cap slot).
  const identity = `${terminalKey}\u0000${sessionName}`;
  const [liveIdentity, setLiveIdentity] = useState<string | null>(null);
  // Leaving the live identity forgets it, so returning to it (A → B → A)
  // never resurrects a live viewer without a click and a cap slot.
  if (liveIdentity !== null && liveIdentity !== identity) setLiveIdentity(null);
  const mode: "static" | "live" = liveIdentity === identity ? "live" : "static";
  const live = useLiveTerminal();
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const goStatic = useCallback(() => setLiveIdentity(null), []);

  // OPR.0.4.0.1: surface the live/static mode to the host so a popover can widen
  // its shell to the full live plate when live and stay compact when static.
  useEffect(() => {
    onLiveChange?.(mode === "live");
  }, [mode, onLiveChange]);

  const goLive = useCallback(() => {
    if (modeRef.current === "live") return;
    // requestLive may evict the OLDEST live terminal (reverting it to static).
    live.requestLive(terminalKey, goStatic);
    setLiveIdentity(identity);
  }, [live, terminalKey, identity, goStatic]);

  // Free the registry slot whenever we leave live (unmount or revert-to-static).
  // release() is idempotent, so an eviction (which already removed the key) is safe.
  useEffect(() => {
    if (mode !== "live") return undefined;
    return () => live.release(terminalKey);
  }, [mode, live, terminalKey]);

  // Static is a bounded polling excerpt. Live mirrors actual pane geometry;
  // its font fitting keeps xterm selection correct without CSS transforms.
  // min-w-0 keeps a readable-floor pane panning inside its own wrapper instead
  // of widening the grid cell/flex row that hosts it.
  if (mode === "live") {
    return (
      <div
        data-testid={`${testIdPrefix}-live`}
        className={[fit === "contain" ? "h-full w-full min-w-0" : "w-full min-w-0", className].filter(Boolean).join(" ")}
      >
        <FocusedTerminal sessionName={sessionName} fit={fit} initialText={initialText} />
      </div>
    );
  }

  // Static default: the whole preview is the click target to go live. The shared
  // StaticTerminalPlate carries the translucent smoked-GLASS plate + transparent
  // compact content at the 90-col geometry (FR-1/FR-2); clicking flips it to the
  // OPAQUE #0c0a09 live xterm in place - the glass->opaque activation affordance.
  return (
    <ScaleToFitTerminal testId={`${testIdPrefix}-fit`} className={className} fit={fit}>
      <StaticTerminalPlate
        sessionName={sessionName}
        lines={lines}
        plateTestId={`${testIdPrefix}-static`}
        previewTestIdPrefix={`${testIdPrefix}-preview`}
        onClick={goLive}
        ariaLabel={`Make ${sessionName} terminal live (typeable)`}
        title="Click to go live (typeable)"
      />
    </ScaleToFitTerminal>
  );
}
