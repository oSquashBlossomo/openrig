// FocusedTerminal paste and input budget. An explicit clipboard paste is one
// literal text frame (tmux paste-buffer -r -p keeps LF and brackets once), not
// one Enter per line. One input event whose encoded frames exceed the daemon's
// 256 KiB queue is refused visibly before anything is sent; a server 1009 close
// stops automatic reconnects and warns that input may already have arrived.

import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const s = vi.hoisted(() => ({ sockets: [] as any[], wheel: null as ((ev: { deltaY: number }) => boolean) | null, onData: null as ((d: string) => void) | null, textareas: [] as HTMLTextAreaElement[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = { fontSize: 12 }; cols = 90; rows = 27;
  open(el: HTMLElement) {
    // Mirrors xterm's own Clipboard.handlePasteEvent: LF/CRLF -> CR, then onData.
    const textarea = document.createElement("textarea");
    textarea.addEventListener("paste", (ev: any) => s.onData?.(ev.clipboardData.getData("text/plain").replace(/\r?\n/g, "\r")));
    el.appendChild(textarea);
    s.textareas.push(textarea);
  }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  write(_d: string, done?: () => void) { done?.(); }
  focus() {} dispose() {} scrollToBottom() {}
  onData(cb: (d: string) => void) { s.onData = cb; }
  attachCustomWheelEventHandler(h: (ev: { deltaY: number }) => boolean) { s.wheel = h; }
} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

const LIMIT = 256 * 1024;
const TEXT_FRAME_OVERHEAD = JSON.stringify({ type: "text", text: "" }).length;
// Text whose text frame encodes to exactly LIMIT bytes; "é" is one visible
// character but two UTF-8 bytes, so it is far fewer than LIMIT characters.
const AT_LIMIT = "é".repeat(Math.floor((LIMIT - TEXT_FRAME_OVERHEAD) / 2)) + "a".repeat((LIMIT - TEXT_FRAME_OVERHEAD) % 2);

beforeEach(() => {
  s.sockets.length = 0;
  s.textareas.length = 0;
  s.wheel = null;
  s.onData = null;
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
const frames = (w: any) => w.sent.map((f: string) => JSON.parse(f));
const paste = (text: string, target: HTMLElement = s.textareas.at(-1)!) => {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : "") } });
  act(() => { target.dispatchEvent(ev); });
  return ev;
};

it("sends an explicit multi-line paste as one literal text frame with no implicit Enter", () => {
  render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  const lines = Array.from({ length: 24 }, (_, i) => `line ${i}\tcafé ✓`);
  const ev = paste(lines.join("\r\n") + "\n");
  expect(ev.defaultPrevented).toBe(true);
  expect(frames(s.sockets[0])).toEqual([{ type: "text", text: lines.join("\n") + "\n" }]);
});

it("keeps typed Enter, Tab, arrows and Ctrl+C as native keys", () => {
  render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  act(() => { s.onData!("ls\r"); s.onData!("\t"); s.onData!("\x1b[A"); s.onData!("\x03"); });
  expect(frames(s.sockets[0])).toEqual([
    { type: "text", text: "ls" }, { type: "keys", keys: ["Enter"] },
    { type: "keys", keys: ["Tab"] }, { type: "keys", keys: ["Up"] }, { type: "keys", keys: ["C-c"] },
  ]);
});

it("admits exactly 256 KiB of encoded JSON and refuses one byte more before sending anything", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  expect(AT_LIMIT.length).toBeLessThan(LIMIT / 2 + 1);
  paste(AT_LIMIT + "é");
  expect(s.sockets[0].sent).toEqual([]);
  expect(view.getByRole("alert").textContent).toMatch(/not sent.*256 KiB/i);
  paste(AT_LIMIT);
  expect(s.sockets[0].sent).toHaveLength(1);
  expect(new TextEncoder().encode(s.sockets[0].sent[0]).byteLength).toBe(LIMIT);
  expect(view.queryByRole("alert")).toBeNull();
});

it("counts a pending return-to-live scroll in the budget and sends neither when refused", () => {
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  act(() => { s.wheel!({ deltaY: -1 }); });
  paste(AT_LIMIT);
  expect(frames(s.sockets[0])).toEqual([{ type: "scroll", offset: 3 }]);
  expect(view.getByRole("alert").textContent).toMatch(/not sent/i);
  act(() => { s.onData!("x"); });
  expect(frames(s.sockets[0])).toEqual([{ type: "scroll", offset: 3 }, { type: "scroll", offset: 0 }, { type: "text", text: "x" }]);
});

it("refuses oversized initialText with zero frames and keeps the connection usable", () => {
  const view = render(<FocusedTerminal sessionName="fixture" initialText={"€".repeat(LIMIT / 3)} />);
  ready(s.sockets[0]);
  expect(s.sockets[0].sent).toEqual([]);
  expect(view.getByRole("alert").textContent).toMatch(/not sent/i);
  act(() => { s.onData!("\r"); });
  expect(frames(s.sockets[0])).toEqual([{ type: "keys", keys: ["Enter"] }]);
  expect(s.sockets).toHaveLength(1);
});

it("stops on a server 1009 with an inspect-before-retry warning; Retry never replays input", async () => {
  const onClosed = vi.fn();
  const view = render(<FocusedTerminal sessionName="fixture" initialText="draft" onClosed={onClosed} />);
  ready(s.sockets[0]);
  act(() => { s.sockets[0].readyState = 3; s.sockets[0].onclose?.({ code: 1009, reason: "terminal input exceeded buffer limit" }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(s.sockets).toHaveLength(1);
  expect(view.getByRole("alert").textContent).toMatch(/may already have reached the terminal.*inspect/i);
  expect(onClosed).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  ready(s.sockets[1]);
  expect(s.sockets[1].sent).toEqual([]);
});

it("fences a stale session: its paste and 1009 never reach or affect the current one", () => {
  const view = render(<FocusedTerminal sessionName="a" />);
  const a = s.sockets[0];
  ready(a);
  const staleTextarea = s.textareas[0];
  view.rerender(<FocusedTerminal sessionName="b" />);
  const b = s.sockets[1];
  ready(b);
  act(() => { a.onclose?.({ code: 1009, reason: "terminal input exceeded buffer limit" }); });
  expect(view.queryByRole("alert")).toBeNull();
  paste("one\ntwo");
  expect(a.sent).toEqual([]);
  expect(frames(b)).toEqual([{ type: "text", text: "one\ntwo" }]);
  expect(staleTextarea.isConnected).toBe(false);
});
