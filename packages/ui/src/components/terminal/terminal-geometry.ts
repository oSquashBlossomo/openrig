// Shared appearance and static preview dimensions. Live mirrors adopt actual
// native pane dimensions from protocol 2; these values only initialize xterm.
// Kept dependency-free so static previews do not pull in the xterm bundle.

export const LIVE_TERMINAL_RENDER_BACKGROUND = "#0c0a09";
export const LIVE_TERMINAL_COLS = 90;
export const LIVE_TERMINAL_ROWS = 27;
export const LIVE_TERMINAL_FONT_SIZE = 12;
export const LIVE_TERMINAL_LINE_HEIGHT = 1;
export const LIVE_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

export type TerminalServerFrame =
  | { type: "geometry"; cols: number; rows: number }
  | { type: "output"; data: string };

/** Bounds match the daemon broker; native output is always an explicit data frame. */
export function parseTerminalServerFrame(data: string): TerminalServerFrame {
  let frame: Partial<TerminalServerFrame>;
  try { frame = JSON.parse(data); } catch { throw new Error("terminal protocol update required; update the daemon and reload the web UI"); }
  if (frame?.type === "geometry") {
    if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows)
      || frame.cols! < 1 || frame.cols! > 500 || frame.rows! < 1 || frame.rows! > 300
      || frame.cols! * frame.rows! > 100_000) throw new Error("invalid terminal geometry from daemon");
    return frame as TerminalServerFrame;
  }
  if (frame?.type === "output" && typeof frame.data === "string") return frame as TerminalServerFrame;
  throw new Error("invalid terminal frame from daemon");
}
