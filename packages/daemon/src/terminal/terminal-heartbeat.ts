const HEARTBEAT_INTERVAL_MS = 30_000;
const SCHEDULING_GRACE_MS = 5_000;

/** The Node WebSocket exposed by Hono as WSContext.raw. Control frames never
 * enter the terminal JSON protocol or the native pane. */
export interface TerminalHeartbeatSocket {
  readonly readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong" | "close", listener: () => void): unknown;
  off(event: "pong" | "close", listener: () => void): unknown;
}

export function startTerminalHeartbeat(
  socket: TerminalHeartbeatSocket,
  options: { intervalMs?: number; now?: () => number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? (() => performance.now());
  let timer: ReturnType<typeof setTimeout>;
  let expectedAt = 0;
  let awaitingPong = false;
  let stopped = false;
  const onPong = () => { awaitingPong = false; };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    socket.off("pong", onPong);
    socket.off("close", stop);
  };
  const schedule = () => {
    expectedAt = now() + intervalMs;
    timer = setTimeout(() => {
      if (socket.readyState !== 1) { stop(); return; }
      // A suspended/busy daemon may not have processed the peer's pong yet.
      // A substantially late check gives a fresh full response window instead
      // of blaming the network for an event-loop pause.
      const delayed = now() - expectedAt > SCHEDULING_GRACE_MS;
      if (awaitingPong && !delayed) { stop(); socket.terminate(); return; }
      awaitingPong = true;
      try { socket.ping(); } catch { stop(); socket.terminate(); return; }
      schedule();
    }, intervalMs);
    timer.unref();
  };
  socket.on("pong", onPong);
  socket.on("close", stop);
  schedule();
  return stop;
}
