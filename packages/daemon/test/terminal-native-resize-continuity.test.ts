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

it("keeps two live viewers and every pipe byte through repeated real native resizes, then repaints accurately", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-native-resize-"));
  const socket = join(home, "tmux.sock");
  const execute = promisify(execFile);
  const native = async (args: string[]) => (await execute("tmux", ["-f", "/dev/null", "-S", socket, ...args], {
    timeout: 5000, env: { ...process.env, HOME: home, TMUX: "" },
  })).stdout;
  type Event = { cols: number; rows: number } | { data: string };
  const viewers = [0, 1].map(() => ({ events: [] as Event[], closed: [] as unknown[] }));
  let broker: TerminalSessionBroker | undefined;
  let resizing = false, resizeCount = 0, width = 90, pipeStarts = 0, pipeStops = 0;
  try {
    const writer = join(home, "writer.cjs"), start = join(home, "start"), quiet = join(home, "quiet");
    writeFileSync(writer, `const fs=require('node:fs');let n=0,done=false;process.stdout.write('BASELINE');setInterval(()=>{if(done)return;if(fs.existsSync(${JSON.stringify(quiet)})){done=true;process.stdout.write('\\x1b[2;1HRESIZE_COMPLETE');}else if(fs.existsSync(${JSON.stringify(start)})){process.stdout.write('\\x1b[3;1HBYTE_'+(++n)+';');}},20);`);
    await native(["new-session", "-d", "-x", "90", "-y", "27", "-s", "resize@fixture", `exec '${process.execPath}' '${writer}'`]);
    const identity = async () => (await native(["display-message", "-p", "-t", "=resize@fixture:0.0", "#{pane_id}|#{pane_pid}"])).trim();
    const before = await identity();
    const tmux = new TmuxAdapter(async () => { throw Error("unexpected default shell execution"); }, undefined, async args => {
      if (args[1] === "pipe-pane") args.length === 5 ? pipeStarts++ : pipeStops++;
      const output = await native(args.slice(1));
      if (resizing && args[1] === "capture-pane" && !args.includes("-S")) {
        // Inject the owner's real native resize between real before/after
        // geometry probes. Neither cursor nor snapshot is mocked.
        width = width === 90 ? 91 : 90;
        await native(["resize-window", "-t", "=resize@fixture:0", "-x", String(width), "-y", "27"]);
        resizeCount++;
      }
      return output;
    });
    broker = new TerminalSessionBroker("resize@fixture", tmux, { pollMs: 50, geometryMs: 50 });
    for (const viewer of viewers) await broker.attach({
      geometry: (cols, rows) => viewer.events.push({ cols, rows }),
      send: data => viewer.events.push({ data }), close: (code, reason) => viewer.closed.push({ code, reason }),
    });
    const pipe = broker.pipeOutputPath!;
    await native(["resize-window", "-t", "=resize@fixture:0", "-x", "91", "-y", "27"]); width = 91;
    resizing = true; writeFileSync(start, "start");
    const began = Date.now();
    await vi.waitFor(() => {
      expect(viewers.map(viewer => viewer.closed)).toEqual([[], []]);
      expect(resizeCount).toBeGreaterThanOrEqual(12);
      expect(Date.now() - began).toBeGreaterThanOrEqual(600);
    }, { timeout: 5000, interval: 10 });
    resizing = false; writeFileSync(quiet, "quiet");
    await vi.waitFor(() => expect(viewers.every(viewer => viewer.events.some(event => "data" in event && event.data.startsWith("\x1b[2J") && event.data.includes("RESIZE_COMPLETE")))).toBe(true), { timeout: 3000 });
    expect(broker.pipeOutputPath).toBe(pipe);
    expect(broker.subscriberCount).toBe(2);
    expect(pipeStarts).toBe(1); expect(pipeStops).toBe(0);
    expect(await identity()).toBe(before);
    const nativeRows = (await native(["capture-pane", "-p", "-t", "=resize@fixture:0.0"])).slice(0, -1).split("\n");
    const cursor = await tmux.getPaneCursorPosition("resize@fixture");
    const deltas: string[][] = [];
    for (const viewer of viewers) {
      const terminal = new Terminal({ cols: 90, rows: 27 });
      try {
        for (const event of viewer.events) {
          if ("cols" in event) terminal.resize(event.cols, event.rows);
          else await new Promise<void>(resolve => terminal.write(event.data, resolve));
        }
        expect(Array.from({ length: 27 }, (_, index) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true).trimEnd())).toEqual(nativeRows.map(row => row.trimEnd()));
        expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([cursor!.x, cursor!.y]);
        deltas.push(viewer.events.filter((event): event is { data: string } => "data" in event && !event.data.startsWith("\x1b[2J")).map(event => event.data));
      } finally { terminal.dispose(); }
    }
    expect(deltas[0]).toEqual(deltas[1]);
    const ids = [...deltas[0]!.join("").matchAll(/BYTE_(\d+);/g)].map(match => Number(match[1]));
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, index) => index + 1));
    expect(viewers.map(viewer => viewer.closed)).toEqual([[], []]);
  } finally {
    resizing = false; broker?.dispose();
    await native(["kill-server"]).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);
