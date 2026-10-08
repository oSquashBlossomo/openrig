import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { TmuxResult, TmuxCursorPosition } from "../adapters/tmux.js";

// OPR.0.4.0.38 - real-terminal session broker.
//
// The product invariant from the founder is: NO LIVE TERMINAL LIES. A live
// terminal surface must show the true session state and report honestly when a
// session dies - never a silently stale "live" pane.
//
// Before this slice, every WebSocket connection opened its OWN tmux pipe-pane
// for the same session (the per-connection bug): a second viewer of one seat
// fought the first for output. The broker fixes that: ONE tmux pipe per
// session, MANY subscribers, output fanned out to all, each subscriber seeded
// with actual native geometry followed by a cursor-safe screen snapshot on attach
// (no shared-pane resize), honest session-death reporting to ALL subscribers,
// and full cleanup when the last subscriber leaves.

const PIPE_PANE_POLL_MS = 50;
const MAX_OUTPUT_BUFFER = 64 * 1024;
const DEFAULT_LIVENESS_MS = 2000;
const MAX_DISPLAY_ATTEMPTS = 3;
const GEOMETRY_UNAVAILABLE = "terminal geometry unavailable or outside supported bounds";
const SCREEN_BUSY = "terminal screen remained busy; reopen to retry";

class BusyScreenError extends Error {}
class ScreenCaptureError extends Error {}

/**
 * Bounded size of the broker-owned recent-output history ring (AC-5 / FR-4).
 * Mirrors the 64KB per-read tail sizing: a session-level window of recent
 * output, replayed to late subscribers so they share the scrollback the
 * earlier subscribers have - NOT per-xterm local. Bounded so a long-lived
 * session never accumulates unbounded memory.
 */
const MAX_HISTORY_BYTES = 64 * 1024;

/** Bounds shared with the browser decoder. Geometry outside these limits is unavailable. */
export const MAX_TERMINAL_COLS = 500;
export const MAX_TERMINAL_ROWS = 300;
export const MAX_TERMINAL_CELLS = 100_000;

class GeometryLimitError extends Error {
  constructor(cursor: TmuxCursorPosition) {
    const actual = Number.isSafeInteger(cursor.width) && Number.isSafeInteger(cursor.height)
      ? `${cursor.width}x${cursor.height}; ` : "";
    super(`terminal geometry exceeds browser display limits (${actual}max ${MAX_TERMINAL_COLS}x${MAX_TERMINAL_ROWS}, ${MAX_TERMINAL_CELLS} cells)`);
  }
}

function geometryError(cursor: TmuxCursorPosition | null): Error {
  if (cursor && Number.isInteger(cursor.width) && Number.isInteger(cursor.height)
    && cursor.width > 0 && cursor.height > 0
    && (cursor.width > MAX_TERMINAL_COLS || cursor.height > MAX_TERMINAL_ROWS
      || cursor.width * cursor.height > MAX_TERMINAL_CELLS)) return new GeometryLimitError(cursor);
  return new Error(GEOMETRY_UNAVAILABLE);
}

function displayErrorReason(error: unknown): string {
  if (error instanceof BusyScreenError || error instanceof GeometryLimitError || error instanceof ScreenCaptureError) return error.message;
  return GEOMETRY_UNAVAILABLE;
}

function validCursor(cursor: TmuxCursorPosition | null): cursor is TmuxCursorPosition {
  return !!cursor && [cursor.x, cursor.y, cursor.width, cursor.height].every(Number.isInteger)
    && cursor.width > 0 && cursor.width <= MAX_TERMINAL_COLS && cursor.height > 0 && cursor.height <= MAX_TERMINAL_ROWS
    && cursor.width * cursor.height <= MAX_TERMINAL_CELLS
    // x==width is tmux's legitimate deferred-wrap cursor, not a cell address.
    && cursor.x >= 0 && cursor.x <= cursor.width && cursor.y >= 0 && cursor.y < cursor.height;
}

/** A connected viewer of one broker. The route adapts a WebSocket to this. */
export interface TerminalSubscriber {
  send(data: string): void;
  /** Geometry is delivered before screen/history bytes and on native size changes. */
  geometry?(cols: number, rows: number): void;
  close(code: number, reason: string): void;
}

/**
 * The subset of TmuxAdapter the broker drives. Declared structurally so the
 * broker is unit-testable with a plain mock; the real TmuxAdapter satisfies it.
 */
export interface BrokerTmux {
  humanInput?<T>(name: string, fn: () => Promise<T>): Promise<T>;
  hasSession(name: string): Promise<boolean>;
  setWindowOption?(name: string, option: string, value: string): Promise<TmuxResult>;
  resizeWindow?(name: string, cols: number, rows: number): Promise<TmuxResult>;
  startPipePane(name: string, outputPath: string): Promise<TmuxResult>;
  stopPipePane(name: string): Promise<TmuxResult>;
  sendKeys(name: string, keys: string[]): Promise<TmuxResult>;
  sendText(name: string, text: string): Promise<TmuxResult>;
  capturePaneScreen(name: string, preserveTrailingSpaces?: boolean): Promise<string | null>;
  getPaneCursorPosition(name: string): Promise<TmuxCursorPosition | null>;
  /** Atomic screen/cursor observation; absent adapters retain the bounded quiet-only path. */
  capturePaneObservation?(name: string): Promise<{ snapshot: string; cursor: TmuxCursorPosition } | null>;
  /** Capture the last `lines` lines INCLUDING scrollback history (tmux
   *  capture-pane -S -lines). Used for the per-subscriber scroll-back window. */
  capturePaneContent(name: string, lines: number): Promise<string | null>;
}

export interface BrokerOptions {
  /** File-tail poll interval (ms). Default 50. */
  pollMs?: number;
  /** Session-liveness probe interval (ms). Default 2000. */
  livenessMs?: number;
  /** Read-only native geometry poll interval, default 250ms. */
  geometryMs?: number;
  /** Bounded size of the recent-output history ring in bytes. Default 64KB. */
  maxHistoryBytes?: number;
  /** Called when the broker has no remaining subscribers (or open failed). */
  onEmpty?: (sessionName: string) => void;
}

/** Client-driven input. There is deliberately NO resize message (FR-7). */
export type TerminalInputMessage =
  | { type: "keys"; keys: string[] }
  | { type: "text"; text: string };

/** ANSI 1-based absolute cursor move (terminal coords are 1-based; tmux is 0-based). */
export function cursorPositionEscape(x: number, y: number): string {
  return `\x1b[${y + 1};${x + 1}H`;
}

/**
 * Build the cursor-safe seed escape sequence for a captured screen. Each row is
 * painted with an ABSOLUTE cursor move so the client renders the screen at the
 * exact same rows tmux has it - never a relative append that drifts as content
 * scrolls. Normalizes CRLF, drops one trailing print newline, and (when a pane
 * height is known and the capture is taller) keeps only the last `height` rows.
 * Lifted from the FR-4 seed work.
 */
export function screenSnapshotEscape(
  snapshot: string,
  cursor: { x: number; y: number; width?: number; height?: number } | null,
): string {
  const normalized = snapshot.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutTrailingPrintNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  const rows = withoutTrailingPrintNewline.split("\n");
  const visibleRows = cursor?.height && rows.length > cursor.height
    ? rows.slice(rows.length - cursor.height)
    : rows;

  // tmux x==width is the deferred-wrap position after filling the last cell.
  // CUP to width+1 clamps in xterm and loses that state. Paint this row last,
  // including its captured trailing spaces, and leave its printing cursor alone.
  const pendingWrap = cursor?.width !== undefined && cursor.x === cursor.width;
  const paintedRows = visibleRows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => pendingWrap ? Number(a.index === cursor!.y) - Number(b.index === cursor!.y) : 0)
    .map(({ row, index }) => `\x1b[${index + 1};1H${row}`)
    .join("");

  return `\x1b[2J${paintedRows}${pendingWrap ? "" : cursor ? cursorPositionEscape(cursor.x, cursor.y) : "\x1b[H"}`;
}

/**
 * Raw pipe output from a full-screen TUI is a repaint stream, not durable
 * scrollback. Replaying cursor-addressed history into a fresh xterm before the
 * current snapshot causes stale prompt/status rows to appear above or under the
 * real screen. Preserve the AC-5 shared-history behavior for plain line output
 * (and simple SGR color), but skip history that contains cursor movement,
 * erase, alternate-screen, OSC, or carriage-return repaint semantics.
 */
export function isSafeHistoryReplay(data: string): boolean {
  if (!data) return false;
  if (/\r(?!\n)/.test(data)) return false;

  const escapePattern = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[\(\)][ -~]|[@-Z\\-_])/g;
  let match: RegExpExecArray | null;
  while ((match = escapePattern.exec(data)) !== null) {
    const sequence = match[0];
    const final = sequence.at(-1);
    if (final !== "m") return false;
  }
  return true;
}

/**
 * One broker per live tmux session. Owns a single pipe-pane and fans its output
 * out to every attached subscriber.
 */
export class TerminalSessionBroker {
  readonly sessionName: string;
  private readonly tmux: BrokerTmux;
  private readonly pollMs: number;
  private readonly livenessMs: number;
  private cols = 0;
  private rows = 0;
  private readonly geometryMs: number;
  private lastGeometryRead = 0;
  private displayQueue: Promise<void> = Promise.resolve();
  private tickPending = false;
  private displayFailures = 0;
  private attaching = 0;
  private readonly pendingRepaints = new Set<TerminalSubscriber>();
  // Busy newcomers see authoritative snapshots, never deltas with an unknown base.
  // They join raw fanout only after the ordinary quiet pipe/screen fence succeeds.
  private readonly snapshotOnly = new Map<TerminalSubscriber, { failures: number; replayHistory: boolean }>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settleResolve: (() => void) | null = null;
  private readonly maxHistoryBytes: number;
  private readonly onEmpty?: (sessionName: string) => void;

  private readonly subscribers = new Set<TerminalSubscriber>();
  // OPR.0.4.0.39: per-subscriber scroll-back offset (lines above the live bottom).
  // 0/absent = live. A scrolled subscriber is PAINTED a tmux history window and is
  // SKIPPED by the live fanout (so live output doesn't yank it back); read-only on
  // the pane (capture-pane), so every viewer scrolls independently and nobody else's
  // live view is disturbed (multi-subscriber-safe scrollback - vs pane-global copy-mode).
  private readonly scrollOffsets = new Map<TerminalSubscriber, number>();
  private readonly returningToLive = new Map<TerminalSubscriber, number>();
  // Broker-owned recent-output ring (AC-5): raw fanned-out bytes, bounded,
  // replayed to late subscribers so their scrollback matches the earlier ones.
  private history: string[] = [];
  private historyBytes = 0;
  private outputPath: string | null = null;
  private pipeActive = false;
  private tailInterval: ReturnType<typeof setInterval> | null = null;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;
  private lastSize = 0;
  private outputDecoder = new StringDecoder("utf8");
  private inputQueue: Promise<void> = Promise.resolve();
  // Singleflight the pipe-open as a shared promise so EVERY concurrent attach
  // awaits the SAME open result before it seeds/adds (a bare boolean would let a
  // later attach add itself before the open result is known, then never be
  // closed if the open fails). Null until the first attach starts the open.
  private openPromise: Promise<{ ok: true } | { ok: false; code: number; reason: string }> | null = null;
  private tailStarted = false;
  private torndown = false;
  private shutdownPromise: Promise<void> = Promise.resolve();
  // The honest close reason a subscriber should get if it resumes (after an
  // async open/seed) to find the broker already torn down. Set on every
  // teardown path so a late/racing attach never goes silently live.
  private lastClose: { code: number; reason: string } | null = null;

  constructor(sessionName: string, tmux: BrokerTmux, opts: BrokerOptions = {}) {
    this.sessionName = sessionName;
    this.tmux = tmux;
    this.pollMs = opts.pollMs ?? PIPE_PANE_POLL_MS;
    this.livenessMs = opts.livenessMs ?? DEFAULT_LIVENESS_MS;
    this.geometryMs = opts.geometryMs ?? 250;
    this.maxHistoryBytes = opts.maxHistoryBytes ?? MAX_HISTORY_BYTES;
    this.onEmpty = opts.onEmpty;
  }

  get isClosing(): boolean { return this.torndown; }

  waitForShutdown(): Promise<void> { return this.shutdownPromise; }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Current size of the broker-owned history ring in bytes (bounded). */
  get historyByteLength(): number {
    return this.historyBytes;
  }

  /** The session-scoped pipe output file (one per session). Null until open. */
  get pipeOutputPath(): string | null {
    return this.outputPath;
  }

  /**
   * Attach a subscriber. The FIRST subscriber stands up the single pipe-pane
   * (one outputPath, tail + liveness). Every subscriber - first
   * or later - is seeded with the current screen BEFORE it joins the fanout, so
   * it sees coherent state immediately and does not depend on a resize message.
   */
  async attach(sub: TerminalSubscriber): Promise<void> {
    this.attaching++;
    try { await this.attachSubscriber(sub); } finally {
      this.attaching--;
      // An unsuccessful seed must clean up a first/last viewer's pipe without
      // disposing another viewer or a concurrent attachment still being seeded.
      if (!this.attaching && !this.subscribers.size) await this.teardown();
    }
  }

  private async attachSubscriber(sub: TerminalSubscriber): Promise<void> {
    if (this.torndown) {
      this.closeTorndown(sub);
      return;
    }
    // Start the single pipe-open exactly once; every concurrent attach awaits
    // the SAME result before it seeds/adds.
    if (!this.openPromise) {
      this.openPromise = this.openPipe();
    }
    const open = await this.openPromise;

    // The broker may have been torn down while we awaited - a co-waiter's open
    // failed, or the session died. Close this subscriber HONESTLY; never leave a
    // live-looking subscriber on a dead broker (the no-live-terminal-lies rule).
    if (this.torndown) {
      this.closeTorndown(sub);
      return;
    }

    if (!open.ok) {
      // Open failed: remember the reason and tear down ONCE, then close THIS
      // subscriber. Every co-waiter takes a torndown branch and closes with the
      // same remembered reason - none is left live.
      await this.teardown({ code: open.code, reason: open.reason });
      sub.close(open.code, open.reason);
      return;
    }

    // Open succeeded: seed this subscriber (ring replay + current screen) BEFORE
    // it joins the fanout.
    try { await this.enqueueDisplay(() => this.seed(sub)); } catch (error) {
      await this.closeFailedSeed(sub, error);
      return;
    }
    // RECHECK after the async seed: liveness/dispose may have torn the broker
    // down while the capture was pending. Never add a subscriber to a dead
    // broker - close it honestly with the remembered teardown reason.
    if (this.torndown) {
      this.closeTorndown(sub);
      return;
    }
    this.subscribers.add(sub);
    if (!this.tailStarted) {
      this.tailStarted = true;
      this.startTail();
      this.startLiveness();
    }
  }

  /** Close a subscriber that resumed after teardown, with the remembered reason. */
  private closeTorndown(sub: TerminalSubscriber): void {
    const c = this.lastClose ?? { code: 1011, reason: "terminal broker unavailable" };
    try {
      sub.close(c.code, c.reason);
    } catch {
      // already-closed subscriber is fine
    }
  }

  /** Forward client input to tmux, serialized so rapid input keeps order (FR-3). */
  async input(msg: TerminalInputMessage): Promise<void> {
    if (this.torndown) return;
    await this.enqueueInput(async () => {
      const write = async () => {
        if (msg.type === "keys") await this.tmux.sendKeys(this.sessionName, msg.keys);
        else if (msg.type === "text") await this.tmux.sendText(this.sessionName, msg.text);
      };
      if (this.tmux.humanInput) await this.tmux.humanInput(this.sessionName, write);
      else await write();
    });
  }

  /**
   * OPR.0.4.0.39: per-subscriber scroll-back. `offset` = lines above the live
   * bottom (0 = live). Reads tmux scrollback via capture-pane (READ-ONLY on the
   * pane, so it never disturbs the live view of OTHER subscribers) and paints the
   * windowed history to THIS subscriber. At offset 0 it repaints the current screen
   * and the subscriber rejoins the live fanout.
   */
  async scroll(sub: TerminalSubscriber, offset: number): Promise<void> {
    if (!Number.isFinite(offset)) return;
    try { await this.enqueueDisplay(() => this.paintScroll(sub, Math.min(100_000, offset))); } catch (error) { await this.recoverDisplay(error); }
  }

  private async paintScroll(sub: TerminalSubscriber, offset: number): Promise<void> {
    if (this.torndown || !this.subscribers.has(sub)) return;
    const clamped = Math.max(0, Math.floor(offset));
    if (clamped === 0) {
      // Keep a history viewer out of delta fanout until a valid live seed is sent.
      if ((this.scrollOffsets.get(sub) ?? 0) > 0 && !this.returningToLive.has(sub)) {
        this.returningToLive.set(sub, 0);
      }
      await this.repaintScreen(sub);
      return;
    }
    this.returningToLive.delete(sub);
    this.snapshotOnly.delete(sub);
    this.scrollOffsets.set(sub, clamped);
    // tmux `capture-pane -p -S -(offset+rows)` returns a buffer that ENDS at the live
    // bottom (verified against real tmux: `-S -N` returns ~N history lines above the
    // visible screen PLUS the screen, ending at the bottom row). To show a window
    // `offset` lines ABOVE the live bottom, the slice must be BOTTOM-anchored: drop
    // the last `offset` lines (toward live) and take the `rows` above them. Slicing
    // the TOP `rows` would jump a whole extra screen up on the first wheel notch.
    let content: string | null = null;
    try {
      content = await this.tmux.capturePaneContent(this.sessionName, clamped + this.rows);
    } catch {
      content = null;
    }
    if (content === null) return;
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    // Drop a single trailing empty line (capture-pane's trailing newline) so the last
    // element is the true live-bottom row and the offset stays honest.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const bottom = lines.length - clamped; // exclusive end: the window sits `offset` up
    const window = bottom <= this.rows
      ? lines.slice(0, this.rows) // scrolled at/past the top of history: oldest screenful
      : lines.slice(bottom - this.rows, bottom);
    try {
      sub.send(screenSnapshotEscape(window.join("\n"), null));
    } catch { /* dead subscriber */ }
  }

  /** Repaint the current visible screen to ONE subscriber (scroll-back to live). */
  private async repaintScreen(sub: TerminalSubscriber): Promise<void> {
    const screen = await this.readScreen();
    this.applyGeometry(screen.cursor);
    this.readTail();
    this.pendingRepaints.add(sub);
    await this.repaintPending(screen);
  }

  private pipeSize(): number {
    return this.outputPath ? fs.statSync(this.outputPath).size : 0;
  }

  private async settlePipe(): Promise<void> {
    if (this.torndown) return;
    await new Promise<void>((resolve) => {
      this.settleResolve = resolve;
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.settleResolve = null;
        resolve();
      }, Math.min(this.pollMs, 50));
    });
  }

  private async readScreen(): Promise<{ snapshot: string; cursor: TmuxCursorPosition; position: number; stable: boolean; atomic: boolean }> {
    // Native geometry can change between reads. Output has no atomic shared
    // sequence with capture-pane: use a bounded quiet sample, never skip bytes
    // to make a snapshot look current. Atomic observations may paint busy snapshot
    // viewers; raw viewers still require the quiet fence before a repaint.
    let failure = new Error(GEOMETRY_UNAVAILABLE);
    let changingScreen: { snapshot: string; cursor: TmuxCursorPosition; position: number; stable: false; atomic: false } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const position = this.pipeSize();
      const observed = this.tmux.capturePaneObservation ? await this.tmux.capturePaneObservation(this.sessionName) : undefined;
      // Unsupported atomic observations (for example configured after-hooks)
      // retain the legacy quiet fence, but can never admit busy snapshots.
      const before = observed?.cursor ?? await this.tmux.getPaneCursorPosition(this.sessionName);
      if (!validCursor(before)) throw geometryError(before);
      const snapshot = observed?.snapshot ?? await this.tmux.capturePaneScreen(this.sessionName, true);
      if (snapshot === null) throw new ScreenCaptureError("terminal screen capture unavailable; reopen to retry");
      await this.settlePipe();
      const cursor = await this.tmux.getPaneCursorPosition(this.sessionName);
      if (observed && validCursor(cursor)) {
        return { snapshot, cursor: before, position, atomic: true,
          stable: position === this.lastSize && position === this.pipeSize()
            && before.width === cursor.width && before.height === cursor.height && before.x === cursor.x && before.y === cursor.y };
      }
      if (validCursor(cursor) && before.width === cursor.width && before.height === cursor.height) {
        return { snapshot, cursor, position, atomic: false, stable: position === this.lastSize && position === this.pipeSize()
          && before.x === cursor.x && before.y === cursor.y };
      }
      if (validCursor(cursor)) {
        // Both native sizes are valid, but this capture belongs to the old
        // size. Keep the latest geometry without painting this snapshot or
        // treating an owner's ongoing resize as a shared display failure.
        changingScreen = { snapshot, cursor, position, stable: false, atomic: false };
      } else {
        changingScreen = undefined;
        failure = geometryError(cursor);
      }
    }
    if (changingScreen) return changingScreen;
    throw failure;
  }

  private applyGeometry(cursor: TmuxCursorPosition): void {
    if (this.torndown || (this.cols === cursor.width && this.rows === cursor.height)) return;
    // Drop old-size replay history, but keep the consumed cursor and decoder.
    // Every unread byte, including a partial UTF-8 sequence, must still stream.
    this.history = []; this.historyBytes = 0;
    this.cols = cursor.width; this.rows = cursor.height;
    for (const sub of this.subscribers) {
      try { sub.geometry?.(this.cols, this.rows); } catch { this.detach(sub); continue; }
      this.pendingRepaints.add(sub);
    }
  }

  private async repaintPending(screen: Awaited<ReturnType<TerminalSessionBroker["readScreen"]>>): Promise<void> {
    if (this.torndown) return;
    if (!screen.stable || screen.position !== this.lastSize || screen.position !== this.pipeSize()) {
      if (screen.atomic) {
        for (const sub of this.pendingRepaints) {
          if (!this.subscribers.has(sub) || (!this.snapshotOnly.has(sub) && !this.returningToLive.has(sub))) continue;
          this.snapshotOnly.set(sub, { failures: 0, replayHistory: this.snapshotOnly.get(sub)?.replayHistory ?? false });
          this.scrollOffsets.delete(sub);
          this.returningToLive.delete(sub);
          try { sub.send(screenSnapshotEscape(screen.snapshot, screen.cursor)); } catch { this.detach(sub); }
        }
        return;
      }
      // Adapters without an atomic observation still cannot paint a busy capture.
      for (const sub of new Set([...this.returningToLive.keys(), ...this.snapshotOnly.keys()])) {
        const snapshot = this.snapshotOnly.get(sub);
        const attempts = snapshot?.failures ?? this.returningToLive.get(sub) ?? 0;
        if (attempts + 1 < MAX_DISPLAY_ATTEMPTS) {
          if (snapshot) snapshot.failures++;
          else this.returningToLive.set(sub, attempts + 1);
        } else {
          try { sub.close(1011, SCREEN_BUSY); } catch { /* dead subscriber */ }
          this.detach(sub);
        }
      }
      return;
    }
    for (const sub of [...this.pendingRepaints]) {
      if (!this.subscribers.has(sub)) continue;
      const offset = this.scrollOffsets.get(sub) ?? 0;
      if (offset > 0 && !this.returningToLive.has(sub)) await this.paintScroll(sub, offset);
      else {
        if (this.snapshotOnly.get(sub)?.replayHistory) {
          const history = this.history.join("");
          // This newcomer has only provisional screen paints, not shared history.
          // Replay from a clean buffer so those paints cannot become scrollback.
          if (isSafeHistoryReplay(history)) { try { sub.send(`\x1b[0m\x1b[2J\x1b[3J\x1b[H${history}`); } catch { this.detach(sub); continue; } }
        }
        try { sub.send(screenSnapshotEscape(screen.snapshot, screen.cursor)); } catch { this.detach(sub); }
        this.scrollOffsets.delete(sub);
        this.returningToLive.delete(sub);
        this.snapshotOnly.delete(sub);
      }
      this.pendingRepaints.delete(sub);
    }
  }

  private readTail(extra?: TerminalSubscriber): void {
    const p = this.outputPath;
    if (!p || this.torndown) return;
    try {
      const stat = fs.statSync(p);
      if (stat.size <= this.lastSize) return;
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(Math.min(stat.size - this.lastSize, MAX_OUTPUT_BUFFER));
      let read: number;
      try { read = fs.readSync(fd, buf, 0, buf.length, this.lastSize); } finally { fs.closeSync(fd); }
      // This is the ONLY advancing write to the consumed cursor. Geometry and
      // capture observations never acknowledge bytes that were not delivered.
      this.lastSize += read;
      const output = this.outputDecoder.write(buf.subarray(0, read));
      if (!output) return;
      this.fanout(output);
      if (extra && !this.subscribers.has(extra)) { try { extra.send(output); } catch { /* dead subscriber */ } }
    } catch { /* transient tail failures; geometry/liveness own availability */ }
  }

  private async closeFailedSeed(sub: TerminalSubscriber, error: unknown): Promise<void> {
    if (!this.torndown) {
      try { if (!await this.tmux.hasSession(this.sessionName)) this.handleSessionDeath(); } catch { /* unavailable read */ }
    }
    if (this.torndown) { this.closeTorndown(sub); return; }
    try { sub.close(1011, displayErrorReason(error)); } catch { /* dead socket */ }
  }

  private async recoverDisplay(error: unknown): Promise<void> {
    if (this.torndown) return;
    // Keep the consumed pipe cursor and decoder intact. A later valid native
    // geometry sample drains every unread byte, then repairs the visible screen.
    for (const sub of this.subscribers) this.pendingRepaints.add(sub);
    if (++this.displayFailures >= MAX_DISPLAY_ATTEMPTS) await this.failGeometry(displayErrorReason(error));
  }

  private async failGeometry(reason: string): Promise<void> {
    if (this.torndown) return;
    let alive = true;
    try { alive = await this.tmux.hasSession(this.sessionName); } catch { /* geometry remains unavailable */ }
    if (this.torndown) return;
    if (!alive) { this.handleSessionDeath(); return; }
    const subs = [...this.subscribers];
    this.dispose();
    this.lastClose = { code: 1011, reason };
    for (const sub of subs) { try { sub.close(this.lastClose.code, this.lastClose.reason); } catch { /* dead socket */ } }
  }

  private enqueueDisplay(op: () => Promise<void>): Promise<void> {
    const run = this.displayQueue.then(op, op);
    this.displayQueue = run.catch(() => {});
    return run;
  }

  /**
   * Detach a subscriber. The broker SURVIVES while other subscribers remain
   * (FR-6); the LAST detach tears the pipe down and deletes the temp file.
   */
  detach(sub: TerminalSubscriber): void {
    if (!this.subscribers.delete(sub)) return;
    this.scrollOffsets.delete(sub);
    this.returningToLive.delete(sub);
    this.pendingRepaints.delete(sub);
    this.snapshotOnly.delete(sub);
    if (this.subscribers.size === 0 && this.attaching === 0) {
      void this.teardown();
    }
  }

  /** Force teardown (used by the registry/route on shutdown and by tests). */
  dispose(): void {
    void this.teardown();
  }

  private async openPipe(): Promise<{ ok: true } | { ok: false; code: number; reason: string }> {
    // Close codes mirror the pre-broker route so the UI keeps its semantics:
    // 1008 (policy) = the session genuinely does not exist; 1011 (server error)
    // = the pipe/temp-file machinery failed. Both are honest; neither is a lie.
    const alive = await this.tmux.hasSession(this.sessionName);
    if (!alive) return { ok: false, code: 1008, reason: `session not found: ${this.sessionName}` };

    const outputPath = path.join(
      os.tmpdir(),
      `openrig-term-${this.sessionName.replace(/[^a-zA-Z0-9@-]/g, "_")}-${Date.now()}.log`,
    );
    try {
      fs.writeFileSync(outputPath, "", "utf-8");
    } catch (err) {
      return { ok: false, code: 1011, reason: `pipe output file failed: ${String(err)}` };
    }
    this.outputPath = outputPath;

    const pipe = await this.tmux.startPipePane(this.sessionName, outputPath);
    if (!pipe.ok) {
      return { ok: false, code: 1011, reason: `pipe-pane failed: ${pipe.message}` };
    }
    this.pipeActive = true;

    return { ok: true };
  }

  private async seed(sub: TerminalSubscriber): Promise<void> {
    let sentCols = 0, sentRows = 0;
    let historySent = false;
    for (let attempt = 0; attempt < MAX_DISPLAY_ATTEMPTS; attempt++) {
      let screen: Awaited<ReturnType<TerminalSessionBroker["readScreen"]>>;
      try { screen = await this.readScreen(); } catch (error) {
        if (this.torndown || attempt + 1 === MAX_DISPLAY_ATTEMPTS) throw error;
        await this.settlePipe();
        continue;
      }
      this.applyGeometry(screen.cursor);
      if (this.torndown) return;
      if (sentCols !== this.cols || sentRows !== this.rows) {
        try { sub.geometry?.(this.cols, this.rows); } catch { /* dead subscriber */ }
        sentCols = this.cols; sentRows = this.rows;
      }
      const fenced = screen.stable && screen.position === this.lastSize && screen.position === this.pipeSize();
      if (!historySent && (!screen.atomic || fenced)) {
        historySent = true;
        if (this.historyBytes > 0) {
          const history = this.history.join("");
          if (isSafeHistoryReplay(history)) { try { sub.send(history); } catch { /* dead socket */ } }
        }
      }
      this.readTail(screen.atomic ? undefined : sub);
      // Native bytes can arrive between the earlier fence and this tail read.
      // If consumed without the newcomer, retain snapshots until a new fence.
      const readyForDeltas = screen.stable && screen.position === this.lastSize && screen.position === this.pipeSize();
      if (screen.atomic || readyForDeltas) {
        if (!readyForDeltas) {
          this.snapshotOnly.set(sub, { failures: 0, replayHistory: !historySent });
          this.pendingRepaints.add(sub);
        }
        try { sub.send(screenSnapshotEscape(screen.snapshot, screen.cursor)); } catch { /* dead socket */ }
        return;
      }
      // The capture and pipe have no atomic watermark. Retry a bounded sample,
      // never acknowledge unread bytes or paint a known-outdated snapshot. A
      // permanently busy viewer without atomic observations must fail instead of going live
      // indefinitely with only cursor deltas and no authoritative screen seed.
    }
    throw new BusyScreenError(SCREEN_BUSY);
  }

  private startTail(): void {
    if (this.tailInterval) return;
    this.tailInterval = setInterval(() => {
      if (this.tickPending || this.torndown) return;
      this.tickPending = true;
      void this.enqueueDisplay(async () => {
        if (this.torndown) return;
        const displayDue = Date.now() - this.lastGeometryRead >= this.geometryMs;
        if (displayDue) {
          this.lastGeometryRead = Date.now();
          const cursor = await this.tmux.getPaneCursorPosition(this.sessionName);
          if (!validCursor(cursor)) throw geometryError(cursor);
          this.applyGeometry(cursor);
        }
        this.readTail();
        // Busy repaints share the geometry cadence; raw output keeps its faster
        // tail cadence. A tail-only tick is not a successful display recovery.
        if (!displayDue) return;
        if (this.pendingRepaints.size) {
          const screen = await this.readScreen();
          this.applyGeometry(screen.cursor);
          await this.repaintPending(screen);
        }
        this.displayFailures = 0;
      }).catch(error => this.recoverDisplay(error)).finally(() => { this.tickPending = false; });
    }, this.pollMs);
  }

  private fanout(data: string): void {
    // Feed the broker-owned ring from the SAME single tail that fans out, so
    // late subscribers can replay the recent window before going live (AC-5).
    this.appendHistory(data);
    // One subscriber whose send throws must not break delivery to the others,
    // and it should be detached cleanly (a throwing send means a dead socket).
    let dead: TerminalSubscriber[] | null = null;
    for (const sub of this.subscribers) {
      // OPR.0.4.0.39: a subscriber scrolled back into history is viewing a static
      // tmux capture window; skip the live fanout so output does not overwrite it.
      // It rejoins live when it scrolls back to the bottom (offset 0).
      if ((this.scrollOffsets.get(sub) ?? 0) > 0 || this.snapshotOnly.has(sub)) continue;
      try {
        sub.send(data);
      } catch {
        (dead ??= []).push(sub);
      }
    }
    // Detach AFTER the loop so we never mutate the set mid-iteration.
    if (dead) {
      for (const sub of dead) this.detach(sub);
    }
  }

  /** Append to the bounded ring, dropping oldest chunks past the byte cap. */
  private appendHistory(data: string): void {
    if (!data) return;
    this.history.push(data);
    this.historyBytes += Buffer.byteLength(data, "utf-8");
    // Keep at least the most recent chunk so a single large burst is never
    // fully discarded; otherwise drop oldest until within the cap.
    while (this.historyBytes > this.maxHistoryBytes && this.history.length > 1) {
      const dropped = this.history.shift()!;
      this.historyBytes -= Buffer.byteLength(dropped, "utf-8");
    }
  }

  private startLiveness(): void {
    if (this.livenessInterval) return;
    this.livenessInterval = setInterval(() => {
      this.tmux
        .hasSession(this.sessionName)
        .then((alive) => {
          if (!alive) this.handleSessionDeath();
        })
        .catch(() => {
          this.handleSessionDeath();
        });
    }, this.livenessMs);
  }

  /** FR-5: a dead session closes ALL subscribers honestly - never silent stale-live. */
  private handleSessionDeath(): void {
    if (this.torndown) return;
    const subs = [...this.subscribers];
    void this.teardown({ code: 1001, reason: "tmux session terminated" });
    for (const sub of subs) {
      try { sub.close(1001, "tmux session terminated"); } catch { /* dead socket */ }
    }
  }

  private teardown(reason = { code: 1011, reason: "terminal broker unavailable" }): Promise<void> {
    if (this.torndown) return this.shutdownPromise;
    this.lastClose = reason;
    this.torndown = true;
    this.subscribers.clear();
    this.scrollOffsets.clear();
    this.stopTimers();
    // A session-scoped stop must settle before the registry permits another
    // pipe to open. An in-flight open may still succeed after closing begins.
    this.shutdownPromise = (async () => {
      await this.openPromise?.catch(() => {});
      if (this.pipeActive) {
        this.pipeActive = false;
        await this.tmux.stopPipePane(this.sessionName).catch(() => {});
      }
      this.teardownResources();
      this.onEmpty?.(this.sessionName);
    })();
    return this.shutdownPromise;
  }

  private stopTimers(): void {
    this.pendingRepaints.clear();
    this.returningToLive.clear();
    this.snapshotOnly.clear();
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    this.settleResolve?.();
    this.settleResolve = null;
    if (this.tailInterval) {
      clearInterval(this.tailInterval);
      this.tailInterval = null;
    }
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
  }

  private teardownResources(): void {
    this.stopTimers();
    if (this.outputPath) {
      try {
        fs.unlinkSync(this.outputPath);
      } catch {
        // temp file may already be gone
      }
      this.outputPath = null;
    }
    this.lastSize = 0;
    this.outputDecoder = new StringDecoder("utf8");
    // Clear the history ring so a torn-down broker leaks no retained output.
    this.history = [];
    this.historyBytes = 0;
  }

  private enqueueInput(op: () => Promise<void>): Promise<void> {
    const run = this.inputQueue.then(op, op);
    this.inputQueue = run.catch(() => {});
    return run;
  }
}

/**
 * Daemon-owned registry of brokers keyed by canonical session name. Create the
 * broker on the first subscriber for a session; reuse it for later subscribers
 * (so only one pipe-pane exists per session); evict it when it empties.
 */
export class TerminalBrokerRegistry {
  private readonly brokers = new Map<string, TerminalSessionBroker>();

  constructor(private readonly tmux: BrokerTmux, private readonly opts: BrokerOptions = {}) {}

  get size(): number {
    return this.brokers.size;
  }

  get(sessionName: string): TerminalSessionBroker | undefined {
    return this.brokers.get(sessionName);
  }

  /** Get-or-create the broker for a session, attach the subscriber, return the broker. */
  async attach(sessionName: string, sub: TerminalSubscriber): Promise<TerminalSessionBroker> {
    let broker = this.brokers.get(sessionName);
    while (broker?.isClosing) {
      await broker.waitForShutdown();
      broker = this.brokers.get(sessionName);
    }
    if (!broker) {
      const created = new TerminalSessionBroker(sessionName, this.tmux, {
        ...this.opts,
        onEmpty: (name) => {
          if (this.brokers.get(name) === created) this.brokers.delete(name);
          this.opts.onEmpty?.(name);
        },
      });
      broker = created;
      this.brokers.set(sessionName, broker);
    }
    await broker.attach(sub);
    return broker;
  }
}
