// Thirty minutes of message traffic as a histogram you can scrub. Dragging
// puts the map into replay; "live" brings it back.
import { useRef } from "react";

export const WINDOW_MS = 30 * 60_000;

type Props = {
  bars: number[];
  now: number;
  mode: "live" | "replay";
  cursor: number;
  playing: boolean;
  onScrub: (t: number) => void;
  onLive: () => void;
  onTogglePlay: () => void;
};

export function Timeline({ bars, now, mode, cursor, playing, onScrub, onLive, onTogglePlay }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const max = Math.max(1, ...bars);
  const start = now - WINDOW_MS;
  const frac = mode === "live" ? 1 : Math.max(0, Math.min(1, (cursor - start) / WINDOW_MS));
  const toTime = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return start + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * WINDOW_MS;
  };
  const total = bars.reduce((a, b) => a + b, 0);
  return (
    <div className="timeline">
      <div className="timeline-side">
        <button type="button" className={`tl-live ${mode === "live" ? "on" : ""}`} onClick={onLive}>{mode === "live" ? "● live" : "go live"}</button>
        <button type="button" className="tl-play" onClick={onTogglePlay} disabled={mode === "live"} aria-label={playing ? "pause replay" : "play replay"}>{playing ? "❚❚" : "▶"}</button>
      </div>
      <div
        className="tl-bars"
        ref={ref}
        role="slider"
        aria-label="replay position over the last 30 minutes"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        tabIndex={0}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); onScrub(toTime(e.clientX)); }}
        onPointerMove={(e) => { if (e.buttons & 1) onScrub(toTime(e.clientX)); }}
        onKeyDown={(e) => {
          const step = WINDOW_MS / bars.length;
          if (e.key === "ArrowLeft") onScrub((mode === "live" ? now : cursor) - step);
          if (e.key === "ArrowRight") onScrub(Math.min(now, cursor + step));
        }}
      >
        {bars.map((b, i) => (
          <i key={i} style={{ height: `${Math.max(b ? 12 : 3, (b / max) * 100)}%` }} className={i / bars.length <= frac ? "past" : "future"} />
        ))}
        <span className="tl-cursor" style={{ left: `${frac * 100}%` }} />
        <span className="tl-tick" style={{ left: 0 }}>−30m</span>
        <span className="tl-tick" style={{ left: "50%" }}>−15m</span>
        <span className="tl-tick" style={{ right: 0 }}>now</span>
      </div>
      <div className="tl-meta">{total} message{total === 1 ? "" : "s"}{mode === "replay" ? ` · replaying ${Math.round((now - cursor) / 60_000)}m ago` : ""}</div>
    </div>
  );
}
