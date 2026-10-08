import { useEffect, useLayoutEffect, useRef, useCallback, useState, type CSSProperties } from "react";
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
  "\x1b[Z": "BTab",
  "\x1b[1;2D": "S-Left",
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

// Transport bounds. Each socket must deliver native geometry within
// READY_TIMEOUT_MS of being created (covers a socket stuck CONNECTING and an
// OPEN one that never speaks). Consecutive attempts that end before geometry
// are capped; then the viewer stops with an explicit Retry. A browser reports
// an HTTP upgrade rejection (401/403, origin) only as close code 1006, so the
// copy lists what to check instead of naming a cause it cannot observe.
const READY_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 3000;
const MAX_CONNECT_ATTEMPTS = 4;
// A tab hidden at least this long may have been suspended with a half-open
// socket; returning replaces it (as do `online` and a bfcache restore).
const WAKE_RECONNECT_AFTER_HIDDEN_MS = 30_000;
const CONNECT_FAILED = `live connection could not be established after ${MAX_CONNECT_ATTEMPTS} attempts. The browser does not report why; check that the daemon is running and reachable from this page, and that this page's origin is allowed to open terminals.`;
// The daemon's per-viewer queue limit (encoded UTF-8 JSON frames, see
// terminal-ws.ts). One input event over it is refused here before any frame is
// sent; a server close 1009 means the queue overflowed after some delivery.
const MAX_INPUT_EVENT_BYTES = 256 * 1024;
const INPUT_TOO_LARGE = "Input not sent: it exceeds the terminal's 256 KiB limit (encoded). Nothing from it reached the terminal; send it in smaller parts.";
const INPUT_OVERFLOWED = "terminal input exceeded the 256 KiB buffer limit and the connection was closed. Some input may already have reached the terminal: inspect it before sending anything again. Retry reconnects without resending.";
const encoder = new TextEncoder();
const encodedBytes = (frames: string[]) => frames.reduce((n, f) => n + encoder.encode(f).byteLength, 0);

// Explicit key controls for when the shortcut never reaches the page (a
// browser that intercepts Ctrl+C) or there is no such key (phone/iPad soft
// keyboard). Each sends the same xterm byte sequence typing would, through
// the same input path.
const TERMINAL_KEYS = [
  { label: "Ctrl+C", name: "Interrupt (Ctrl+C)", data: "\x03", title: "Interrupt: send Ctrl+C to the running program" },
  { label: "Esc", name: "Escape", data: "\x1b", title: "Send Escape" },
  { label: "Tab", name: "Tab", data: "\t", title: "Send Tab" },
  { label: "⇧Tab", name: "Shift+Tab", data: "\x1b[Z", title: "Send Shift+Tab" },
  { label: "↑", name: "Up arrow", data: "\x1b[A", title: "Send Up arrow" },
  { label: "↓", name: "Down arrow", data: "\x1b[B", title: "Send Down arrow" },
  { label: "⇧←", name: "Shift+Left arrow", data: "\x1b[1;2D", title: "Send Shift+Left arrow" },
  { label: "Enter", name: "Enter", data: "\r", title: "Send Enter" },
] as const;

type WsMessage = { type: "keys"; keys: string[] } | { type: "text"; text: string };

// A software keyboard shrinks the visual viewport, not the layout viewport
// (iOS Safari, and Chrome's default), so dvh-sized layouts stay covered.
// Less occlusion than this is browser chrome or an accessory bar.
const KEYBOARD_MIN_OCCLUSION_PX = 100;

type KeyboardBand = { top: number; height: number };
/** The band plus how this input area fits it: `cap` = max-height, `lift` =
 *  relative upward shift when no ancestor can scroll it far enough. */
type KeyboardFit = KeyboardBand & { cap: number; lift: number };

/** The visible band above a software keyboard while focus is inside `area`
 *  (terminal input, clipboard box or keys), in client coordinates; null
 *  otherwise. Pinch zoom also shrinks the visual viewport; it is left alone. */
function keyboardBand(area: HTMLElement): KeyboardBand | null {
  const vv = window.visualViewport;
  if (!vv || vv.scale > 1.01 || !area.contains(document.activeElement)) return null;
  const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
  if (layoutHeight - vv.height < KEYBOARD_MIN_OCCLUSION_PX) return null;
  return { top: Math.round(vv.offsetTop), height: Math.floor(vv.height) };
}

const clipsY = (node: Element) => /hidden|clip|auto|scroll|overlay/.test(getComputedStyle(node).overflowY);
const scrollsY = (node: HTMLElement) => /auto|scroll|overlay/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight;

/** The part of the band visible through `from` and its ancestors: the band
 *  intersected with every clipping box (a scroller below the shell header,
 *  a fixed popover). */
function visibleBox(from: HTMLElement | null, band: KeyboardBand): { top: number; bottom: number } {
  let top = band.top, bottom = band.top + band.height;
  for (let node = from; node; node = node.parentElement) {
    if (!clipsY(node)) continue;
    const box = node.getBoundingClientRect();
    top = Math.max(top, box.top + node.clientTop);
    bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight);
  }
  return { top, bottom };
}

/** Scroll each scrollable ancestor so the element sits in that ancestor's
 *  visible part of the band, bottom (prompt row and keys) first. */
function revealInBand(el: HTMLElement, band: KeyboardBand): void {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (!scrollsY(node)) continue;
    const { top, bottom } = visibleBox(node, band);
    const rect = el.getBoundingClientRect();
    const delta = rect.bottom > bottom ? rect.bottom - bottom : rect.top < top ? rect.top - top : 0;
    if (Math.abs(delta) >= 1) node.scrollTop += delta;
  }
}

type XtermText = {
  rows: number;
  hasSelection(): boolean;
  getSelection(): string;
  buffer: { active: { viewportY: number; getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined } };
};

/** What Copy takes: the selection, else the rows on screen. */
function terminalCopyText(term: XtermText): { text: string; what: string } {
  if (term.hasSelection()) return { text: term.getSelection(), what: "the selection" };
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  return { text: lines.join("\n").replace(/\s+$/, ""), what: "the visible screen" };
}

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
  /**
   * Optional admission check run before EVERY socket open — the first connect
   * and each automatic reconnect. Resolve `true` to connect, or
   * `{ refuse: reason }` to stay disconnected and show the reason (no further
   * reconnects). A rejection is treated as a refusal with its message. A
   * resolution that arrives after the mount/session generation moved on is
   * ignored: nothing connects for a stale check. Omitted = connect directly,
   * exactly as before (all existing callers).
   */
  beforeConnect?: (attempt: { reconnect: boolean }) => Promise<true | { refuse: string }>;
  /** Focus the xterm when it mounts (default true, the existing behaviour).
   *  Pass false where mounting follows a selection made elsewhere (e.g. a
   *  keyboard index or a phone tap) so focus and the software keyboard stay
   *  where the operator is. */
  autoFocus?: boolean;
  /** Called once when the viewer ends for good (definitive server close,
   *  protocol failure, or bounded connect attempts exhausted), with the reason
   *  shown. Lets a host that admitted this viewer release it and offer its
   *  own retry. Not called for a beforeConnect refusal: its owner knows. */
  onClosed?: (reason: string) => void;
}

export function FocusedTerminal({ sessionName, daemonBaseUrl, fit = "natural", initialText, beforeConnect, autoFocus = true, onClosed }: FocusedTerminalProps) {
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
  // Input ownership. `committedIdentityRef` is the seat the committed UI shows
  // (set in a layout effect, never during render); `liveIdentityRef` is the
  // seat whose xterm and socket the mount effect created (cleared by its
  // cleanup). Between a new seat's commit and the old seat's passive teardown
  // they differ, and no input, paste or Copy may use the old seat.
  const committedIdentityRef = useRef<string | null>(null);
  const liveIdentityRef = useRef<string | null>(null);
  const ownsLiveSeat = () => liveIdentityRef.current !== null && liveIdentityRef.current === committedIdentityRef.current;
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
  // An error belongs to the session it happened on: a new session renders
  // the live host again (containerRef) and connects instead of the old error.
  const identity = `${daemonBaseUrl ?? ""}\u0000${sessionName}`;
  const [errorState, setErrorState] = useState<{ identity: string; message: string } | null>(null);
  const error = errorState?.identity === identity ? errorState.message : null;
  const setError = useCallback((message: string | null) => setErrorState(message === null ? null : { identity, message }), [identity]);
  // Transport state shown outside the xterm host (null = live and verified).
  const [status, setStatus] = useState<string | null>(null);
  // A local input refusal; the connection stays usable.
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  // Clipboard outcome and the fallback text box (copy: read-only text for the
  // device's own Copy; paste: text the operator pastes, then sends). Both
  // belong to the session they were made on, like errors.
  const [clipboardState, setClipboardState] = useState<{ identity: string; notice: string | null; box: { mode: "copy" | "paste"; text: string } | null } | null>(null);
  const clipboard = clipboardState?.identity === identity ? clipboardState : null;
  const setClipboard = useCallback((notice: string | null, box: { mode: "copy" | "paste"; text: string } | null = null) => setClipboardState({ identity, notice, box }), [identity]);
  // The whole input area (terminal, clipboard box, keys). While focus is in it
  // under a software keyboard, `keyboard` fits it into the visible band.
  const rootRef = useRef<HTMLDivElement>(null);
  const [keyboard, setKeyboard] = useState<KeyboardFit | null>(null);
  // Text focus in the area: the Keyboard control then offers Hide.
  const [inputFocused, setInputFocused] = useState(false);
  // Band height whose prompt reveal already ran (offset-only moves skip it).
  const promptRevealedForRef = useRef<number | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);
  // Consecutive sockets that ended before native geometry.
  const failedAttemptsRef = useRef(0);
  // Read through refs: a new callback identity must not remount the viewer.
  const beforeConnectRef = useRef(beforeConnect);
  beforeConnectRef.current = beforeConnect;
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  // Reconnect entry point (set below); the socket's close handler uses it so a
  // reconnect passes through admission too.
  const reconnectRef = useRef<(gen: number) => void>(() => {});

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

  // The one input path (typing, key controls and clipboard paste). Input is
  // live only on the current socket after it delivered native geometry;
  // anything earlier is dropped, never queued or replayed. A paste is one
  // literal text frame; typed data maps CR to Enter and controls to keys.
  const sendInput = useCallback((data: string, paste = false): boolean => {
    const wsc = wsRef.current;
    if (!wsc || wsc.readyState !== WebSocket.OPEN || !geometryRef.current || !ownsLiveSeat()) return false;
    const frames = (paste ? [{ type: "text", text: data } as WsMessage] : mapXtermInput(data)).map((msg) => JSON.stringify(msg));
    // OPR.0.4.0.39: typing returns to the live bottom before sending input;
    // that frame counts toward the same budget.
    if (scrollOffsetRef.current > 0) frames.unshift(JSON.stringify({ type: "scroll", offset: 0 }));
    if (encodedBytes(frames) > MAX_INPUT_EVENT_BYTES) { setInputWarning(INPUT_TOO_LARGE); return false; }
    setInputWarning(null);
    // xterm's own scroller can consume a native wheel into local history
    // without reaching the broker wheel handler; key controls must return
    // there too (typing already does via xterm's scrollOnUserInput). No
    // smooth scrolling is configured, so this is immediate.
    (termRef.current as { scrollToBottom(): void } | null)?.scrollToBottom();
    scrollOffsetRef.current = 0;
    for (const frame of frames) wsc.send(frame);
    return true;
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
    let ready = false;
    // An attempt ends exactly once (retry, give-up, definitive close or
    // protocol failure); ending disarms its ready deadline.
    let ended = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      if (ended) return false;
      ended = true;
      clearTimeout(deadline);
      return true;
    };
    // Until this socket delivers native geometry, input is paused and no
    // mirror bytes are accepted.
    geometryRef.current = null;
    const ws = new WebSocket(`${wsUrl}/api/terminal/${encodeURIComponent(sessionName)}${tokenParam}`);

    // End this attempt: retry with a delay, or stop for good once the bounded
    // attempts are spent. Input typed meanwhile was dropped, never queued.
    const lose = () => {
      if (!end()) return;
      if (!ready) failedAttemptsRef.current++;
      if (failedAttemptsRef.current >= MAX_CONNECT_ATTEMPTS) {
        disposeTerminal();
        setError(CONNECT_FAILED);
        onClosedRef.current?.(CONNECT_FAILED);
        return;
      }
      const term = termRef.current as { write(data: string): void } | null;
      if (term) {
        term.write("\r\n\x1b[90m[disconnected - reconnecting...]\x1b[0m\r\n");
      }
      setStatus(`Terminal connection closed; reconnecting (attempt ${failedAttemptsRef.current + 1} of ${MAX_CONNECT_ATTEMPTS}). Input is paused.`);
      if (mountedRef.current && generationRef.current === gen) {
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === gen) reconnectRef.current(gen);
        }, RECONNECT_DELAY_MS);
      }
    };

    deadline = setTimeout(() => {
      if (ready || ended || generationRef.current !== gen || wsRef.current !== ws) return;
      // Detach first: a stuck socket may never deliver its close event.
      wsRef.current = null;
      ws.close();
      lose();
    }, READY_TIMEOUT_MS);

    ws.onopen = () => {
      // Also fence a socket this generation already abandoned (ready
      // deadline): it must not consume initialText or move the scroll state.
      if (generationRef.current !== gen || wsRef.current !== ws) { ws.close(); return; }
      // History remains server-side and independent for each subscriber.
      // A (re)connect starts at the live bottom.
      scrollOffsetRef.current = 0;
      promptScrollUntilRef.current = Date.now() + 2500;
      const term = termRef.current as { scrollToBottom(): void } | null;
      scrollLiveTerminalToPrompt(term);
      // OPR.0.4.4.20 delta-C: one text frame, once per mount, no Enter frame.
      if (initialText && !initialTextSentRef.current) {
        initialTextSentRef.current = true;
        const frame = JSON.stringify({ type: "text", text: initialText });
        if (encodedBytes([frame]) > MAX_INPUT_EVENT_BYTES) setInputWarning(INPUT_TOO_LARGE);
        else ws.send(frame);
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
          ready = true;
          clearTimeout(deadline);
          failedAttemptsRef.current = 0;
          setStatus(null);
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
        if (!end()) return;
        protocolFailed = true;
        ws.close();
        disposeTerminal();
        const message = err instanceof Error ? err.message : "Terminal protocol unavailable";
        setError(message);
        onClosedRef.current?.(message);
      }
    };

    ws.onclose = (evt) => {
      if (generationRef.current !== gen || protocolFailed || wsRef.current !== ws) return;
      // 1009: the daemon's input queue overflowed. Part of the input may have
      // been delivered, so never reconnect (or replay) automatically.
      const definitive = evt.code === 1008 || evt.code === 1011 || evt.code === 1001 || evt.code === 1009;
      if (definitive) {
        if (!end()) return;
        disposeTerminal();
        // OPR.0.4.3.21 — health-aware disambiguation: replace ONLY the broker's
        // GENERIC "terminal broker unavailable" fallback, and ONLY when daemon
        // health positively reports the control plane unhealthy. Every specific
        // broker/session reason (session not found / pipe-pane failed / tmux
        // session terminated) is preserved verbatim.
        const message = evt.code === 1009 ? INPUT_OVERFLOWED
          : evt.reason === GENERIC_BROKER_UNAVAILABLE && controlPlaneUnhealthyRef.current
          ? DAEMON_CONTROL_PLANE_UNHEALTHY
          : evt.reason || "Terminal unavailable: session not found on this daemon";
        setError(message);
        onClosedRef.current?.(message);
        return;
      }
      lose();
    };

    wsRef.current = ws;
    return ws;
  }, [sessionName, daemonBaseUrl, disposeTerminal, scrollLiveTerminalToPrompt, applyFontSizeFit, scrollOwner, cancelPromptScrolls, setError]);

  // Admission, then connect — only if this generation is still current when
  // the check resolves. Without a check this connects synchronously, as before.
  const admitAndConnect = useCallback(async (gen: number, reconnect: boolean) => {
    const admit = beforeConnectRef.current;
    if (admit) {
      let verdict: true | { refuse: string };
      try {
        verdict = await admit({ reconnect });
      } catch (err) {
        verdict = { refuse: err instanceof Error ? err.message : "terminal admission check failed" };
      }
      if (!mountedRef.current || generationRef.current !== gen) return;
      if (verdict !== true) {
        disposeTerminal();
        setError(verdict.refuse);
        return;
      }
    }
    connectForGeneration(gen);
  }, [connectForGeneration, disposeTerminal, setError]);
  reconnectRef.current = (gen: number) => { void admitAndConnect(gen, true); };

  // Browser wake / network return: a socket that still looks OPEN may be
  // half-open. Replace it under a new generation (fencing the old socket, a
  // pending reconnect timer and a pending admission) while the current
  // display stays up. Nothing typed earlier is replayed.
  useEffect(() => {
    let hiddenAt: number | null = null;
    const replace = () => {
      if (!mountedRef.current || !termRef.current) return;
      generationRef.current++;
      const gen = generationRef.current;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      cancelPromptScrolls();
      const old = wsRef.current;
      wsRef.current = null;
      old?.close();
      geometryRef.current = null;
      failedAttemptsRef.current = 0;
      setStatus("Reconnecting after the browser resumed. Input is paused.");
      reconnectRef.current(gen);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      if (hiddenAt !== null && Date.now() - hiddenAt >= WAKE_RECONNECT_AFTER_HIDDEN_MS) replace();
      hiddenAt = null;
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) replace(); };
    window.addEventListener("online", replace);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", replace);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cancelPromptScrolls]);

  useEffect(() => {
    if (!containerRef.current) return;
    mountedRef.current = true;
    liveIdentityRef.current = identity;
    generationRef.current++;
    const currentGen = generationRef.current;
    naturalSizeRef.current = null;
    geometryRef.current = null;
    failedAttemptsRef.current = 0;
    setError(null);
    setStatus("Connecting to the live terminal…");
    setGeometryReady(false);
    setNativeGeometry(null);
    setInputWarning(null);
    let cleanedUp = false;
    // xterm turns every pasted newline into CR, which the input mapper sends
    // as Enter: a multi-line paste would submit line by line. Take explicit
    // pastes before xterm does (capture phase) and send the clipboard text as
    // one literal frame; tmux paste-buffer keeps LF and brackets it once.
    const host = containerRef.current;
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData("text/plain");
      if (text) sendInput(text.replace(/\r\n?/g, "\n"), true);
    };
    host.addEventListener("paste", onPaste, true);

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
        if (autoFocusRef.current) term.focus();
        promptScrollUntilRef.current = Date.now() + 2500;
        trackPromptScroll(scrollTerminalViewportToPrompt(containerRef.current!));
        termRef.current = term;

        term.onData((data) => sendInput(data));

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

        void admitAndConnect(currentGen, retryEpoch > 0);

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
      host.removeEventListener("paste", onPaste, true);
      mountedRef.current = false;
      liveIdentityRef.current = null;
      generationRef.current++;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      cancelPromptScrolls();
      const activeWs = wsRef.current;
      if (activeWs) { activeWs.close(); wsRef.current = null; }
      disposeTerminal();
    };
  }, [admitAndConnect, disposeTerminal, trackPromptScroll, cancelPromptScrolls, retryEpoch, setError, sendInput, identity]);

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

  // Software keyboard: track focus in this input area and the visual
  // viewport (resize and offset-only movement). Other viewers never react.
  useEffect(() => {
    const area = rootRef.current;
    if (!area) return undefined;
    const vv = window.visualViewport;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const active = document.activeElement;
      setInputFocused(active instanceof HTMLTextAreaElement && area.contains(active));
      const next = keyboardBand(area);
      setKeyboard((prev) => {
        if (!next) return null;
        if (prev?.height !== next.height) return { ...next, cap: next.height, lift: 0 };
        return prev.top === next.top ? prev : { ...prev, top: next.top };
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    area.addEventListener("focusin", schedule);
    area.addEventListener("focusout", schedule);
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    // Focus (autoFocus) or a keyboard may already be present before these
    // listeners attach; measure once now.
    schedule();
    return () => {
      area.removeEventListener("focusin", schedule);
      area.removeEventListener("focusout", schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
      setKeyboard(null);
      setInputFocused(false);
    };
  }, [identity, error, fit]);

  // Fit the input area into the band, one pass per frame until stable:
  // scroll ancestors, cap its height to what is visible (font fitting and
  // panning absorb it; the native pane is never resized), then lift it when
  // no ancestor can scroll far enough (end of page, fixed popover). A new
  // band height reveals the prompt row, never during history reading.
  useEffect(() => {
    const area = rootRef.current;
    if (!keyboard) { promptRevealedForRef.current = null; return undefined; }
    if (!area) return undefined;
    const gen = generationRef.current;
    const frame = requestAnimationFrame(() => {
      if (generationRef.current !== gen || !area.isConnected) return;
      revealInBand(area, keyboard);
      const visible = visibleBox(area.parentElement, keyboard);
      const rect = area.getBoundingClientRect();
      const room = Math.max(0, Math.floor(visible.bottom - visible.top));
      if (rect.height > room + 1 && keyboard.cap > room) {
        setKeyboard((prev) => (prev && prev.height === keyboard.height ? { ...prev, cap: room } : prev));
        return;
      }
      const fittedTop = Math.min(Math.max(rect.top, visible.top), visible.bottom - rect.height);
      const lift = Math.max(0, Math.round(keyboard.lift + rect.top - fittedTop));
      if (lift !== keyboard.lift) {
        setKeyboard((prev) => (prev && prev.height === keyboard.height ? { ...prev, lift } : prev));
        return;
      }
      if (promptRevealedForRef.current === keyboard.height) return;
      promptRevealedForRef.current = keyboard.height;
      if (containerRef.current && scrollOffsetRef.current === 0) {
        trackPromptScroll(scrollTerminalViewportToPrompt(containerRef.current, () => generationRef.current === gen && scrollOffsetRef.current === 0));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboard, trackPromptScroll]);

  // Clipboard intent counter: each Copy/Paste tap, draft edit, Send, Close
  // and session change takes it, so a slower completion of an older
  // operation finds itself superseded and changes nothing, not even UI.
  // A layout effect: it runs in the commit of a new identity (never for an
  // abandoned render), before passive cleanup retires the old socket, so a
  // read settling in between cannot reach the previous seat.
  const clipboardOpRef = useRef(0);
  useLayoutEffect(() => {
    committedIdentityRef.current = identity;
    clipboardOpRef.current++;
    return () => { clipboardOpRef.current++; };
  }, [identity]);

  // Explicit taps only: nothing reads or writes the clipboard on its own.
  const copyToClipboard = useCallback(async () => {
    const term = termRef.current as XtermText | null;
    if (!term || !ownsLiveSeat()) return;
    const op = ++clipboardOpRef.current;
    const owns = () => mountedRef.current && clipboardOpRef.current === op;
    const { text, what } = terminalCopyText(term);
    if (!text) { setClipboard("Nothing to copy: the screen is empty."); return; }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (owns()) setClipboard(`Copied ${what} to the clipboard.`);
    } catch {
      if (owns()) setClipboard(`Not copied: this browser did not allow clipboard access here. Tap the box to select it all, then use your device's Copy.`, { mode: "copy", text });
    }
  }, [setClipboard]);

  // A refused fallback Send keeps its box and exact draft to edit and retry.
  const deliverPaste = useCallback((raw: string, retainOnFailure = false) => {
    const text = raw.replace(/\r\n?/g, "\n");
    const sent = sendInput(text, true);
    setClipboard(
      sent ? `Sent ${[...text].length} characters; no Enter key added. The receiving program controls newline handling.` : "Paste not sent; nothing reached the terminal.",
      !sent && retainOnFailure ? { mode: "paste", text: raw } : null,
    );
    return sent;
  }, [sendInput, setClipboard]);

  // The read is bound to this mount, generation and socket: a result that
  // arrives after a switch, reconnect or unmount is dropped, never delivered.
  // Superseded by a newer clipboard intent, it is dropped silently.
  const pasteFromClipboard = useCallback(async () => {
    const op = ++clipboardOpRef.current;
    const gen = generationRef.current, ws = wsRef.current;
    const owns = () => mountedRef.current && clipboardOpRef.current === op;
    if (!navigator.clipboard?.readText) {
      setClipboard("Reading the clipboard is not available here. Paste into the box, then Send.", { mode: "paste", text: "" });
      return;
    }
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      if (owns()) setClipboard("Clipboard access was refused. Paste into the box, then Send.", { mode: "paste", text: "" });
      return;
    }
    if (!owns()) return;
    if (generationRef.current !== gen || wsRef.current !== ws) { setClipboard("Clipboard paste discarded: the terminal reconnected or changed before the clipboard answered. Nothing was sent."); return; }
    if (!text) { setClipboard("The clipboard has no text to paste."); return; }
    deliverPaste(text);
  }, [deliverPaste, setClipboard]);

  if (error) {
    return (
      <div
        key={`focused-terminal-error-${sessionName}`}
        data-testid={`focused-terminal-${sessionName}`}
        // The terminal's own opaque plate, not the page surface: the light
        // copy stays readable on light and dark themes alike.
        style={{ backgroundColor: LIVE_TERMINAL_RENDER_BACKGROUND }}
        className="h-full w-full min-h-[200px] flex items-center justify-center px-4 py-3 text-center text-stone-200 font-mono text-xs"
      >
        <div className="flex flex-col items-center gap-2">
          <span role="alert" className="block max-w-[40ch] whitespace-normal break-words leading-relaxed">
            Terminal unavailable: {error}
          </span>
          <button
            type="button"
            onClick={() => { setError(null); setRetryEpoch((n) => n + 1); }}
            className="min-h-[44px] min-w-[44px] rounded border border-stone-500 bg-stone-800 px-4 text-stone-100 hover:bg-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-200"
          >
            Retry
          </button>
        </div>
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
  // Transport state lives outside the xterm host, which stays hidden until
  // the first native geometry (and keeps the same session's last display up
  // while a replacement socket verifies itself).
  const statusLine = status ? (
    <div
      data-testid={`focused-terminal-status-${sessionName}`}
      role="status"
      className="sticky left-0 top-0 z-10 shrink-0 px-2 py-1 font-mono text-[11px] leading-snug text-stone-300 bg-stone-900/90"
    >
      {status}
    </div>
  ) : null;

  // Enabled only while the current socket is verified (no connecting,
  // reconnecting or wake status). mouseDown is prevented so a click keeps
  // focus (and a phone's soft keyboard) where the operator was typing.
  const inputReady = geometryReady && status === null;
  const buttonClass = "min-h-[44px] min-w-[44px] shrink-0 rounded border border-stone-700 bg-stone-900 px-2 font-mono text-[11px] text-stone-200 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40";
  const notConnected = "Available once the live terminal is connected";
  // One scrolling row, so a phone keeps the most terminal above its keyboard.
  // Keyboard toggles: a trusted tap focuses the xterm input (showing the
  // software keyboard), or dismisses it when text input here has focus. It
  // never sends bytes.
  const keyBar = (
    <div className="sticky left-0 flex max-w-full shrink-0 gap-1 overflow-x-auto bg-stone-950/85 p-1">
      <div role="group" aria-label={`Terminal input for ${sessionName}`} className="flex shrink-0 gap-1">
        <button
          type="button"
          aria-label={inputFocused ? "Hide keyboard" : "Show keyboard"}
          title={inputFocused ? "Hide the keyboard" : inputReady ? "Focus the terminal and show the keyboard" : notConnected}
          disabled={!inputFocused && !inputReady}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const active = document.activeElement;
            if (inputFocused && active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
            else (termRef.current as { focus(): void } | null)?.focus();
          }}
          className={buttonClass}
        >
          {inputFocused ? "Hide keyboard" : "Keyboard"}
        </button>
        <button
          type="button"
          aria-label="Copy"
          title={geometryReady ? "Copy the selection, or the visible screen when nothing is selected" : notConnected}
          disabled={!geometryReady}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void copyToClipboard()}
          className={buttonClass}
        >
          Copy
        </button>
        <button
          type="button"
          aria-label="Paste"
          title={inputReady ? "Paste clipboard text literally; no Enter key is added" : notConnected}
          disabled={!inputReady}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void pasteFromClipboard()}
          className={buttonClass}
        >
          Paste
        </button>
      </div>
      <div role="group" aria-label={`Terminal keys for ${sessionName}`} className="flex shrink-0 gap-1">
        {TERMINAL_KEYS.map((key) => (
          <button
            key={key.name}
            type="button"
            aria-label={key.name}
            title={inputReady ? key.title : notConnected}
            disabled={!inputReady}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => sendInput(key.data)}
            className={buttonClass}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );

  const box = clipboard?.box ?? null;
  const clipboardLine = clipboard ? (
    <div className="sticky left-0 flex max-w-full shrink-0 flex-col gap-1 bg-stone-900/90 px-2 py-1 font-mono text-[11px] leading-snug text-stone-200">
      {clipboard.notice ? <div data-testid={`focused-terminal-clipboard-${sessionName}`} role="status">{clipboard.notice}</div> : null}
      {box ? (
        <div className="flex items-end gap-1">
          <textarea
            aria-label={box.mode === "copy" ? "Text to copy" : "Text to paste"}
            readOnly={box.mode === "copy"}
            value={box.text}
            rows={2}
            onFocus={box.mode === "copy" ? (event) => event.currentTarget.select() : undefined}
            onChange={(event) => { clipboardOpRef.current++; setClipboard(clipboard.notice, { mode: "paste", text: event.target.value }); }}
            className="min-w-0 flex-1 resize-none rounded border border-stone-700 bg-stone-950 p-1 text-[16px] text-stone-100"
          />
          {box.mode === "paste" ? (
            <button
              type="button"
              aria-label="Send paste"
              disabled={!inputReady || !box.text}
              onClick={() => { clipboardOpRef.current++; if (deliverPaste(box.text, true)) setClipboardState(null); }}
              className={buttonClass}
            >
              Send
            </button>
          ) : null}
          <button type="button" aria-label="Close" onClick={() => { clipboardOpRef.current++; setClipboardState(null); }} className={buttonClass}>
            Close
          </button>
        </div>
      ) : null}
    </div>
  ) : null;

  const inputWarningLine = inputWarning ? (
    <div
      data-testid={`focused-terminal-input-warning-${sessionName}`}
      role="alert"
      className="sticky left-0 max-w-full shrink-0 px-2 py-1 font-mono text-[11px] leading-snug text-amber-200 bg-stone-900/90"
    >
      {inputWarning}
    </div>
  ) : null;

  // Under a software keyboard the whole input area is capped to the visible
  // band (and lifted when nothing can scroll it there), opaque over what it
  // covers. Relative offset, not a transform: xterm hit-testing stays exact.
  const keyboardStyle: CSSProperties | undefined = keyboard ? {
    display: "flex",
    flexDirection: "column",
    maxHeight: `${keyboard.cap}px`,
    position: "relative",
    top: keyboard.lift ? `${-keyboard.lift}px` : undefined,
    zIndex: 1,
    backgroundColor: LIVE_TERMINAL_RENDER_BACKGROUND,
  } : undefined;
  const areaTestId = `focused-terminal-input-area-${sessionName}`;

  // Natural mode keeps native geometry; only under a keyboard does its
  // terminal part become a bounded local scroll area so the keys stay visible.
  if (fit === "natural") {
    return (
      <div ref={rootRef} data-testid={areaTestId} style={keyboardStyle}>
        <div
          {...(keyboard ? { [TERMINAL_SCROLL_OWNER_ATTR]: "" } : {})}
          style={keyboard ? { minHeight: 0, overflow: "auto" } : undefined}
        >
          {statusLine}
          {liveTerminal}
        </div>
        {inputWarningLine}
        {clipboardLine}
        {keyBar}
      </div>
    );
  }

  const geometryLabel = nativeGeometry ? `, native ${nativeGeometry.cols} by ${nativeGeometry.rows}` : "";
  // The key bar sits outside the scroll owner, so it is never panned away and
  // contain fitting measures only the space left above it. Under a software
  // keyboard the root is capped to the visible band; the fit wrapper shrinks.
  return (
    <div
      ref={rootRef}
      data-testid={areaTestId}
      className={fit === "contain" ? "flex h-full w-full min-w-0 flex-col" : "flex w-full min-w-0 flex-col"}
      style={keyboardStyle}
    >
      <div
        ref={fitWrapperRef}
        {...{ [TERMINAL_SCROLL_OWNER_ATTR]: "" }}
        data-testid={`focused-terminal-fit-${sessionName}`}
        data-terminal-overflow={pans ? "pan" : "fit"}
        role="group"
        aria-label={`Terminal ${sessionName}${geometryLabel}${pans ? "; scroll to pan the full pane" : ""}`}
        className={
          fit === "contain"
            ? "flex min-h-0 flex-1 flex-col w-full min-w-0 overflow-auto"
            : "w-full min-w-0 max-w-full overflow-auto"
        }
      >
        {statusLine}
        {liveTerminal}
      </div>
      {inputWarningLine}
      {clipboardLine}
      {keyBar}
    </div>
  );
}
