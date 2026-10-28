// A live seat terminal: the daemon's broker paints a fixed 90x27 tmux pane
// over a WebSocket; we render it in xterm, send keys back, and scroll history
// server-side. Font size follows the container width so a phone pans and an
// iPad reads.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { KEY_BAR, mapXtermInput, type WsMessage } from "../terminal-input.js";
import { terminalToken } from "../api.js";

export const COLS = 90;
export const ROWS = 27;
const BASE_FONT = 12;
const MIN_FONT = 8;
const MAX_FONT = 15;
const FONT = "ui-monospace, 'SF Mono', Menlo, 'JetBrains Mono', monospace";
const BG = "#0b0d10";

type Status = { state: "connecting" | "live" | "reconnecting" | "closed"; detail?: string };

export function SeatTerminal({ session, hostId = "local" }: { session: string; hostId?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const offsetRef = useRef(0);
  const [status, setStatus] = useState<Status>({ state: "connecting" });

  const send = useCallback((msg: WsMessage | { type: "scroll"; offset: number }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const scrollBy = useCallback((lines: number) => {
    offsetRef.current = Math.max(0, offsetRef.current + lines);
    send({ type: "scroll", offset: offsetRef.current });
  }, [send]);

  const pressKey = useCallback((key: string) => {
    if (offsetRef.current) { offsetRef.current = 0; send({ type: "scroll", offset: 0 }); }
    send({ type: "keys", keys: [key] });
    termRef.current?.focus();
  }, [send]);

  useEffect(() => {
    const host = hostRef.current;
    const box = boxRef.current;
    if (!host || !box) return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const term = new XTerm({
      cols: COLS, rows: ROWS, fontSize: BASE_FONT, fontFamily: FONT, lineHeight: 1.15,
      cursorBlink: true, allowTransparency: false, scrollback: 0,
      theme: { background: BG, foreground: "#e6e9ef", cursor: "#e6e9ef" },
    });
    term.open(host);
    termRef.current = term;
    term.onData((data) => {
      if (offsetRef.current) { offsetRef.current = 0; send({ type: "scroll", offset: 0 }); }
      for (const m of mapXtermInput(data)) send(m);
    });
    term.attachCustomWheelEventHandler((ev) => {
      if (ev.deltaY === 0) return true;
      scrollBy(ev.deltaY < 0 ? 3 : -3);
      return false;
    });

    // Fit: pick the font size at which 90 columns fill the box, within readable bounds.
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${BASE_FONT}px ${FONT}`;
    probe.textContent = "M".repeat(COLS);
    box.appendChild(probe);
    const fit = () => {
      const natural = probe.getBoundingClientRect().width || 1;
      const size = Math.floor(BASE_FONT * (box.clientWidth - 8) / natural);
      term.options.fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, size));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);

    // Touch: drag vertically to page through tmux history.
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (touchY === null || y === undefined) return;
      const dy = y - touchY;
      if (Math.abs(dy) >= 18) { scrollBy(dy > 0 ? 2 : -2); touchY = y; }
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: true });

    const connect = () => {
      if (!alive) return;
      const token = terminalToken();
      const base = window.location.origin.replace(/^http/, "ws");
      const params = new URLSearchParams({ host: hostId });
      if (token) params.set("token", token);
      const ws = new WebSocket(`${base}/api/terminal/${encodeURIComponent(session)}?${params}`);
      wsRef.current = ws;
      ws.onopen = () => { offsetRef.current = 0; setStatus({ state: "live" }); };
      ws.onmessage = (ev) => { if (typeof ev.data === "string") term.write(ev.data); };
      ws.onclose = (ev) => {
        if (!alive) return;
        wsRef.current = null;
        if (ev.code === 1008 || ev.code === 1011 || ev.code === 1001) {
          setStatus({ state: "closed", detail: ev.reason || "session not found on this daemon" });
          return;
        }
        setStatus({ state: "reconnecting", detail: ev.reason || undefined });
        retry = setTimeout(connect, 3000);
      };
    };
    connect();

    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      ro.disconnect();
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      probe.remove();
    };
  }, [session, hostId, send, scrollBy]);

  return (
    <div className="term">
      <div className="term-bar">
        <span className={`term-status term-${status.state}`}>
          {status.state === "live" ? "live" : status.state === "connecting" ? "connecting…" : status.state === "reconnecting" ? "reconnecting…" : "closed"}
          {status.detail ? ` · ${status.detail}` : ""}
        </span>
        <span className="term-geom">{COLS}×{ROWS}</span>
      </div>
      <div className="term-box" ref={boxRef}>
        <div className="term-host" ref={hostRef} />
      </div>
      <div className="keybar" role="toolbar" aria-label="terminal keys">
        {KEY_BAR.map((k) => (
          <button key={k.key} type="button" onClick={() => pressKey(k.key)} disabled={status.state !== "live"}>{k.label}</button>
        ))}
        <button type="button" onClick={() => scrollBy(ROWS)} disabled={status.state !== "live"} title="older output">⇞</button>
        <button type="button" onClick={() => { offsetRef.current = 0; send({ type: "scroll", offset: 0 }); }} disabled={status.state !== "live"} title="back to live">⇟</button>
      </div>
    </div>
  );
}
