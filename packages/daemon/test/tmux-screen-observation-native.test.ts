import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TerminalSessionBroker } from "../src/terminal/TerminalSessionBroker.js";

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
