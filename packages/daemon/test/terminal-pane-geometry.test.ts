import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";

it("mirrors actual shared tmux geometry without mutating native size, options or PIDs", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-terminal-geometry-"));
  const execute = promisify(execFile);
  const socket = join(home, "tmux.sock");
  // Every native command explicitly selects this private socket. No installed fleet/default socket.
  const native = async (args: string[]) => (await execute("tmux", ["-f", "/dev/null", "-S", socket, ...args], {
    timeout: 5000, env: { ...process.env, HOME: home, TMUX: "" },
  })).stdout;
  const state = async (name = "geometry@fixture") => ({
    pane: (await native(["display-message", "-p", "-t", `=${name}:0.0`, "#{pane_id}|#{pane_pid}|#{pane_width}|#{pane_height}"])).trim(),
    option: (await native(["show-options", "-w", "-v", "-t", `=${name}:0`, "window-size"])).trim(),
  });
  let server: ReturnType<typeof serve> | undefined;
  const sockets: WebSocket[] = [];
  try {
    const writer = join(home, "writer.cjs");
    writeFileSync(writer, "process.stdout.write('GEOMETRY_FIXTURE_READY\\n');setInterval(()=>{},1000);");
    await native(["new-session", "-d", "-x", "137", "-y", "43", "-s", "geometry@fixture", `exec '${process.execPath}' '${writer}'`]);
    await native(["set-window-option", "-t", "=geometry@fixture:0", "window-size", "largest"]);
    await native(["new-session", "-d", "-x", "99", "-y", "31", "-s", "geometry@fixture-more", `exec '${process.execPath}' '${writer}'`]);
    const distractorBefore = await state("geometry@fixture-more");
    const before = await state();
    const [paneId, pid, width, height] = before.pane.split("|");
    expect([width, height]).toEqual(["137", "43"]);
    let pipeCount = 0;
    const tmux = new TmuxAdapter(async () => { throw Error("unexpected shell execution"); }, undefined, args => {
      if (args[1] === "pipe-pane" && args.length === 5) pipeCount++;
      return native(args.slice(1));
    });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("tmuxAdapter" as never, tmux); await next(); });
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: "fixture-token", livenessIntervalMs: 100 });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectWebSocket(server);
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const connect = async () => {
      const frames: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/geometry%40fixture?protocol=2&token=fixture-token`);
      sockets.push(ws);
      ws.onmessage = event => frames.push(String(event.data));
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
      return { ws, frames };
    };
    const a = await connect();
    expect(await state(), "viewing preserves exact pane ID, PID, geometry and window-size option").toEqual(before);
    expect(JSON.parse(a.frames[0]!)).toEqual({ type: "geometry", cols: 137, rows: 43 });
    await vi.waitFor(() => expect(a.frames.some(frame => JSON.parse(frame).data?.includes("GEOMETRY_FIXTURE_READY"))).toBe(true));
    const b = await connect();
    expect(await state(), "second viewer does not interfere").toEqual(before);
    expect(JSON.parse(b.frames[0]!)).toEqual({ type: "geometry", cols: 137, rows: 43 });
    a.ws.send(JSON.stringify({ type: "resize", cols: 20, rows: 5 }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await state(), "browser resize cannot affect shared native pane").toEqual(before);
    // Simulate an owner's native resize; browser subscribers only observe this.
    await native(["resize-window", "-t", "=geometry@fixture:0", "-x", "155", "-y", "37"]);
    const resized = await state();
    expect(resized.pane.split("|").slice(0, 2)).toEqual([paneId, pid]);
    await vi.waitFor(() => expect([a, b].every(viewer => viewer.frames.some(frame => {
      const message = JSON.parse(frame); return message.type === "geometry" && message.cols === 155 && message.rows === 37;
    }))).toBe(true), { timeout: 3000 });
    expect(await state(), "observation preserves native resize and option").toEqual(resized);
    for (const viewer of [a, b]) {
      const index = viewer.frames.findIndex(frame => JSON.parse(frame).cols === 155);
      await vi.waitFor(() => expect(viewer.frames.length).toBeGreaterThan(index + 1));
      expect(JSON.parse(viewer.frames[index + 1]!).type).toBe("output");
    }
    const close = (ws: WebSocket) => new Promise<void>(resolve => { ws.onclose = () => resolve(); ws.close(); });
    await close(a.ws);
    expect(await state(), "first disconnect preserves native pane").toEqual(resized);
    await close(b.ws);
    await vi.waitFor(async () => expect((await native(["display-message", "-p", "-t", "=geometry@fixture:0.0", "#{pane_pipe}"])).trim()).toBe("0"));
    expect(await state(), "last disconnect preserves process continuity").toEqual(resized);
    expect(pipeCount).toBe(1);
    expect(await state("geometry@fixture-more"), "exact seat targeting never touches a same-prefix session").toEqual(distractorBefore);
  } finally {
    sockets.forEach(ws => ws.close());
    server?.close();
    await native(["kill-server"]).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
