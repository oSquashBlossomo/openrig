import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
// @ts-expect-error The existing runtime dependency ships without ws declarations.
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(autoPong: boolean) {
  const app = new Hono();
  const tmux = {
    hasSession: vi.fn(async () => true),
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 80, height: 24 }),
    capturePaneScreen: async () => "QUIET FIXTURE",
    startPipePane: vi.fn(async () => ({ ok: true })),
    stopPipePane: vi.fn(async () => ({ ok: true })),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
  };
  app.use("*", async (c, next) => { c.set("tmuxAdapter" as never, tmux); await next(); });
  const ws = createNodeWebSocket({ app });
  const options = { bearerToken: null, heartbeatIntervalMs: 75 };
  registerTerminalWs(app, ws.upgradeWebSocket as never, options);
  const accepted = new Promise<WebSocket>(resolve => ws.wss.once("connection", resolve));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  ws.injectWebSocket(server);
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve); server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const client = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/heartbeat@fixture?protocol=2`, {
    autoPong, headers: { Origin: `http://127.0.0.1:${port}` },
  });
  const pings: unknown[] = [], frames: Array<{ type: string }> = [], closes: number[] = [];
  client.on("ping", (data: unknown) => pings.push(data));
  client.on("message", (data: { toString(): string }) => frames.push(JSON.parse(data.toString())));
  client.on("close", (code: number) => closes.push(code));
  cleanups.push(async () => {
    if (client.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>(resolve => client.once("close", resolve));
      client.terminate(); await closed;
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { client, serverSocket: await accepted, pings, frames, closes, tmux };
}

it("terminates an unresponsive peer and releases its broker even while its native session stays alive", async () => {
  const f = await fixture(false);
  await expect.poll(() => f.closes, { timeout: 750 }).toEqual([1006]);
  expect(f.pings.length).toBeGreaterThan(0);
  await expect.poll(() => f.tmux.stopPipePane.mock.calls.length).toBe(1);
  expect(f.tmux.sendText).not.toHaveBeenCalled();
  expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});

it("keeps an idle auto-pong peer connected without emitting terminal protocol frames or native input", async () => {
  const f = await fixture(true);
  await expect.poll(() => f.pings.length, { timeout: 1000 }).toBeGreaterThanOrEqual(3);
  expect(f.closes).toEqual([]);
  expect(f.frames.map(frame => frame.type)).toEqual(["geometry", "output"]);
  expect(f.tmux.stopPipePane).not.toHaveBeenCalled();
  expect(f.tmux.sendText).not.toHaveBeenCalled();
  expect(f.tmux.sendKeys).not.toHaveBeenCalled();
});

it("stops heartbeat timers and pong listeners when the viewer closes", async () => {
  const f = await fixture(true);
  await expect.poll(() => f.pings.length).toBeGreaterThan(0);
  const ping = vi.spyOn(f.serverSocket, "ping");
  f.client.close();
  await expect.poll(() => f.closes).toEqual([1005]);
  await expect.poll(() => f.tmux.stopPipePane.mock.calls.length).toBe(1);
  expect(f.serverSocket.listenerCount("pong")).toBe(0);
  const calls = ping.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 180));
  expect(ping).toHaveBeenCalledTimes(calls);
});
