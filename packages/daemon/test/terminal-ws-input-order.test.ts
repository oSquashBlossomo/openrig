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
      if (text.startsWith("first")) await blocked;
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
    await vi.waitFor(() => expect(writes).toEqual(["firstsecond"]));
    latest = handlers.onMessage(kind === "submit"
      ? { data: JSON.stringify({ type: "keys", keys: ["Enter"] }) }
      : frame("third"), ws);
    release();
    await Promise.all([opening, latest]);
    expect(writes).toEqual(["firstsecond", kind === "submit" ? "Enter" : "third"]);
    expect(ws.close).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.allSettled([opening, latest]);
    await handlers.onClose();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

let fixtureId = 0;
async function liveFixture() {
  const capture = deferred(), captureStarted = deferred(), firstWrite = deferred();
  let blockCapture = false, blockFirstWrite = false;
  const writes: string[] = [];
  const actions: string[] = [];
  const tmux: BrokerTmux = {
    hasSession: async () => true,
    startPipePane: async () => ({ ok: true }),
    stopPipePane: async () => ({ ok: true }),
    getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 80, height: 24 }),
    capturePaneScreen: async () => {
      if (blockCapture) { captureStarted.resolve(); await capture.promise; }
      return "CURRENT SCREEN";
    },
    capturePaneContent: async (_name, lines) => { actions.push(`history:${lines}`); return "HISTORICAL SCREEN\n"; },
    sendKeys: async (_name, keys) => { writes.push(...keys); actions.push(`keys:${keys.join(",")}`); return { ok: true }; },
    sendText: async (_name, text) => {
      writes.push(text);
      actions.push(`text:${text}`);
      if (text.startsWith("first") && blockFirstWrite) await firstWrite.promise;
      return { ok: true };
    },
  };
  let createHandler!: (context: unknown) => unknown;
  registerTerminalWs(new Hono(), ((create: (context: unknown) => unknown) => {
    createHandler = create;
    return async () => {};
  }) as never, { bearerToken: null });
  const name = `live-order-${++fixtureId}@fixture`;
  const context = { req: { param: () => name, query: () => "2" }, get: () => tmux };
  const handlers = createHandler(context) as Handlers;
  const ws = { send: vi.fn(), close: vi.fn() };
  const frame = (message: unknown) => ({ data: JSON.stringify(message) });
  await handlers.onOpen({}, ws);
  await handlers.onMessage(frame({ type: "scroll", offset: 6 }), ws);
  blockCapture = true;
  const returning = handlers.onMessage(frame({ type: "scroll", offset: 0 }), ws);
  await captureStarted.promise;
  return {
    handlers, ws, writes, actions, frame, returning, capture, firstWrite,
    blockFirstWrite: () => { blockFirstWrite = true; },
    freshHandlers: () => createHandler(context) as Handlers,
    cleanup: async () => {
      capture.resolve(); firstWrite.resolve();
      await returning;
      await handlers.onClose();
    },
  };
}

it.each(["text", "submit"] as const)("finishes a live scroll repaint before %s input and keeps later arrivals behind the drain", async kind => {
  const f = await liveFixture();
  f.blockFirstWrite();
  const first = f.handlers.onMessage(f.frame({ type: "text", text: "first" }), f.ws);
  const second = f.handlers.onMessage(f.frame(kind === "submit"
    ? { type: "keys", keys: ["Enter"] }
    : { type: "text", text: "second" }), f.ws);
  let latest: Promise<void> | undefined;
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.writes).toEqual([]); // no echo may race the captured return-to-live screen
    f.capture.resolve();
    await vi.waitFor(() => expect(f.writes).toEqual([kind === "submit" ? "first" : "firstsecond"]));
    latest = f.handlers.onMessage(f.frame({ type: "text", text: "third" }), f.ws);
    f.firstWrite.resolve();
    await Promise.all([f.returning, first, second, latest]);
    expect(f.writes).toEqual(kind === "submit" ? ["first", "Enter", "third"] : ["firstsecond", "third"]);
    expect(f.ws.close).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
    await Promise.allSettled([first, second, latest]);
  }
});

it.each(["frames", "utf8-bytes"] as const)("bounds %s queued behind a live repaint and discards overflowed input", async bound => {
  const f = await liveFixture();
  try {
    const messages = bound === "frames"
      ? Array.from({ length: 33 }, () => ({ type: "keys", keys: ["Enter"] }))
      : ["é".repeat(80_000), "é".repeat(60_000)].map(text => ({ type: "text", text }));
    for (const message of messages) await f.handlers.onMessage(f.frame(message), f.ws);
    expect(f.ws.close).toHaveBeenCalledWith(1009, expect.stringContaining("buffer limit"));
    f.capture.resolve();
    await f.returning;
    expect(f.writes).toEqual([]);
  } finally { await f.cleanup(); }
});

it("admits character bursts behind native work without losing Unicode or crossing key and scroll barriers", async () => {
  const f = await liveFixture();
  f.actions.length = 0;
  const text = "Ordinary typing keeps every quote ' and \" plus ;$()\\, café and 🪻. ".repeat(3);
  try {
    for (const character of text) await f.handlers.onMessage(f.frame({ type: "text", text: character }), f.ws);
    await f.handlers.onMessage(f.frame({ type: "keys", keys: ["Enter"] }), f.ws);
    for (const character of "after Enter") await f.handlers.onMessage(f.frame({ type: "text", text: character }), f.ws);
    await f.handlers.onMessage(f.frame({ type: "scroll", offset: 5 }), f.ws);
    for (const character of "after scroll") await f.handlers.onMessage(f.frame({ type: "text", text: character }), f.ws);
    expect(f.ws.close).not.toHaveBeenCalled();
    f.capture.resolve();
    await f.returning;
    expect(f.actions).toEqual([`text:${text}`, "keys:Enter", "text:after Enter", "history:29", "text:after scroll"]);
  } finally { await f.cleanup(); }
});

it("keeps literal control-containing text as a separate paste boundary", async () => {
  const f = await liveFixture();
  try {
    for (const text of ["before", "\n", "after", "\x1b[?999h", "tail"])
      await f.handlers.onMessage(f.frame({ type: "text", text }), f.ws);
    f.capture.resolve();
    await f.returning;
    expect(f.writes).toEqual(["before", "\n", "after", "\x1b[?999h", "tail"]);
    expect(f.ws.close).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

it("coalesces adjacent pending absolute scroll requests without crossing text or Enter", async () => {
  const f = await liveFixture();
  f.actions.length = 0;
  try {
    for (let offset = 1; offset <= 45; offset++) await f.handlers.onMessage(f.frame({ type: "scroll", offset }), f.ws);
    await f.handlers.onMessage(f.frame({ type: "text", text: "barrier" }), f.ws);
    for (let offset = 46; offset <= 90; offset++) await f.handlers.onMessage(f.frame({ type: "scroll", offset }), f.ws);
    await f.handlers.onMessage(f.frame({ type: "keys", keys: ["Enter"] }), f.ws);
    expect(f.ws.close).not.toHaveBeenCalled();
    f.capture.resolve();
    await f.returning;
    expect(f.actions).toEqual(["history:69", "text:barrier", "history:114", "keys:Enter"]);
  } finally { await f.cleanup(); }
});

it("debits replaced scroll bytes before bounding subsequent native input", async () => {
  const f = await liveFixture();
  const text = "é".repeat(60_000);
  try {
    await f.handlers.onMessage(f.frame({ type: "scroll", offset: 10, padding: "é".repeat(80_000) }), f.ws);
    await f.handlers.onMessage(f.frame({ type: "scroll", offset: 0 }), f.ws);
    await f.handlers.onMessage(f.frame({ type: "text", text }), f.ws);
    expect(f.ws.close).not.toHaveBeenCalled();
    f.capture.resolve();
    await f.returning;
    expect(f.writes).toEqual([text]);
  } finally { await f.cleanup(); }
});

it("discards live queued input on close and never replays it to a replacement viewer", async () => {
  const f = await liveFixture();
  let replacement: Handlers | undefined;
  const queued = f.handlers.onMessage(f.frame({ type: "text", text: "discarded" }), f.ws);
  try {
    await f.handlers.onClose();
    f.capture.resolve();
    await Promise.all([f.returning, queued]);
    expect(f.writes).toEqual([]);
    replacement = f.freshHandlers();
    const nextWs = { send: vi.fn(), close: vi.fn() };
    await replacement.onOpen({}, nextWs);
    await replacement.onMessage(f.frame({ type: "text", text: "fresh" }), nextWs);
    expect(f.writes).toEqual(["fresh"]);
    expect(nextWs.close).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
    await queued;
    await replacement?.onClose();
  }
});
