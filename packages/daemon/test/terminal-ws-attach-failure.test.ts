import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { BrokerTmux } from "../src/terminal/TerminalSessionBroker.js";

function handlers(tmux: BrokerTmux) {
  let create!: (context: unknown) => unknown;
  registerTerminalWs(new Hono(), ((factory: (context: unknown) => unknown) => {
    create = factory; return async () => {};
  }) as never, { bearerToken: null });
  return (name: string) => create({ req: { param: () => name, query: () => "2" }, get: () => tmux }) as {
    onOpen(event: unknown, ws: ReturnType<typeof socket>): Promise<void>;
    onMessage(event: { data: string }, ws: ReturnType<typeof socket>): Promise<void>;
    onClose(): Promise<void>;
  };
}

function socket() {
  const raw = Object.assign(new EventEmitter(), { readyState: 1, ping: vi.fn(), terminate: vi.fn() });
  // Real close notification is asynchronous; the failure boundary must clean up now.
  return { send: vi.fn(), close: vi.fn(), raw };
}
const text = (value: string) => ({ data: JSON.stringify({ type: "text", text: value }) });

it.each(["can't find window: proof", "can't find pane: codex"])("closes only the stopped dotted target (%s) without rejecting its asynchronous open", async diagnostic => {
  const exec = vi.fn(async () => { throw new Error(diagnostic); });
  const route = handlers(new TmuxAdapter(exec) as unknown as BrokerTmux)("proof.codex");
  const ws = socket();
  try {
    await expect(route.onOpen({}, ws)).resolves.toBeUndefined();
    expect(ws.close).toHaveBeenCalledExactlyOnceWith(1008, "session not found: proof.codex");
    await route.onMessage(text("STOPPED_INPUT"), ws);
    expect(exec).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  } finally { await route.onClose(); }
});

it.each(["probe", "pipe"])("contains an unexpected %s rejection, discards queued input and permits a later viewer", async stage => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let failing = true;
  const sendText = vi.fn(async () => ({ ok: true }));
  const startPipePane = vi.fn(async (name: string) => {
    if (failing && name === "failed@fixture" && stage === "pipe") { await blocked; throw Error("EACCES private pipe detail"); }
    return { ok: true };
  });
  const tmux: BrokerTmux = {
    hasSession: async name => {
      if (failing && name === "failed@fixture" && stage === "probe") { await blocked; throw Error("EACCES private socket detail"); }
      return true;
    },
    startPipePane, stopPipePane: vi.fn(async () => ({ ok: true })),
    sendText, sendKeys: vi.fn(async () => ({ ok: true })),
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 80, height: 24 }),
    capturePaneScreen: async () => "LIVE SCREEN",
  };
  const create = handlers(tmux), live = create("live@fixture"), failed = create("failed@fixture"), retry = create("failed@fixture");
  const liveWs = socket(), failedWs = socket(), retryWs = socket();
  let opening: Promise<void> | undefined;
  try {
    await live.onOpen({}, liveWs);
    opening = failed.onOpen({}, failedWs);
    await failed.onMessage(text("QUEUED_BEFORE_FAILURE"), failedWs);
    release();
    await expect(opening).resolves.toBeUndefined();
    expect(failedWs.close).toHaveBeenCalledExactlyOnceWith(1011, "terminal attachment failed");
    expect(failedWs.raw.listenerCount("pong")).toBe(0);
    expect(failedWs.raw.listenerCount("close")).toBe(0);
    await failed.onMessage(text("LATE_REJECTED_INPUT"), failedWs);
    expect(sendText).not.toHaveBeenCalled();
    expect(liveWs.close).not.toHaveBeenCalled();
    failing = false;
    await retry.onOpen({}, retryWs);
    await retry.onMessage(text("RETRY_INPUT"), retryWs);
    await live.onMessage(text("LIVE_INPUT"), liveWs);
    expect(sendText.mock.calls).toEqual([["failed@fixture", "RETRY_INPUT"], ["live@fixture", "LIVE_INPUT"]]);
    expect(retryWs.close).not.toHaveBeenCalled();
  } finally {
    release(); await opening?.catch(() => {});
    await failed.onClose(); await retry.onClose(); await live.onClose();
  }
});
