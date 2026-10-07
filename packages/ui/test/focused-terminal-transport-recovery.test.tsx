// FocusedTerminal transport recovery: every connect attempt is bounded, the
// connecting/reconnecting/failed state is visible OUTSIDE the (hidden until
// geometry) xterm host, a definitive end always notifies the slot owner, a
// session change after a failure opens the new session, and browser
// wake/network return replaces a possibly half-open socket without replaying
// input. A browser reports an HTTP upgrade rejection (401/403) only as 1006,
// so the copy never names a cause it cannot observe.

import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const s = vi.hoisted(() => ({ sockets: [] as any[], writes: [] as string[], disposed: 0, onData: null as ((d: string) => void) | null }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = { fontSize: 12 }; cols = 90; rows = 27;
  open(el: HTMLElement) { const child = document.createElement("div"); child.className = "xterm"; el.appendChild(child); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  write(data: string, done?: () => void) { s.writes.push(data); done?.(); }
  focus() {} scrollToBottom() {} attachCustomWheelEventHandler() {}
  onData(cb: (d: string) => void) { s.onData = cb; }
  dispose() { s.disposed++; }
} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

beforeEach(() => {
  s.sockets.length = s.writes.length = s.disposed = 0;
  s.onData = null;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1; readyState = 0; sent: string[] = []; closed = false;
    onopen?: () => void; onmessage?: (e: any) => void; onclose?: (e: any) => void; onerror?: () => void;
    constructor(public url: string) { s.sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    // Like a half-open/stuck transport: close() fires no close event.
    close() { this.closed = true; this.readyState = 3; }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const open = (w: any) => act(() => { w.readyState = 1; w.onopen?.(); });
const frame = (w: any, data: unknown) => act(() => w.onmessage?.({ data: JSON.stringify(data) }));
const close = (w: any, code: number, reason = "") => act(() => { w.readyState = 3; w.onclose?.({ code, reason }); });
const ready = (w: any) => { open(w); frame(w, { type: "geometry", cols: 90, rows: 27 }); };
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const status = (view: ReturnType<typeof render>) => view.queryByTestId("focused-terminal-status-fixture")?.textContent ?? null;

it("bounds a socket that never opens or closes", async () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  expect(status(view)).toMatch(/connecting/i);
  await advance(60_000);
  expect(s.sockets[0].closed).toBe(true);
  expect(s.sockets.length).toBeGreaterThan(1);
});

it("bounds an opened socket that never receives native geometry", async () => {
  render(<FocusedTerminal sessionName="fixture" />);
  open(s.sockets[0]);
  await advance(60_000);
  expect(s.sockets[0].closed).toBe(true);
  expect(s.sockets.length).toBeGreaterThan(1);
});

it("shows a pre-geometry close outside the hidden xterm without naming a cause", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  close(s.sockets[0], 1006);
  expect(view.getByTestId("focused-terminal-fixture").style.visibility).toBe("hidden");
  expect(status(view)).toMatch(/reconnecting \(attempt 2 of 4\)/);
  expect(status(view)).not.toMatch(/403|origin|auth|not found/i);
});

it("gives up after bounded attempts, notifies the slot owner once, and Retry reconnects", async () => {
  const onClosed = vi.fn();
  const view = render(<FocusedTerminal sessionName="fixture" onClosed={onClosed} />);
  for (let i = 0; i < 4; i++) {
    close(s.sockets[i], 1006);
    await advance(3000);
  }
  expect(s.sockets).toHaveLength(4);
  expect(onClosed).toHaveBeenCalledTimes(1);
  const text = view.getByTestId("focused-terminal-fixture").textContent!;
  expect(text).toMatch(/could not be established after 4 attempts/);
  expect(text).toMatch(/browser does not report why/);
  await advance(60_000);
  expect(s.sockets).toHaveLength(4);
  fireEvent.click(view.getByRole("button", { name: /retry/i }));
  expect(s.sockets).toHaveLength(5);
  ready(s.sockets[4]);
  expect(view.getByTestId("focused-terminal-fixture").style.visibility).toBe("visible");
  expect(status(view)).toBeNull();
});

it("opens a different session after the previous session failed definitively", async () => {
  const view = render(<FocusedTerminal sessionName="gone" />);
  open(s.sockets[0]); close(s.sockets[0], 1008, "session not found: gone");
  expect(view.container.textContent).toContain("session not found: gone");
  view.rerender(<FocusedTerminal sessionName="available" />);
  await act(async () => {});
  expect(s.sockets.some((w) => w.url.includes("/available?"))).toBe(true);
  expect(view.container.textContent).not.toContain("session not found");
});

it("notifies the slot owner when a protocol failure ends the viewer", () => {
  const onClosed = vi.fn();
  render(<FocusedTerminal sessionName="fixture" onClosed={onClosed} />);
  open(s.sockets[0]); frame(s.sockets[0], { type: "output", data: "no geometry" });
  close(s.sockets[0], 1005);
  expect(s.disposed).toBe(1);
  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(onClosed.mock.calls[0][0]).toContain("before native geometry");
});

it("does not notify the slot owner for its own admission refusal", async () => {
  const onClosed = vi.fn();
  render(<FocusedTerminal sessionName="fixture" onClosed={onClosed} beforeConnect={async () => ({ refuse: "seat changed" })} />);
  await act(async () => {});
  expect(onClosed).not.toHaveBeenCalled();
});

it("replaces an OPEN socket when the network returns, keeps the display, and pauses input until geometry", async () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  frame(s.sockets[0], { type: "output", data: "old snapshot" });
  act(() => { window.dispatchEvent(new Event("online")); });
  expect(s.sockets[0].closed).toBe(true);
  expect(s.sockets).toHaveLength(2);
  expect(view.getByTestId("focused-terminal-fixture").style.visibility).toBe("visible");
  expect(status(view)).toMatch(/input is paused/i);
  open(s.sockets[1]);
  act(() => { s.onData!("typed while unverified"); });
  expect(s.sockets[1].sent).toEqual([]);
  frame(s.sockets[1], { type: "geometry", cols: 90, rows: 27 });
  expect(status(view)).toBeNull();
  act(() => { s.onData!("x"); });
  expect(s.sockets[1].sent).toEqual([JSON.stringify({ type: "text", text: "x" })]);
  // Nothing typed earlier is replayed onto either socket.
  expect(s.sockets[0].sent).toEqual([]);
});

it("reconnects after a long hidden period or a back/forward cache restore, not on a brief tab switch", async () => {
  render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await advance(1000);
  visibility.mockReturnValue("visible");
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(s.sockets).toHaveLength(1);
  visibility.mockReturnValue("hidden");
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await advance(60_000);
  visibility.mockReturnValue("visible");
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(s.sockets).toHaveLength(2);
  ready(s.sockets[1]);
  const restore = new Event("pageshow") as Event & { persisted?: boolean };
  restore.persisted = true;
  act(() => { window.dispatchEvent(restore); });
  expect(s.sockets).toHaveLength(3);
  visibility.mockRestore();
});

it("a wake reconnect during a pending admission never opens two sockets", async () => {
  let release!: (v: true) => void;
  const beforeConnect = vi.fn(({ reconnect }: { reconnect: boolean }) => reconnect ? Promise.resolve(true as const) : new Promise<true>((r) => { release = r; }));
  render(<FocusedTerminal sessionName="fixture" beforeConnect={beforeConnect} />);
  act(() => { window.dispatchEvent(new Event("online")); });
  await act(async () => {});
  expect(s.sockets).toHaveLength(1);
  await act(async () => { release(true); });
  expect(s.sockets).toHaveLength(1);
});

it("returning to a session that failed earlier connects again instead of showing its stale error", async () => {
  const view = render(<FocusedTerminal sessionName="a" />);
  close(s.sockets[0], 1008, "session not found: a");
  view.rerender(<FocusedTerminal sessionName="b" />);
  await act(async () => {});
  view.rerender(<FocusedTerminal sessionName="a" />);
  await act(async () => {});
  expect(s.sockets.filter((w) => w.url.includes("/a?"))).toHaveLength(2);
  expect(view.container.textContent).not.toContain("session not found");
});

// Each attempt ends exactly once: a permanent ending disarms its ready
// deadline, so nothing reconnects, re-admits or re-notifies in the background.
it.each([
  ["definitive close", (w: any) => { open(w); close(w, 1008, "session not found: fixture"); }],
  ["protocol failure", (w: any) => { open(w); frame(w, { type: "output", data: "before geometry" }); close(w, 1005); }],
])("a %s before geometry stays terminal after the ready deadline; only Retry renews", async (_name, end) => {
  const onClosed = vi.fn();
  const view = render(<FocusedTerminal sessionName="fixture" onClosed={onClosed} />);
  end(s.sockets[0]);
  await advance(60_000);
  expect(s.sockets).toHaveLength(1);
  expect(onClosed).toHaveBeenCalledTimes(1);
  act(() => { s.onData?.("typed after failure"); });
  expect(s.sockets[0].sent).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: /retry/i }));
  expect(s.sockets).toHaveLength(2);
});

it("bounded failed connects notify the owner once, even after the last ready deadline", async () => {
  const onClosed = vi.fn();
  render(<FocusedTerminal sessionName="fixture" onClosed={onClosed} />);
  for (let i = 0; i < 4; i++) {
    close(s.sockets[i], 1006);
    await advance(3000);
  }
  await advance(60_000);
  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(s.sockets).toHaveLength(4);
});

it("a refused reconnect admission stays refused after the closed socket's ready deadline", async () => {
  const beforeConnect = vi.fn(async ({ reconnect }: { reconnect: boolean }) => reconnect ? { refuse: "seat changed" } : true as const);
  const view = render(<FocusedTerminal sessionName="fixture" beforeConnect={beforeConnect} />);
  await act(async () => {});
  close(s.sockets[0], 1006);
  await advance(3000);
  expect(view.container.textContent).toContain("seat changed");
  await advance(60_000);
  expect(beforeConnect).toHaveBeenCalledTimes(2);
});

it("a deadline-abandoned socket that opens late sends nothing; initialText goes once to the replacement", async () => {
  render(<FocusedTerminal sessionName="fixture" initialText="draft" />);
  await advance(15_000 + 3000);
  expect(s.sockets).toHaveLength(2);
  open(s.sockets[0]);
  expect(s.sockets[0].sent).toEqual([]);
  open(s.sockets[1]);
  expect(s.sockets[1].sent).toEqual([JSON.stringify({ type: "text", text: "draft" })]);
});

it("renders the failure on the opaque terminal plate with a readable 44px Retry, whatever the page theme", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  close(s.sockets[0], 1008, "session not found: fixture");
  const panel = view.getByTestId("focused-terminal-fixture");
  // Same opaque surface as the live xterm, so light text never lands on a light page.
  expect(panel.style.backgroundColor).toBe("rgb(12, 10, 9)");
  expect(panel.className).not.toMatch(/text-stone-[34]00/);
  const retry = view.getByRole("button", { name: /retry/i });
  expect(retry.className).toContain("min-h-[44px]");
  expect(retry.className).not.toMatch(/text-stone-[34]00/);
});
