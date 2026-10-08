// FocusedTerminal explicit key controls: Interrupt (Ctrl+C), Esc, Tab, Up,
// Down and Enter as tap/click targets, for browsers that intercept the
// shortcut and phones with no Control key. They ride the same input path as
// typing: only the current session's socket, only after it delivered native
// geometry, one frame per press, nothing queued or replayed.

import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";

const s = vi.hoisted(() => ({ sockets: [] as any[], wheel: null as ((ev: { deltaY: number }) => boolean) | null, onData: null as ((d: string) => void) | null, bottom: 0, term: null as unknown }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = { fontSize: 12 }; cols = 90; rows = 27;
  open(el: HTMLElement) { el.appendChild(document.createElement("div")); s.term = this; }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  write(_d: string, done?: () => void) { done?.(); }
  focus() {} dispose() {}
  scrollToBottom() { s.bottom++; }
  onData(cb: (d: string) => void) { s.onData = cb; }
  attachCustomWheelEventHandler(h: (ev: { deltaY: number }) => boolean) { s.wheel = h; }
} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

beforeEach(() => {
  s.sockets.length = 0;
  s.wheel = null;
  s.onData = null;
  s.bottom = 0;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1; readyState = 0; sent: string[] = [];
    onopen?: () => void; onmessage?: (e: any) => void; onclose?: (e: any) => void;
    constructor(public url: string) { s.sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const open = (w: any) => act(() => { w.readyState = 1; w.onopen?.(); });
const ready = (w: any) => { open(w); act(() => w.onmessage?.({ data: JSON.stringify({ type: "geometry", cols: 90, rows: 27 }) })); };
const keys = (view: ReturnType<typeof render>, session = "fixture") => within(view.getByRole("group", { name: `Terminal keys for ${session}` }));
const press = (view: ReturnType<typeof render>, name: RegExp, session?: string) => fireEvent.click(keys(view, session).getByRole("button", { name }));

it.each(["natural", "width", "contain"] as const)("offers the keys in %s fit, disabled until native geometry, sending nothing on mount", (fit) => {
  const view = render(<FocusedTerminal sessionName="fixture" fit={fit} />);
  const buttons = keys(view).getAllByRole("button");
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
    "Interrupt (Ctrl+C)", "Escape", "Tab", "Shift+Tab", "Up arrow", "Down arrow", "Shift+Left arrow", "Enter",
  ]);
  expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  open(s.sockets[0]);
  expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  expect(s.sockets[0].sent).toEqual([]);
});

it("each press sends exactly one native key frame to the ready socket", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  for (const name of [/interrupt/i, /escape/i, /^tab$/i, /^shift\+tab$/i, /^up arrow/i, /down arrow/i, /^shift\+left arrow$/i, /^enter$/i]) press(view, name);
  expect(s.sockets[0].sent.map((f: string) => JSON.parse(f))).toEqual(
    ["C-c", "Escape", "Tab", "BTab", "Up", "Down", "S-Left", "Enter"].map((k) => ({ type: "keys", keys: [k] })),
  );
  expect(s.sockets).toHaveLength(1);
});

// Shift is not a sticky browser modifier: the chord is one press, and the
// next plain key is unshifted.
it("Shift+Tab and Shift+Left are single chords that do not shift the next key", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  press(view, /^shift\+tab$/i);
  press(view, /^tab$/i);
  press(view, /^shift\+left arrow$/i);
  act(() => { s.onData!("\x1b[D"); });
  expect(s.sockets[0].sent.map((f: string) => JSON.parse(f))).toEqual(
    ["BTab", "Tab", "S-Left", "Left"].map((k) => ({ type: "keys", keys: [k] })),
  );
});

it("Keyboard focuses the terminal input and sends nothing", () => {
  const focus = vi.fn();
  const view = render(<FocusedTerminal sessionName="fixture" autoFocus={false} />);
  ready(s.sockets[0]);
  const term = s.term as { focus(): void };
  term.focus = focus;
  const keyboard = view.getByRole("button", { name: /show keyboard/i });
  expect(fireEvent.mouseDown(keyboard)).toBe(false);
  fireEvent.click(keyboard);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(s.sockets[0].sent).toEqual([]);
});

it("keeps focus where the operator is typing", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  const interrupt = keys(view).getByRole("button", { name: /interrupt/i });
  expect(fireEvent.mouseDown(interrupt)).toBe(false);
});

it("is disabled while reconnecting or after a wake, and the replacement socket gets nothing early", async () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  act(() => { s.sockets[0].readyState = 3; s.sockets[0].onclose?.({ code: 1006, reason: "" }); });
  expect((keys(view).getByRole("button", { name: /interrupt/i }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  ready(s.sockets[1]);
  act(() => { window.dispatchEvent(new Event("online")); });
  expect(s.sockets).toHaveLength(3);
  open(s.sockets[2]);
  expect((keys(view).getByRole("button", { name: /interrupt/i }) as HTMLButtonElement).disabled).toBe(true);
  expect(s.sockets.flatMap((w) => w.sent)).toEqual([]);
});

it("targets only the current session after a switch", () => {
  const view = render(<FocusedTerminal sessionName="a" />);
  ready(s.sockets[0]);
  view.rerender(<FocusedTerminal sessionName="b" />);
  const b = s.sockets[1];
  open(b);
  expect((keys(view, "b").getByRole("button", { name: /interrupt/i }) as HTMLButtonElement).disabled).toBe(true);
  act(() => b.onmessage?.({ data: JSON.stringify({ type: "geometry", cols: 90, rows: 27 }) }));
  press(view, /interrupt/i, "b");
  expect(s.sockets[0].sent).toEqual([]);
  expect(b.sent).toEqual([JSON.stringify({ type: "keys", keys: ["C-c"] })]);
});

it("returns to the live bottom first and never replays initialText", () => {
  const view = render(<FocusedTerminal sessionName="fixture" initialText="draft" />);
  ready(s.sockets[0]);
  act(() => { s.wheel!({ deltaY: -1 }); });
  press(view, /^enter$/i);
  press(view, /^enter$/i);
  expect(s.sockets[0].sent.map((f: string) => JSON.parse(f))).toEqual([
    { type: "text", text: "draft" },
    { type: "scroll", offset: 3 },
    { type: "scroll", offset: 0 },
    { type: "keys", keys: ["Enter"] },
    { type: "keys", keys: ["Enter"] },
  ]);
});

it("is not offered on the error view", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  act(() => { s.sockets[0].onclose?.({ code: 1008, reason: "session not found: fixture" }); });
  expect(view.queryByRole("group", { name: /terminal keys/i })).toBeNull();
});

// xterm's own scrollable element can consume a native wheel (local history)
// before the broker wheel callback, so the server offset stays 0. A key
// press must still bring the local viewport back to live, as typing does
// via xterm's scrollOnUserInput; paused input must not act at all.
it("a press returns xterm's local viewport to live even when the server offset is zero; paused input does nothing", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  open(s.sockets[0]);
  s.bottom = 0;
  act(() => { s.onData!("\r"); });
  expect(s.bottom).toBe(0);
  expect(s.sockets[0].sent).toEqual([]);
  act(() => s.sockets[0].onmessage?.({ data: JSON.stringify({ type: "geometry", cols: 90, rows: 27 }) }));
  s.bottom = 0;
  press(view, /^enter$/i);
  expect(s.bottom).toBe(1);
  expect(s.sockets[0].sent).toEqual([JSON.stringify({ type: "keys", keys: ["Enter"] })]);
});
