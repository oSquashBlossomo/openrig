import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TerminalSessionBroker } from "../src/terminal/TerminalSessionBroker.js";

// Use the actual browser terminal parser without opening a DOM renderer.
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm") as typeof import("@xterm/xterm");

it.each([
  ["ASCII", "ABCDEFGHIJKL", 1],
  ["trailing written spaces", "ABCDEFGH    ", 1],
  ["wide characters", "界界界界界界", 1],
  ["bottom-row scroll", "ABCDEFGHIJKL", 3],
] as const)("preserves native pending wrap and next streamed byte for %s", async (_label, line, y) => {
  const home = mkdtempSync(join(tmpdir(), "openrig-terminal-wrap-"));
  const socket = join(home, "tmux.sock");
  const execute = promisify(execFile);
  const native = async (args: string[]) => (await execute("tmux", ["-f", "/dev/null", "-S", socket, ...args], {
    timeout: 5000, env: { ...process.env, HOME: home, TMUX: "" },
  })).stdout;
  const terminal = new Terminal({ cols: 12, rows: 4 });
  const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
  const frames: string[] = [];
  const closed: unknown[] = [];
  let broker: TerminalSessionBroker | undefined;
  try {
    const writer = join(home, "writer.cjs");
    const next = join(home, "next.txt");
    const initial = `\x1b[1;1HUPPER\x1b[3;1HLOWER\x1b[${y + 1};1H${line}`;
    writeFileSync(writer, `const fs=require('node:fs');process.stdout.write(${JSON.stringify(initial)});setInterval(()=>{if(fs.existsSync(${JSON.stringify(next)})){process.stdout.write(fs.readFileSync(${JSON.stringify(next)},'utf8'));fs.unlinkSync(${JSON.stringify(next)});}},10);`);
    await native(["new-session", "-d", "-x", "12", "-y", "4", "-s", "wrap@fixture", `exec '${process.execPath}' '${writer}'`]);
    const tmux = new TmuxAdapter(async () => { throw Error("unexpected shell execution"); }, undefined, args => native(args.slice(1)));
    await vi.waitFor(async () => expect(await tmux.getPaneCursorPosition("wrap@fixture")).toEqual({ x: 12, y, width: 12, height: 4 }));
    const before = (await native(["display-message", "-p", "-t", "=wrap@fixture:0.0", "#{pane_id}|#{pane_pid}|#{pane_width}|#{pane_height}"])).trim();
    broker = new TerminalSessionBroker("wrap@fixture", tmux, { pollMs: 10 });
    await broker.attach({ send: data => frames.push(data), close: (code, reason) => closed.push({ code, reason }) });
    expect(closed).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames.splice(0)) await write(frame);
    expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([12, y]);
    writeFileSync(next, "Z");
    await vi.waitFor(() => expect(frames.some(frame => frame.includes("Z"))).toBe(true));
    for (const frame of frames.splice(0)) await write(frame);
    const nativeRows = (await native(["capture-pane", "-p", "-t", "=wrap@fixture:0.0"])).slice(0, -1).split("\n");
    expect(Array.from({ length: 4 }, (_, index) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true).trimEnd())).toEqual(nativeRows.map(row => row.trimEnd()));
    const cursor = await tmux.getPaneCursorPosition("wrap@fixture");
    expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([cursor!.x, cursor!.y]);
    expect((await native(["display-message", "-p", "-t", "=wrap@fixture:0.0", "#{pane_id}|#{pane_pid}|#{pane_width}|#{pane_height}"])).trim()).toBe(before);
    expect(closed).toEqual([]);
  } finally {
    broker?.dispose(); terminal.dispose();
    await native(["kill-server"]).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 10000);
