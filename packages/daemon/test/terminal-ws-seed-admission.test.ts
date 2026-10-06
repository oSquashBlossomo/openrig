import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";
import type { BrokerTmux } from "../src/terminal/TerminalSessionBroker.js";

interface Handlers {
  onOpen(event: unknown, ws: { send(data: string): void; close(code: number, reason: string): void }): Promise<void>;
  onMessage(event: { data: string }, ws: { close(code: number, reason: string): void }): Promise<void>;
  onClose(): Promise<void>;
}

it("discards rejected viewer input before asynchronous WebSocket close notification while the admitted viewer remains usable", async () => {
  let failing = false;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sendText = vi.fn(async () => ({ ok: true }));
  const stopPipePane = vi.fn(async () => ({ ok: true }));
  const tmux: BrokerTmux = {
    hasSession: async () => true,
    startPipePane: async () => ({ ok: true }), stopPipePane,
    sendKeys: async () => ({ ok: true }), sendText,
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 90, height: 27 }),
    capturePaneScreen: async () => {
      if (failing) { await blocked; throw Error("capture temporarily unavailable"); }
      return "ADMITTED SCREEN";
    },
    capturePaneContent: async () => "",
  };
  let createHandler!: (c: unknown) => unknown;
  registerTerminalWs(new Hono(), ((create: (c: unknown) => unknown) => {
    createHandler = create;
    return async () => {};
  }) as never, { bearerToken: null });
  const context = { req: { param: () => "admission@fixture", query: () => "2" }, get: () => tmux };
  const a = createHandler(context) as Handlers;
  const b = createHandler(context) as Handlers;
  const aWs = { send: vi.fn(), close: vi.fn() };
  // close deliberately does NOT invoke onClose: real close events arrive later.
  const bWs = { send: vi.fn(), close: vi.fn() };
  try {
    await a.onOpen({}, aWs);
    failing = true;
    const opening = b.onOpen({}, bWs);
    await b.onMessage({ data: JSON.stringify({ type: "text", text: "REJECTED_EARLY_INPUT" }) }, bWs);
    release();
    await opening;
    expect(bWs.close).toHaveBeenCalledWith(1011, "terminal geometry unavailable or outside supported bounds");
    expect(aWs.close).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    await b.onMessage({ data: JSON.stringify({ type: "text", text: "REJECTED_LATE_INPUT" }) }, bWs);
    expect(sendText).not.toHaveBeenCalled();
    failing = false;
    await a.onMessage({ data: JSON.stringify({ type: "text", text: "ADMITTED_INPUT" }) }, aWs);
    expect(sendText).toHaveBeenCalledExactlyOnceWith("admission@fixture", "ADMITTED_INPUT");
    expect(stopPipePane).not.toHaveBeenCalled();
  } finally {
    release();
    await b.onClose(); await a.onClose();
  }
});
