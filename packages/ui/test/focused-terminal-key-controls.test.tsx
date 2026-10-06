// FocusedTerminal explicit key controls: Interrupt (Ctrl+C), Esc, Tab, Up,
// Down and Enter as tap/click targets, for browsers that intercept the
// shortcut and phones with no Control key. They ride the same input path as
// typing: only the current session's socket, only after it delivered native
// geometry, one frame per press, nothing queued or replayed.

import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";

const s = vi.hoisted(() => ({ sockets: [] as any[], wheel: null as ((ev: { deltaY: number }) => boolean) | null }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = { fontSize: 12 }; cols = 90; rows = 27;
  open(el: HTMLElement) { el.appendChild(document.createElement("div")); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  write(_d: string, done?: () => void) { done?.(); }
  focus() {} scrollToBottom() {} onData() {} dispose() {}
  attachCustomWheelEventHandler(h: (ev: { deltaY: number }) => boolean) { s.wheel = h; }
} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

beforeEach(() => {
  s.sockets.length = 0;
  s.wheel = null;
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

it.each(["natural", "width", "contain"] as const)("offers the six keys in %s fit, disabled until native geometry, sending nothing on mount", (fit) => {
  const view = render(<FocusedTerminal sessionName="fixture" fit={fit} />);
  const buttons = keys(view).getAllByRole("button");
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
    "Interrupt (Ctrl+C)", "Escape", "Tab", "Up arrow", "Down arrow", "Enter",
  ]);
  expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  open(s.sockets[0]);
  expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  expect(s.sockets[0].sent).toEqual([]);
});

it("each press sends exactly one native key frame to the ready socket", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  for (const name of [/interrupt/i, /escape/i, /^tab$/i, /up arrow/i, /down arrow/i, /^enter$/i]) press(view, name);
  expect(s.sockets[0].sent.map((f: string) => JSON.parse(f))).toEqual(
    ["C-c", "Escape", "Tab", "Up", "Down", "Enter"].map((k) => ({ type: "keys", keys: [k] })),
  );
  expect(s.sockets).toHaveLength(1);
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
