import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { startTerminalHeartbeat } from "../src/terminal/terminal-heartbeat.js";

afterEach(() => vi.useRealTimers());

it.each([true, false])("gives a fresh response window after a delayed event-loop check (peer replies: %s)", async replies => {
  vi.useFakeTimers();
  let time = 0;
  const socket = Object.assign(new EventEmitter(), { readyState: 1, ping: vi.fn(), terminate: vi.fn() });
  const stop = startTerminalHeartbeat(socket, { now: () => time });
  try {
    time = 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    // The peer's pong cannot be processed while the daemon is suspended.
    time = 95_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.ping).toHaveBeenCalledTimes(2);
    if (replies) socket.emit("pong");
    time += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.terminate).toHaveBeenCalledTimes(replies ? 0 : 1);
    expect(socket.ping).toHaveBeenCalledTimes(replies ? 3 : 2);
  } finally { stop(); }
  expect(vi.getTimerCount()).toBe(0);
  expect(socket.listenerCount("pong")).toBe(0);
  expect(socket.listenerCount("close")).toBe(0);
});

it("cleans up a failed control-frame write", async () => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1, ping: vi.fn(() => { throw new Error("fixture socket closed"); }), terminate: vi.fn(),
  });
  startTerminalHeartbeat(socket);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(socket.listenerCount("pong")).toBe(0);
});
