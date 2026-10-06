import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";
import type { BrokerTmux } from "../src/terminal/TerminalSessionBroker.js";

interface Handlers {
  onOpen(event: unknown, ws: { send(data: string): void; close(code: number, reason: string): void }): Promise<void>;
  onMessage(event: { data: string }, ws: { close(code: number, reason: string): void }): Promise<void>;
  onClose(): Promise<void>;
}

it.each(["text", "submit"] as const)("preserves arrival order when new %s input arrives while buffered input is draining", async kind => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writes: string[] = [];
  const tmux: BrokerTmux = {
    hasSession: async () => true,
    startPipePane: async () => ({ ok: true }),
    stopPipePane: async () => ({ ok: true }),
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 80, height: 24 }),
    capturePaneScreen: async () => "CURRENT SCREEN",
    capturePaneContent: async () => "",
    sendKeys: async (_name, keys) => { writes.push(...keys); return { ok: true }; },
    sendText: async (_name, text) => {
      writes.push(text);
      if (text === "first") await blocked;
      return { ok: true };
    },
  };
  let createHandler!: (context: unknown) => unknown;
  registerTerminalWs(new Hono(), ((create: (context: unknown) => unknown) => {
    createHandler = create;
    return async () => {};
  }) as never, { bearerToken: null });
  const handlers = createHandler({
    req: { param: () => "input-order@fixture", query: () => "2" }, get: () => tmux,
  }) as Handlers;
  const ws = { send: vi.fn(), close: vi.fn() };
  const frame = (text: string) => ({ data: JSON.stringify({ type: "text", text }) });
  const opening = handlers.onOpen({}, ws);
  let latest: Promise<void> | undefined;
  try {
    await handlers.onMessage(frame("first"), ws);
    await handlers.onMessage(frame("second"), ws);
    await vi.waitFor(() => expect(writes).toEqual(["first"]));
    latest = handlers.onMessage(kind === "submit"
      ? { data: JSON.stringify({ type: "keys", keys: ["Enter"] }) }
      : frame("third"), ws);
    release();
    await Promise.all([opening, latest]);
    expect(writes).toEqual(["first", "second", kind === "submit" ? "Enter" : "third"]);
    expect(ws.close).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.allSettled([opening, latest]);
    await handlers.onClose();
  }
});
