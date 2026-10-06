import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
// @ts-expect-error The existing runtime dependency ships without ws declarations.
import WebSocket from "ws";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";

const token = "fictional-terminal-identity-token";
const names = ["%", "%2F", "/", "日本語 ?#&", "desk.worker@private-rig"];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(available = names) {
  const app = new Hono();
  app.onError(() => new Response("route error", { status: 500 }));
  const tmux = {
    hasSession: vi.fn(async (name: string) => available.includes(name)),
    getPaneCursorPosition: vi.fn(async () => ({ x: 0, y: 0, width: 100, height: 30 })),
    capturePaneScreen: vi.fn(async (name: string) => `exact screen: ${name}`),
    startPipePane: vi.fn(async (_name: string, _outputPath: string) => ({ ok: true })),
    stopPipePane: vi.fn(async (_name: string) => ({ ok: true })),
    sendText: vi.fn(async (_name: string, _text: string) => ({ ok: true })),
    sendKeys: vi.fn(async (_name: string, _keys: string[]) => ({ ok: true })),
    resizeWindow: vi.fn(), setWindowOption: vi.fn(),
  };
  app.use("*", async (c, next) => { c.set("tmuxAdapter" as never, tmux as never); await next(); });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: token });
  // Ephemeral loopback server; no installed daemon, tmux or native processes.
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  injectWebSocket(server);
  if (!server.listening) await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
      socket.terminate(); await closed;
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  function connect(name: string, options: { token?: string; origin?: string; protocol?: string } = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${encodeURIComponent(name)}?protocol=${options.protocol ?? "2"}&token=${options.token ?? token}`, {
      headers: { Origin: options.origin ?? "http://127.0.0.1" },
    });
    sockets.push(socket);
    const frames: Array<{ type: string; data?: string }> = [];
    socket.on("message", (data: { toString(): string }) => frames.push(JSON.parse(data.toString())));
    const result = new Promise<{ status?: number; code?: number }>(resolve => {
      socket.on("unexpected-response", (_req: ClientRequest, response: IncomingMessage) => { response.resume(); resolve({ status: response.statusCode }); socket.terminate(); });
      socket.on("close", (code: number) => resolve({ code }));
      socket.on("error", () => {}); // Rejected upgrades are asserted by their HTTP status.
    });
    return { socket, frames, result };
  }
  return { tmux, connect };
}

describe("terminal WebSocket exact already-decoded session identity", () => {
  it.each(names)("streams and types only into exact %s", async name => {
    const f = await fixture(), { socket, frames, result } = f.connect(name);
    await expect.poll(() => frames.some(frame => frame.data?.includes(`exact screen: ${name}`))).toBe(true);
    expect(frames[0]).toMatchObject({ type: "geometry", cols: 100, rows: 30 });
    expect(f.tmux.startPipePane.mock.calls).toHaveLength(1);
    expect(f.tmux.startPipePane.mock.calls[0]?.[0]).toBe(name);
    expect(f.tmux.hasSession.mock.calls.every(call => call[0] === name)).toBe(true);
    socket.send(JSON.stringify({ type: "text", text: "fictional input" }));
    socket.send(JSON.stringify({ type: "keys", keys: ["Enter"] }));
    await expect.poll(() => f.tmux.sendKeys.mock.calls.length).toBe(1);
    expect(f.tmux.sendText).toHaveBeenCalledExactlyOnceWith(name, "fictional input");
    expect(f.tmux.sendKeys).toHaveBeenCalledExactlyOnceWith(name, ["Enter"]);
    socket.close(); await result;
    await expect.poll(() => f.tmux.stopPipePane.mock.calls.length).toBe(1);
    expect(f.tmux.stopPipePane).toHaveBeenCalledExactlyOnceWith(name);
    expect(f.tmux.resizeWindow).not.toHaveBeenCalled(); expect(f.tmux.setWindowOption).not.toHaveBeenCalled();
  });
  it("missing literal %2F never attaches to the slash sibling", async () => {
    const f = await fixture(["/"]), connection = f.connect("%2F");
    await expect.poll(() => f.tmux.hasSession.mock.calls.length).toBeGreaterThan(0);
    expect(f.tmux.hasSession).toHaveBeenCalledExactlyOnceWith("%2F");
    expect(await connection.result).toEqual({ code: 1008 });
    expect(f.tmux.startPipePane).not.toHaveBeenCalled(); expect(f.tmux.sendText).not.toHaveBeenCalled();
  });
  it.each([{ token: "wrong", status: 401 }, { origin: "http://evil.example.com", status: 403 }])("rejects admission before touching any target (%j)", async options => {
    const f = await fixture(); expect(await f.connect("%2F", options).result).toEqual({ status: options.status });
    expect(f.tmux.hasSession).not.toHaveBeenCalled(); expect(f.tmux.startPipePane).not.toHaveBeenCalled();
  });
  it("legacy protocol rejection remains before broker attachment", async () => {
    const f = await fixture(); expect(await f.connect("%2F", { protocol: "1" }).result).toEqual({ code: 1008 });
    expect(f.tmux.hasSession).not.toHaveBeenCalled(); expect(f.tmux.startPipePane).not.toHaveBeenCalled();
  });
});
