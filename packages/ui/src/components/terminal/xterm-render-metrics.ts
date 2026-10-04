// xterm 6.0.0 updates its renderer synchronously when fontSize changes, but its
// Viewport only resyncs the scrollbar on buffer resize/activate/scroll and the
// IME helper textarea only moves on cursor movement (Viewport.ts:96,
// CoreBrowserTerminal.ts:301; upstream master is unchanged as of 2026-10). A
// font-only fit therefore leaves the old-size physical scrollbar and caret
// protruding below the smaller screen, which the browser counts as overflow
// and scrolls into view on typing. There is no public API for this: a
// same-size resize() returns early and scrollToBottom() is a no-op at the live
// bottom. This bridge invokes xterm's own sync routines - the same ones a
// buffer scroll would run - without touching buffer contents, logical
// scrollback, native geometry or the scroll line. Order matters: the scrollbar
// dimensions must be current before the line is re-expressed in pixels.
// Translating first (new cell height, old bounds) lets xterm clamp the offset
// and convert it back into a logical scroll - e.g. growing 8px to 17px moved a
// live viewportY 24 to 11. It is feature-detected and
// reports false when the installed xterm no longer has this shape, so an
// upgrade fails the real-xterm regression instead of failing silently.
import type { Terminal } from "@xterm/xterm";

interface XtermViewportInternals {
  /** Sizes the scrollbar from current render metrics; its scroll handler is suppressed while bounds clamp. */
  _sync?: (ydisp?: number) => void;
  scrollToLine?: (line: number, disableSmoothScroll?: boolean) => void;
}

interface XtermCoreInternals {
  _viewport?: XtermViewportInternals;
  _syncTextArea?: () => void;
}

export function resyncXtermRenderMetrics(term: Pick<Terminal, "buffer">): boolean {
  const core = (term as unknown as { _core?: XtermCoreInternals })._core;
  const viewport = core?._viewport;
  if (!core || typeof viewport?._sync !== "function" || typeof viewport.scrollToLine !== "function") return false;
  const line = term.buffer?.active?.viewportY;
  if (typeof line !== "number") return false;
  // 1. Current bounds first. Any clamp of the old pixel offset happens with
  //    xterm's scroll handler suppressed, so no logical scroll is emitted.
  viewport._sync(line);
  // 2. Re-express the saved line at the current cell height. line x cell is
  //    within the new bounds, so the handler computes the same line (diff 0).
  viewport.scrollToLine(line, true);
  // Skips itself during IME composition or when the cursor is off-screen.
  if (typeof core._syncTextArea === "function") core._syncTextArea();
  return true;
}

/**
 * Apply a font size and keep xterm's physical metrics current, now and after
 * the renderer's next frame. Returns a disposer for the pending frame hook.
 */
export function setXtermFontSize(
  term: Pick<Terminal, "buffer" | "options"> & Partial<Pick<Terminal, "onRender">>,
  fontSize: number,
): () => void {
  term.options.fontSize = fontSize;
  resyncXtermRenderMetrics(term);
  if (typeof term.onRender !== "function") return () => {};
  const subscription = term.onRender(() => {
    subscription.dispose();
    resyncXtermRenderMetrics(term);
  });
  return () => subscription.dispose();
}
