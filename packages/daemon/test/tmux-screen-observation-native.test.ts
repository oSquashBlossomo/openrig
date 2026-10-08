import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { screenSnapshotEscape, TerminalSessionBroker } from "../src/terminal/TerminalSessionBroker.js";
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm") as typeof import("@xterm/xterm");

it("refuses a yielding capture alias instead of pairing the new screen with the old cursor, but retains quiet attach", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-observation-alias-")), socket = join(home, "tmux.sock");
  const execute = promisify(execFile);
  const native = async (args: string[]) => (await execute("tmux", ["-f", "/dev/null", "-S", socket, ...args], {
    timeout: 5000, env: { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", TMUX: "" },
  })).stdout;
  let broker: TerminalSessionBroker | undefined;
  try {
    const writer = join(home, "writer.cjs"), barrier = join(home, "barrier.cjs"), gate = join(home, "gate"), done = join(home, "done");
    writeFileSync(writer, `const fs=require('node:fs');let sent=false;process.stdout.write('OLD');setInterval(()=>{if(!sent&&fs.existsSync(${JSON.stringify(gate)})){sent=true;process.stdout.write('\\x1b[4;1HAFTER',()=>fs.writeFileSync(${JSON.stringify(done)},''));}},10);`);
    // The alias yields until the private writer has changed the native cursor and screen.
    writeFileSync(barrier, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(gate)},'');const start=Date.now();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(done)})){clearInterval(t);setTimeout(()=>process.exit(0),50);}else if(Date.now()-start>2000)process.exit(1);},10);`);
    await native(["new-session", "-d", "-x", "90", "-y", "27", "-s", "alias@fixture", `exec '${process.execPath}' '${writer}'`]);
    await vi.waitFor(async () => expect(await native(["capture-pane", "-p", "-t", "=alias@fixture:"])).toContain("OLD"), { timeout: 3000 });
    const tmux = new TmuxAdapter(async () => { throw Error("unexpected shell path"); }, undefined, async args => native(args.slice(1)));
    const before = await tmux.capturePaneObservation("alias@fixture");
    expect(before?.cursor).toEqual({ x: 3, y: 0, width: 90, height: 27 });
    const identity = () => native(["display-message", "-p", "-t", "=alias@fixture:", "#{pane_id}|#{pane_pid}|#{pane_width}|#{pane_height}|#{window-size}"]);
    const originalIdentity = await identity();
    await native(["set-option", "-s", "command-alias[99]", `capture-pane=run-shell "'${process.execPath}' '${barrier}'"; capturep`]);
    const originalAliases = await native(["show-options", "-sv", "command-alias"]);
    const observation = await tmux.capturePaneObservation("alias@fixture");
    // Before the repair this returns AFTER paired with the pre-alias (3,0) cursor.
    expect(await tmux.getPaneCursorPosition("alias@fixture")).toEqual({ x: 5, y: 3, width: 90, height: 27 });
    expect(observation).toBeNull();
    const output: string[] = [], closed: unknown[] = [];
    broker = new TerminalSessionBroker("alias@fixture", tmux, { pollMs: 20 });
    await broker.attach({ send: data => output.push(data), close: (code, reason) => closed.push({ code, reason }) });
    expect(closed).toEqual([]);
    expect(output.some(data => data.startsWith("\x1b[2J") && data.includes("AFTER") && data.endsWith("\x1b[4;6H"))).toBe(true);
    expect(await identity()).toBe(originalIdentity);
    expect(await native(["show-options", "-sv", "command-alias"])).toBe(originalAliases);
  } finally {
    broker?.dispose(); await broker?.waitForShutdown();
    await native(["kill-server"]).catch(() => {}); rmSync(home, { recursive: true, force: true });
  }
}, 15000);

it("matches plain screen capture for colored rows with a pending-wrap cursor and written trailing spaces", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-observation-style-")), socket = join(home, "tmux.sock");
  const execute = promisify(execFile);
  const native = async (args: string[]) => (await execute("tmux", ["-f", "/dev/null", "-S", socket, ...args], {
    timeout: 5000, env: { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", TMUX: "" },
  })).stdout;
  const observed = new Terminal({ cols: 8, rows: 4 }), legacy = new Terminal({ cols: 8, rows: 4 });
  const write = (term: typeof observed, data: string) => new Promise<void>(resolve => term.write(data, resolve));
  const cells = (term: typeof observed) => Array.from({ length: 4 }, (_, row) => {
    const line = term.buffer.active.getLine(row)!;
    return Array.from({ length: 8 }, (_, col) => {
      const cell = line.getCell(col)!;
      return [cell.getChars(), cell.getFgColorMode(), cell.getFgColor()];
    });
  });
  try {
    const writer = join(home, "writer.cjs");
    // Both rows are red natively; tmux -e emits SGR on the first row only.
    // The cursor's full first row must be painted last to retain pending wrap.
    writeFileSync(writer, `process.stdout.write(${JSON.stringify("\x1b[31m\x1b[2;1HSECOND  \x1b[1;1HFIRST   ")});setInterval(()=>{},1000);`);
    await native(["new-session", "-d", "-x", "8", "-y", "4", "-s", "style@fixture", `exec '${process.execPath}' '${writer}'`]);
    await vi.waitFor(async () => expect(await native(["display-message", "-p", "-t", "=style@fixture:", "#{cursor_x}|#{cursor_y}"])).toBe("8|0\n"));
    const tmux = new TmuxAdapter(async () => { throw Error("unexpected shell path"); }, undefined, async args => native(args.slice(1)));
    const screen = (await tmux.capturePaneObservation("style@fixture"))!;
    const plain = (await tmux.capturePaneScreen("style@fixture", true))!;
    expect(screen.cursor).toEqual({ x: 8, y: 0, width: 8, height: 4 });
    await write(observed, screenSnapshotEscape(screen.snapshot, screen.cursor));
    await write(legacy, screenSnapshotEscape(plain, screen.cursor));
    expect(cells(observed)).toEqual(cells(legacy));
    expect(screen.snapshot).toBe(plain);
    expect(plain.split("\n").slice(0, 2)).toEqual(["FIRST   ", "SECOND  "]);
    await write(observed, "Z"); await write(legacy, "Z");
    expect(cells(observed)).toEqual(cells(legacy));
    expect([observed.buffer.active.cursorX, observed.buffer.active.cursorY]).toEqual([1, 1]);
    expect(observed.buffer.active.getLine(1)!.translateToString(true)).toBe("ZECOND  ");
  } finally {
    observed.dispose(); legacy.dispose();
    await native(["kill-server"]).catch(() => {}); rmSync(home, { recursive: true, force: true });
  }
}, 15000);
