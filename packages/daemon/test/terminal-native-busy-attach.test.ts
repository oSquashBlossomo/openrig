import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TerminalSessionBroker } from "../src/terminal/TerminalSessionBroker.js";
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm") as typeof import("@xterm/xterm");

it("attaches throughout real continuous redraw, preserves the other viewer, then crosses the quiet fence accurately", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-native-busy-")), socket = join(home, "tmux.sock");
  const execute = promisify(execFile);
  const native = async (args: string[]) => (await execute("tmux", ["-f", "/dev/null", "-S", socket, ...args], {
    timeout: 5000, env: { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", TMUX: "" },
  })).stdout;
  let broker: TerminalSessionBroker | undefined;
  type Frame = { cols: number; rows: number } | { data: string };
  const viewers = [0, 1].map(() => ({ frames: [] as Frame[], closed: [] as unknown[] }));
  let starts = 0, stops = 0, writes = 0;
  try {
    const writer = join(home, "writer.cjs"), start = join(home, "start"), quiet = join(home, "quiet"), after = join(home, "after");
    writeFileSync(writer, `const fs=require('node:fs');let n=0,done=false,afterSent=false;process.stdout.write('HEADER');setInterval(()=>{if(done){if(!afterSent&&fs.existsSync(${JSON.stringify(after)})){afterSent=true;process.stdout.write('AFTER_FENCE');}return;}if(fs.existsSync(${JSON.stringify(quiet)})){done=true;process.stdout.write('\\x1b[3;1HDONE');}else if(fs.existsSync(${JSON.stringify(start)})){process.stdout.write('\\x1b[2;1HFRAME_'+(++n)+'; π🧭\\x1b[4;1H');}},10);`);
    await native(["new-session", "-d", "-x", "90", "-y", "27", "-s", "busy@fixture", `exec '${process.execPath}' '${writer}'`]);
    const identity = () => native(["display-message", "-p", "-t", "=busy@fixture:", "#{pane_id}|#{pane_pid}|#{pane_width}|#{pane_height}|#{window-size}"]);
    const before = await identity();
    const tmux = new TmuxAdapter(async () => { throw Error("unexpected shell path"); }, undefined, async argv => {
      if (argv[1] === "pipe-pane") argv.length === 5 ? starts++ : stops++;
      if (argv.includes("send-keys") || argv.includes("paste-buffer") || argv.includes("resize-window") || argv.includes("set-option")) writes++;
      return native(argv.slice(1));
    });
    broker = new TerminalSessionBroker("busy@fixture", tmux, { pollMs: 20, geometryMs: 100 });
    const subscriber = (viewer: typeof viewers[number]) => ({ geometry: (cols: number, rows: number) => viewer.frames.push({ cols, rows }), send: (data: string) => viewer.frames.push({ data }), close: (code: number, reason: string) => viewer.closed.push({ code, reason }) });
    await vi.waitFor(async () => expect(await native(["capture-pane", "-p", "-t", "=busy@fixture:"])).toContain("HEADER"));
    await broker.attach(subscriber(viewers[0]!));
    writeFileSync(start, "start");
    await vi.waitFor(() => expect(viewers[0]!.frames.some(f => "data" in f && f.data.includes("FRAME_"))).toBe(true));
    const startedAt = Date.now(); await broker.attach(subscriber(viewers[1]!));
    expect(Date.now() - startedAt).toBeLessThan(1500); expect(viewers[1]!.closed).toEqual([]);
    await vi.waitFor(() => {
      expect(viewers[1]!.frames.filter(f => "data" in f && f.data.startsWith("\x1b[2J")).length).toBeGreaterThanOrEqual(6);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
    }, { timeout: 4000 });
    expect(viewers[1]!.frames.filter((f): f is { data: string } => "data" in f).every(f => f.data.startsWith("\x1b[2J"))).toBe(true);
    writeFileSync(quiet, "quiet");
    await vi.waitFor(() => expect(viewers[1]!.frames.some(f => "data" in f && f.data.includes("DONE"))).toBe(true), { timeout: 3000 });
    // Let the unchanged quiet fence complete, then prove subsequent raw bytes
    // enter both viewers exactly once (the snapshot-only phase never replays them).
    await new Promise(resolve => setTimeout(resolve, 350));
    writeFileSync(after, "after");
    await vi.waitFor(() => {
      for (const viewer of viewers) expect(viewer.frames.filter(f => "data" in f && f.data === "AFTER_FENCE")).toHaveLength(1);
    }, { timeout: 3000 });
    const expected = (await native(["capture-pane", "-p", "-t", "=busy@fixture:"])).slice(0, -1).split("\n").map(s => s.trimEnd());
    const cursor = await tmux.getPaneCursorPosition("busy@fixture");
    for (const viewer of viewers) {
      const terminal = new Terminal({ cols: 90, rows: 27 });
      try {
        for (const frame of viewer.frames) {
          if ("cols" in frame) terminal.resize(frame.cols, frame.rows);
          else await new Promise<void>(resolve => terminal.write(frame.data, resolve));
        }
        expect(Array.from({ length: 27 }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true).trimEnd())).toEqual(expected);
        expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([cursor!.x, cursor!.y]);
      } finally { terminal.dispose(); }
    }
    const raw = viewers[0]!.frames.filter((f): f is { data: string } => "data" in f && !f.data.startsWith("\x1b[2J")).map(f => f.data).join("");
    const ids = [...raw.matchAll(/FRAME_(\d+);/g)].map(m => Number(m[1]));
    expect(ids.length).toBeGreaterThan(40);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
    expect(await identity()).toBe(before); expect(starts).toBe(1); expect(stops).toBe(0); expect(writes).toBe(0);
    expect(viewers.map(v => v.closed)).toEqual([[], []]);
    // A yielding inherited hook is not accepted as an atomic observation, even at a nonzero index.
    await native(["set-hook", "-g", "after-display-message[9]", "run-shell 'sleep 0.01'"]);
    expect(await tmux.capturePaneObservation("busy@fixture")).toBeNull();
    const hooked = { frames: [] as Frame[], closed: [] as unknown[] };
    await broker.attach(subscriber(hooked));
    expect(hooked.closed).toEqual([]);
    expect(hooked.frames.some(frame => "data" in frame && frame.data.startsWith("\x1b[2J") && frame.data.includes("DONE"))).toBe(true);
    expect(starts).toBe(1); expect(stops).toBe(0);
  } finally {
    broker?.dispose(); await broker?.waitForShutdown();
    await native(["kill-server"]).catch(() => {}); rmSync(home, { recursive: true, force: true });
  }
}, 15000);
