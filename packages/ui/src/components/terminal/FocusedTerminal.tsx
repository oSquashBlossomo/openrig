import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { readTerminalBearerToken } from "../mission-control/missionControlAuth.js";
import { useDaemonHealthSignal } from "../../hooks/useDaemonHealth.js";
import {
  LIVE_TERMINAL_RENDER_BACKGROUND,
  LIVE_TERMINAL_COLS,
  LIVE_TERMINAL_ROWS,
  LIVE_TERMINAL_FONT_SIZE,
  LIVE_TERMINAL_LINE_HEIGHT,
  LIVE_TERMINAL_FONT_FAMILY,
  parseTerminalServerFrame,
} from "./terminal-geometry.js";
import { fitTerminalFontSize, readableTerminalFontFloor } from "./terminal-fit.js";
import { setXtermFontSize } from "./xterm-render-metrics.js";
import "@xterm/xterm/css/xterm.css";

// OPR.0.4.0.39 (selection fix): when the live terminal must fit a container, it
// scales by FONT SIZE, not a CSS transform. xterm's mouse hit-test (text selection,
// link clicks) divides a post-transform pointer offset by the pre-transform cell
// size, so a CSS transform:scale ancestor makes selection drift by the scale factor
// (xterm.js #6023). Scaling via fontSize keeps the cell metrics honest -> native
// selection. Upscale (contain mode) is capped to keep text crisp (matches
// ScaleToFitTerminal's MAX_CONTAIN_SCALE).
const MAX_FIT_UPSCALE = 2;

const SPECIAL_KEY_MAP: Record<string, string> = {
  "\t": "Tab",
  "\r": "Enter",
  "\x7f": "BSpace",
  "\x1b": "Escape",
  "\x03": "C-c",
  "\x04": "C-d",
  "\x1a": "C-z",
  "\x0c": "C-l",
  "\x01": "C-a",
  "\x05": "C-e",
  "\x0b": "C-k",
  "\x15": "C-u",
  "\x17": "C-w",
};

const ESCAPE_SEQ_MAP: Record<string, string> = {
  "\x1b[A": "Up",
  "\x1b[B": "Down",
  "\x1b[C": "Right",
  "\x1b[D": "Left",
  "\x1b[H": "Home",
  "\x1b[F": "End",
  "\x1b[5~": "PgUp",
  "\x1b[6~": "PgDn",
  "\x1b[3~": "DC",
  "\x1b[2~": "IC",
};

// OPR.0.4.3.21 — the broker's GENERIC fallback close reason (see
// TerminalSessionBroker.ts). This is the ONLY message the health-aware
// disambiguation may replace; specific reasons (`session not found: …`,
// `pipe-pane failed: …`, `tmux session terminated`, `pipe output file
// failed: …`) always pass through unchanged.
const GENERIC_BROKER_UNAVAILABLE = "terminal broker unavailable";
// The honest control-plane message shown when the broker reported the generic
// fallback WHILE daemon health is failing. Rendered under the "Terminal
// unavailable:" prefix.
const DAEMON_CONTROL_PLANE_UNHEALTHY =
  "daemon control plane unhealthy (event loop starved) — restart the daemon only; your seats are preserved";

type WsMessage = { type: "keys"; keys: string[] } | { type: "text"; text: string };

export function mapXtermInput(data: string): WsMessage[] {
  const messages: WsMessage[] = [];
  let i = 0;
  let textBuf = "";

  const flushText = () => {
    if (textBuf) { messages.push({ type: "text", text: textBuf }); textBuf = ""; }
  };

  while (i < data.length) {
    if (data[i] === "\x1b" && data[i + 1] === "[") {
      const rest = data.slice(i);
      let matched = false;
      for (const [seq, key] of Object.entries(ESCAPE_SEQ_MAP)) {
        if (rest.startsWith(seq)) {
          flushText();
          messages.push({ type: "keys", keys: [key] });
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        textBuf += data[i]!;
        i++;
      }
    } else {
      const key = SPECIAL_KEY_MAP[data[i]!];
      if (key) {
        flushText();
        messages.push({ type: "keys", keys: [key] });
        i++;
      } else {
        textBuf += data[i]!;
        i++;
      }
    }
  }
  flushText();
  return messages;
}

export function applyOpaqueTerminalBackground(container: HTMLElement): void {
  const surfaces = [
    container,
    container.querySelector<HTMLElement>(".xterm"),
    container.querySelector<HTMLElement>(".xterm-screen"),
    container.querySelector<HTMLElement>(".xterm-viewport"),
    container.querySelector<HTMLElement>(".xterm-rows"),
  ];
  for (const surface of surfaces) {
    if (surface) surface.style.backgroundColor = LIVE_TERMINAL_RENDER_BACKGROUND;
  }
}

// The element the user actually scrolls/pans: the fit wrapper around the xterm
// host when fitting, otherwise the host itself (natural mode leaves ancestor
// scrolling to the caller).
const TERMINAL_SCROLL_OWNER_ATTR = "data-terminal-scroll-owner";

export function terminalScrollOwner(terminalHost: HTMLElement): HTMLElement {
  return terminalHost.closest<HTMLElement>(`[${TERMINAL_SCROLL_OWNER_ATTR}]`) ?? terminalHost;
}

function hostTopInScrollOwner(owner: HTMLElement, terminalHost: HTMLElement): number {
  if (owner === terminalHost) return 0;
  return terminalHost.getBoundingClientRect().top - owner.getBoundingClientRect().top + owner.scrollTop;
}

/**
 * Reveal the prompt row in the terminal's scroll owner now, after the next
 * frame and after 50ms. Returns a cancel handle for the delayed passes so an
 * unmounted, replaced or history-reading viewer is never dragged afterward.
 */
export function scrollTerminalViewportToPrompt(terminalHost: HTMLElement, allowed: () => boolean = () => true): () => void {
  const container = terminalScrollOwner(terminalHost);
  const scroll = () => {
    if (!allowed() || !terminalHost.isConnected) return;
    const cursor = terminalHost.querySelector<HTMLElement>("textarea.xterm-helper-textarea");
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (!cursor) {
      container.scrollTop = maxScrollTop;
      return;
    }

    const parsedCursorTop = Number.parseFloat(cursor.style.top);
    const cursorTop = (Number.isFinite(parsedCursorTop) ? parsedCursorTop : cursor.offsetTop) + hostTopInScrollOwner(container, terminalHost);
    const lineHeight = cursor.offsetHeight || 14;
    const cursorBottom = cursorTop + lineHeight;
    const desiredScrollTop = cursorBottom - container.clientHeight + lineHeight * 3;
    container.scrollTop = Math.min(maxScrollTop, Math.max(0, desiredScrollTop));
  };

  scroll();
  const frame = window.requestAnimationFrame(scroll);
  const timer = window.setTimeout(scroll, 50);
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

interface FocusedTerminalProps {
  sessionName: string;
  daemonBaseUrl?: string;
  /**
   * OPR.0.4.0.39: how the live xterm sizes to its container. "natural" (default) =
   * render at the native pane size (callers that don't scale, e.g. the feed-card).
   * "width" = scale DOWN via fontSize to fit the container width (never upscale) -
   * the grid/graph/table cells. "contain" = fit both axes via fontSize with capped
   * upscale, centered - the node-detail panel. fontSize-scaling (not CSS transform)
   * keeps xterm's selection/click hit-testing native-correct (#6023).
   */
  fit?: "natural" | "width" | "contain";
  /**
   * OPR.0.4.4.20 delta-C (BR-12 — terminal, not chat): pre-populate the target
   * pane with EXACTLY ONE text frame on the first successful connect. Rides the
   * existing text seam (broker sendText → tmux `send-keys -l --`, no `C-m`), so
   * nothing submits — the cursor sits at the end and the human's own Enter
   * submits preamble + message together. Sent once per mount (a reconnect never
   * re-sends). This prop is the ONE net-new terminal wiring item; there is no
   * chat panel, thread, bubble, or compose box anywhere in this family.
   */
  initialText?: string;
}

export function FocusedTerminal({ sessionName, daemonBaseUrl, fit = "natural", initialText }: FocusedTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // OPR.0.4.0.39: the fit wrapper fills the available container; the inner
  // containerRef holds the natural-sized xterm. We measure the wrapper (available)
  // vs the xterm's natural size (captured once at the base font) and set the xterm
  // fontSize so the actual pane fits - no CSS transform, so selection stays native-correct.
  const fitWrapperRef = useRef<HTMLDivElement>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const termRef = useRef<unknown>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // OPR.0.4.4.20 delta-C: once-per-mount guard for the initial-text frame —
  // a WS reconnect must never re-send the preamble into the pane.
  const initialTextSentRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const promptScrollUntilRef = useRef(0);
  // OPR.0.4.0.39: lines scrolled back from the live bottom (0 = live). Driven by the
  // wheel handler; the broker paints the matching tmux history window. Typing or
  // wheeling back to 0 returns to live.
  const scrollOffsetRef = useRef(0);
  const geometryRef = useRef<{ cols: number; rows: number } | null>(null);
  const [geometryReady, setGeometryReady] = useState(false);
  const [nativeGeometry, setNativeGeometry] = useState<{ cols: number; rows: number } | null>(null);
  // True when the readable font floor, not the box, sized the pane: the fit
  // wrapper then scrolls/pans over the native grid instead of shrinking text.
  const [pans, setPans] = useState(false);
  // Pending delayed prompt reveals; cancelled on unmount, session change and
  // when the user takes over scrolling.
  const promptScrollCancelsRef = useRef(new Set<() => void>());
  // Bumped by user scroll/pan/key intent on the scroll owner. Output and
  // geometry restores only put back offsets the user did not change.
  const userScrollEpochRef = useRef(0);
  const fontMetricSyncRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);

  // OPR.0.4.3.21 — shared daemon-health signal (context; healthy default when
  // no provider, so standalone terminal tests are unaffected). Held in a ref so
  // the ws.onclose callback reads the latest value without re-subscribing.
  const health = useDaemonHealthSignal();
  const controlPlaneUnhealthyRef = useRef(false);
  controlPlaneUnhealthyRef.current = health.controlPlaneUnhealthy;

  const sendScroll = useCallback((offset: number) => {
    const wsc = wsRef.current;
    if (wsc && wsc.readyState === WebSocket.OPEN) {
      wsc.send(JSON.stringify({ type: "scroll", offset }));
    }
  }, []);

  // OPR.0.4.0.39 (selection fix): size the xterm to its container by FONT SIZE (not a
  // CSS transform, which breaks xterm's mouse/selection coords - #6023). Reads only
  // refs so it is a stable, dependency-free callback. natural is the current xterm grid's
  // pixel size at the base font (captured once); the wrapper is the available space.
  const applyFontSizeFit = useCallback(() => {
    const mode = fitRef.current;
    if (mode === "natural") return;
    const term = termRef.current as Parameters<typeof setXtermFontSize>[0] | null;
    const wrapper = fitWrapperRef.current;
    const natural = naturalSizeRef.current;
    if (!term || !wrapper || !natural || natural.w <= 0 || natural.h <= 0) return;
    // Not laid out yet (or jsdom) returns null - skip, no crash. Readable floor
    // instead of the former 2px minimum; MAX_FIT_UPSCALE caps contain upscale.
    const fitted = fitTerminalFontSize({
      mode,
      natural,
      availableWidth: wrapper.clientWidth,
      availableHeight: wrapper.clientHeight,
      floor: readableTerminalFontFloor(),
      maxUpscale: MAX_FIT_UPSCALE,
    });
    if (!fitted) return;
    setPans(fitted.overflows);
    try {
      // Only write on a meaningful change (avoids churn + ResizeObserver feedback).
      // options.fontSize alone leaves xterm's scrollbar/caret at the old size.
      if (Math.abs((term.options.fontSize ?? LIVE_TERMINAL_FONT_SIZE) - fitted.fontSize) > 0.1) {
        fontMetricSyncRef.current?.();
        fontMetricSyncRef.current = setXtermFontSize(term, fitted.fontSize);
      }
    } catch { /* term not ready / disposed */ }
  }, []);

  const disposeTerminal = useCallback(() => {
    fontMetricSyncRef.current?.();
    fontMetricSyncRef.current = null;
    const term = termRef.current as { dispose(): void } | null;
    term?.dispose();
    termRef.current = null;
  }, []);

  const scrollOwner = useCallback(() => fitWrapperRef.current ?? containerRef.current, []);

  const trackPromptScroll = useCallback((cancel: () => void) => {
    promptScrollCancelsRef.current.add(cancel);
  }, []);

  const cancelPromptScrolls = useCallback(() => {
    for (const cancel of promptScrollCancelsRef.current) cancel();
    promptScrollCancelsRef.current.clear();
  }, []);

  const scrollLiveTerminalToPrompt = useCallback((term: { scrollToBottom(): void } | null) => {
    if (term) {
      term.scrollToBottom();
    }
    if (containerRef.current) {
      const gen = generationRef.current;
      trackPromptScroll(scrollTerminalViewportToPrompt(containerRef.current, () => generationRef.current === gen && Date.now() <= promptScrollUntilRef.current && scrollOffsetRef.current === 0));
    }
  }, [trackPromptScroll]);

  const connectForGeneration = useCallback((gen: number) => {
    const base = daemonBaseUrl ?? window.location.origin;
    const wsUrl = base.replace(/^http/, "ws");
    const token = readTerminalBearerToken();
    const params = new URLSearchParams({ protocol: "2" });
    if (token) params.set("token", token);
    const tokenParam = `?${params}`;
    let protocolFailed = false;
    const ws = new WebSocket(`${wsUrl}/api/terminal/${encodeURIComponent(sessionName)}${tokenParam}`);

    ws.onopen = () => {
      if (generationRef.current !== gen) { ws.close(); return; }
      // Await actual native geometry before displaying any mirror bytes.
      geometryRef.current = null;
      setGeometryReady(false);
      // History remains server-side and independent for each subscriber.
      // A (re)connect starts at the live bottom.
      scrollOffsetRef.current = 0;
      promptScrollUntilRef.current = Date.now() + 2500;
      const term = termRef.current as { scrollToBottom(): void } | null;
      scrollLiveTerminalToPrompt(term);
      // OPR.0.4.4.20 delta-C: one text frame, once per mount, no Enter frame.
      if (initialText && !initialTextSentRef.current) {
        initialTextSentRef.current = true;
        ws.send(JSON.stringify({ type: "text", text: initialText }));
      }
    };

    ws.onmessage = (evt) => {
      if (generationRef.current !== gen || wsRef.current !== ws) return;
      const term = termRef.current as { write(data: string, done?: () => void): void; scrollToBottom(): void; resize(cols: number, rows: number): void; options: { fontSize: number } } | null;
      if (typeof evt.data !== "string" || !term) return;
      try {
        const frame = parseTerminalServerFrame(evt.data);
        if (frame.type === "geometry") {
          const previous = geometryRef.current;
          const viewport = scrollOwner();
          const scrollTop = viewport?.scrollTop ?? 0, scrollLeft = viewport?.scrollLeft ?? 0;
          const epoch = userScrollEpochRef.current;
          if (previous) { promptScrollUntilRef.current = 0; cancelPromptScrolls(); }
          term.resize(frame.cols, frame.rows);
          geometryRef.current = { cols: frame.cols, rows: frame.rows };
          setGeometryReady(true);
          setNativeGeometry({ cols: frame.cols, rows: frame.rows });
          // Measure the new grid, correcting for current font fitting. Do not
          // retain the old 90x27 pixel reference or send a pane resize upstream.
          requestAnimationFrame(() => {
            if (generationRef.current !== gen || wsRef.current !== ws || !containerRef.current) return;
            const ratio = LIVE_TERMINAL_FONT_SIZE / term.options.fontSize;
            const w = containerRef.current.offsetWidth * ratio, h = containerRef.current.offsetHeight * ratio;
            if (w > 0 && h > 0) naturalSizeRef.current = { w, h };
            applyFontSizeFit();
            if (previous && viewport && userScrollEpochRef.current === epoch) { viewport.scrollTop = scrollTop; viewport.scrollLeft = scrollLeft; }
          });
          if (previous && viewport) { viewport.scrollTop = scrollTop; viewport.scrollLeft = scrollLeft; }
          return;
        }
        if (!geometryRef.current) throw new Error("terminal output arrived before native geometry");
        // Output never moves the reader's pan/scroll position on the actual scroll
        // owner; only the user (or the initial prompt reveal) does.
        const viewport = scrollOwner();
        const top = viewport?.scrollTop ?? 0, left = viewport?.scrollLeft ?? 0;
        const epoch = userScrollEpochRef.current;
        term.write(frame.data, () => {
          if (generationRef.current !== gen || !viewport?.isConnected) return;
          // The prompt window has closed (expired, or ended by the user/geometry).
          if (Date.now() > promptScrollUntilRef.current && userScrollEpochRef.current === epoch) { viewport.scrollTop = top; viewport.scrollLeft = left; }
        });
        if (Date.now() <= promptScrollUntilRef.current) scrollLiveTerminalToPrompt(term);
      } catch (err) {
        protocolFailed = true;
        ws.close();
        disposeTerminal();
        setError(err instanceof Error ? err.message : "Terminal protocol unavailable");
      }
    };

    ws.onclose = (evt) => {
      if (generationRef.current !== gen || protocolFailed || wsRef.current !== ws) return;
      const definitive = evt.code === 1008 || evt.code === 1011 || evt.code === 1001;
      if (definitive) {
        disposeTerminal();
        // OPR.0.4.3.21 — health-aware disambiguation: replace ONLY the broker's
        // GENERIC "terminal broker unavailable" fallback, and ONLY when daemon
        // health positively reports the control plane unhealthy. Every specific
        // broker/session reason (session not found / pipe-pane failed / tmux
        // session terminated) is preserved verbatim.
        if (evt.reason === GENERIC_BROKER_UNAVAILABLE && controlPlaneUnhealthyRef.current) {
          setError(DAEMON_CONTROL_PLANE_UNHEALTHY);
        } else {
          setError(evt.reason || "Terminal unavailable: session not found on this daemon");
        }
        return;
      }
      const term = termRef.current as { write(data: string): void } | null;
      if (term) {
        term.write("\r\n\x1b[90m[disconnected - reconnecting...]\x1b[0m\r\n");
      }
      if (mountedRef.current && generationRef.current === gen) {
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === gen) connectForGeneration(gen);
        }, 3000);
      }
    };

    wsRef.current = ws;
    return ws;
  }, [sessionName, daemonBaseUrl, disposeTerminal, scrollLiveTerminalToPrompt, applyFontSizeFit, scrollOwner, cancelPromptScrolls]);

  useEffect(() => {
    if (!containerRef.current) return;
    mountedRef.current = true;
    generationRef.current++;
    const currentGen = generationRef.current;
    naturalSizeRef.current = null;
    geometryRef.current = null;
    setGeometryReady(false);
    setNativeGeometry(null);
    let cleanedUp = false;

    (async () => {
      try {
        if (cleanedUp) return;

        const term = new Terminal({
          cursorBlink: true,
          cols: LIVE_TERMINAL_COLS,
          rows: LIVE_TERMINAL_ROWS,
          fontSize: LIVE_TERMINAL_FONT_SIZE,
          lineHeight: LIVE_TERMINAL_LINE_HEIGHT,
          fontFamily: LIVE_TERMINAL_FONT_FAMILY,
          // xterm erase/redraw needs an opaque cell background. A translucent
          // xterm render surface lets old TUI cells bleed through after clear
          // screen / absolute cursor repaint, which corrupts Claude/Codex views.
          theme: { background: LIVE_TERMINAL_RENDER_BACKGROUND, foreground: "#e0e0e0", cursor: "#e0e0e0" },
          allowTransparency: false,
          allowProposedApi: true,
        });

        term.open(containerRef.current!);
        // Some xterm DOM layers do not inherit the theme background. Pin every
        // render layer opaque so clear/erase operations actually erase.
        applyOpaqueTerminalBackground(containerRef.current!);
        term.focus();
        promptScrollUntilRef.current = Date.now() + 2500;
        trackPromptScroll(scrollTerminalViewportToPrompt(containerRef.current!));
        termRef.current = term;

        term.onData((data: string) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return;
          // OPR.0.4.0.39: typing returns to the live bottom before sending input.
          if (scrollOffsetRef.current > 0) {
            scrollOffsetRef.current = 0;
            sendScroll(0);
          }
          const mapped = mapXtermInput(data);
          for (const msg of mapped) {
            wsc.send(JSON.stringify(msg));
          }
        });

        // OPR.0.4.0.39: wheel = scroll back through tmux history (server-side).
        // Up increases the offset (paints an older capture-pane window); down
        // decreases it; reaching 0 resumes live. We handle the wheel ourselves and
        // return false so xterm's local (empty) scrollback does not interfere.
        const scrollHandlerTerm = term as {
          attachCustomWheelEventHandler(handler: (ev: WheelEvent) => boolean): void;
        };
        scrollHandlerTerm.attachCustomWheelEventHandler((ev: WheelEvent) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return true;
          const STEP = 3;
          if (ev.deltaY !== 0) { promptScrollUntilRef.current = 0; cancelPromptScrolls(); }
          if (ev.deltaY < 0) {
            scrollOffsetRef.current += STEP;
          } else if (ev.deltaY > 0) {
            scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current - STEP);
          } else {
            return true;
          }
          sendScroll(scrollOffsetRef.current);
          return false;
        });

        // Browser layout/renderer resize never asks the shared pane to resize.

        connectForGeneration(currentGen);

        // OPR.0.4.0.39 (selection fix): capture the xterm's initial pixel size
        // at the base font; protocol geometry replaces this placeholder reference, then
        // apply the initial fit. rAF so layout has settled. Guarded for jsdom (0 size).
        requestAnimationFrame(() => {
          if (cleanedUp || !containerRef.current) return;
          if (!naturalSizeRef.current) {
            const w = containerRef.current.offsetWidth;
            const h = containerRef.current.offsetHeight;
            if (w > 0 && h > 0) naturalSizeRef.current = { w, h };
          }
          applyFontSizeFit();
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terminal initialization failed");
      }
    })();

    return () => {
      cleanedUp = true;
      mountedRef.current = false;
      generationRef.current++;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      cancelPromptScrolls();
      const activeWs = wsRef.current;
      if (activeWs) { activeWs.close(); wsRef.current = null; }
      disposeTerminal();
    };
  }, [connectForGeneration, disposeTerminal, trackPromptScroll, cancelPromptScrolls]);

  // OPR.0.4.0.39 (selection fix): refit the xterm fontSize when its container resizes
  // (responsive grid columns, window resize, node-detail panel). Observes the fit
  // WRAPPER (which fills the parent), so changing the INNER xterm fontSize does not
  // feed back into the observed box. No-op in "natural" mode.
  useEffect(() => {
    if (fit === "natural") return undefined;
    const wrapper = fitWrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => applyFontSizeFit());
    ro.observe(wrapper);
    applyFontSizeFit();
    return () => ro.disconnect();
  }, [fit, applyFontSizeFit]);

  // User scroll/pan/selection/typing on the scroll owner ends the initial prompt
  // reveal (wheel/touch/pointer) and marks offsets as user-owned for restores.
  useEffect(() => {
    const owner = fitWrapperRef.current ?? containerRef.current;
    if (!owner) return undefined;
    const takeOver = () => {
      userScrollEpochRef.current++;
      promptScrollUntilRef.current = 0;
      cancelPromptScrolls();
    };
    const keyIntent = () => { userScrollEpochRef.current++; };
    const options = { capture: true, passive: true } as const;
    owner.addEventListener("wheel", takeOver, options);
    owner.addEventListener("touchstart", takeOver, options);
    owner.addEventListener("pointerdown", takeOver, options);
    owner.addEventListener("keydown", keyIntent, options);
    return () => {
      owner.removeEventListener("wheel", takeOver, options);
      owner.removeEventListener("touchstart", takeOver, options);
      owner.removeEventListener("pointerdown", takeOver, options);
      owner.removeEventListener("keydown", keyIntent, options);
    };
  }, [fit, error, sessionName, cancelPromptScrolls]);

  if (error) {
    return (
      <div
        key={`focused-terminal-error-${sessionName}`}
        data-testid={`focused-terminal-${sessionName}`}
        className="h-full w-full min-h-[200px] flex items-center justify-center px-4 text-center text-stone-400 font-mono text-xs"
      >
        <span className="block max-w-[28ch] whitespace-normal break-all leading-relaxed">
          Terminal unavailable: {error}
        </span>
      </div>
    );
  }

  // The xterm always renders at its NATURAL full native geometry (w-max) so the WHOLE
  // screen + cursor are visible (no min-h/h-full cap that hid the bottom rows).
  const liveTerminal = (
    <div
      key={`focused-terminal-live-${sessionName}`}
      ref={containerRef}
      data-testid={`focused-terminal-${sessionName}`}
      className={fit === "contain" ? "m-auto w-max shrink-0 bg-stone-950/85 backdrop-blur-sm" : "w-max bg-stone-950/85 backdrop-blur-sm"}
      style={{ visibility: geometryReady ? "visible" : "hidden" }}
      aria-busy={!geometryReady}
    />
  );

  // OPR.0.4.0.39 (selection fix): in "natural" mode the xterm renders at native size
  // (no scaling). In "width"/"contain" mode it is wrapped in a fit-wrapper that fills
  // the container; applyFontSizeFit sets the xterm fontSize so the actual pane fits - NO CSS
  // transform, so xterm's selection/click hit-testing stays native-correct (#6023).
  // Below the readable floor the wrapper is the deliberate scroll/pan owner. Contain
  // centers with auto margins (not justify/items-center) so overflow on the
  // top/left stays reachable.
  if (fit === "natural") return liveTerminal;

  const geometryLabel = nativeGeometry ? `, native ${nativeGeometry.cols} by ${nativeGeometry.rows}` : "";
  return (
    <div
      ref={fitWrapperRef}
      {...{ [TERMINAL_SCROLL_OWNER_ATTR]: "" }}
      data-testid={`focused-terminal-fit-${sessionName}`}
      data-terminal-overflow={pans ? "pan" : "fit"}
      role="group"
      aria-label={`Terminal ${sessionName}${geometryLabel}${pans ? "; scroll to pan the full pane" : ""}`}
      className={
        fit === "contain"
          ? "flex h-full w-full min-w-0 overflow-auto"
          : "w-full min-w-0 max-w-full overflow-auto"
      }
    >
      {liveTerminal}
    </div>
  );
}
