// Scroll ownership and callback cleanup for the live terminal. xterm is a fake
// here: these cases prove which element is scrolled and when delayed callbacks
// may act. The real-renderer metric correction lives in
// focused-terminal-xterm-metrics.test.tsx; browser layout is root-verified.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, fireEvent } from "@testing-library/react";

interface FakeTerm {
  host: HTMLElement;
  textarea: HTMLTextAreaElement;
  options: { fontSize: number };
  cols: number; rows: number;
  dataHandler?: (data: string) => void;
  wheelHandler?: (ev: WheelEvent) => boolean;
  scrollToBottomCalls: number;
  pendingWrites: Array<() => void>;
  deferWrites: boolean;
}

const state = vi.hoisted(() => ({ sockets: [] as any[], terms: [] as FakeTerm[] }));

vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: { fontSize: number }; cols: number; rows: number; fake!: FakeTerm;
  constructor(options: { fontSize: number; cols: number; rows: number }) { this.options = options; this.cols = options.cols; this.rows = options.rows; }
  open(el: HTMLElement) {
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    textarea.style.top = "600px";
    el.appendChild(textarea);
    this.fake = { host: el, textarea, options: this.options, cols: this.cols, rows: this.rows, scrollToBottomCalls: 0, pendingWrites: [], deferWrites: false };
    state.terms.push(this.fake);
  }
  resize(cols: number, rows: number) { this.cols = this.fake.cols = cols; this.rows = this.fake.rows = rows; }
  write(_data: string, done?: () => void) {
    // A browser can move the scroll owner while xterm parses (e.g. stale caret
    // reveal); model that as a jump the completion callback must undo.
    const parent = this.fake.host.parentElement;
    const owner = parent?.hasAttribute("data-terminal-scroll-owner") ? parent : null;
    if (owner) owner.scrollTop = 0;
    if (this.fake.deferWrites) this.fake.pendingWrites.push(() => done?.());
    else done?.();
  }
  focus() {}
  scrollToBottom() { this.fake.scrollToBottomCalls++; }
  onData(handler: (data: string) => void) { this.fake.dataHandler = handler; }
  attachCustomWheelEventHandler(handler: (ev: WheelEvent) => boolean) { this.fake.wheelHandler = handler; }
  dispose() {}
} }));

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

beforeEach(() => {
  state.sockets.length = state.terms.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1; readyState = 1; sent: string[] = []; closed = false;
    onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: (event: { code: number; reason: string }) => void;
    constructor(public url: string) { state.sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
    send(data: string) { this.sent.push(data); }
    close() { this.closed = true; this.readyState = 3; }
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const send = (socket: any, data: unknown) => act(async () => { socket.onmessage?.({ data: JSON.stringify(data) }); });

/** Give the fit wrapper a scrollable box and record every scrollTop write. */
function layout(wrapper: HTMLElement, host: HTMLElement, { scrollHeight = 900, clientHeight = 300 } = {}) {
  let top = 0, left = 0;
  const writes: number[] = [];
  Object.defineProperty(wrapper, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(wrapper, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(wrapper, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; writes.push(value); } });
  Object.defineProperty(wrapper, "scrollLeft", { configurable: true, get: () => left, set: (value: number) => { left = value; } });
  // Real layout: the host moves up as the owner scrolls.
  host.getBoundingClientRect = () => ({ top: -top, left: -left, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  wrapper.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return writes;
}

function mountViewer(session: string) {
  const mounted = render(<FocusedTerminal sessionName={session} fit="contain" />);
  const wrapper = mounted.getByTestId(`focused-terminal-fit-${session}`);
  const host = mounted.getByTestId(`focused-terminal-${session}`);
  const writes = layout(wrapper, host);
  return { mounted, wrapper, host, writes };
}

it("reveals the prompt in the fit wrapper, the actual scroll owner, not the inner xterm host", async () => {
  const { wrapper, host } = mountViewer("fixture");
  await advance(1);
  await send(state.sockets[0], { type: "geometry", cols: 155, rows: 37 });
  await send(state.sockets[0], { type: "output", data: "prompt" });
  await advance(60);
  // cursor 600 + line 14 - client 300 + 3 lines of context = 356 (max 600).
  expect(wrapper.scrollTop).toBe(356);
  expect(host.scrollTop).toBe(0);
  expect(wrapper.hasAttribute("data-terminal-scroll-owner")).toBe(true);
});

it("preserves the reader's pan on the owner through output and native geometry changes after the prompt window", async () => {
  const { wrapper } = mountViewer("fixture");
  await advance(1);
  await send(state.sockets[0], { type: "geometry", cols: 155, rows: 37 });
  await advance(3000);
  wrapper.scrollTop = 120; wrapper.scrollLeft = 33;
  await send(state.sockets[0], { type: "output", data: "late reply" });
  expect([wrapper.scrollTop, wrapper.scrollLeft]).toEqual([120, 33]);
  await send(state.sockets[0], { type: "geometry", cols: 137, rows: 43 });
  await send(state.sockets[0], { type: "output", data: "repaint" });
  await advance(30);
  expect([wrapper.scrollTop, wrapper.scrollLeft]).toEqual([120, 33]);
  expect(state.terms[0]!.cols).toBe(137);
  expect(state.sockets[0].sent).toEqual([]);
});

it("lets the user take over during the prompt window: delayed reveals never drag the owner back", async () => {
  const { wrapper, writes } = mountViewer("fixture");
  await advance(1);
  await send(state.sockets[0], { type: "geometry", cols: 155, rows: 37 });
  await act(async () => { wrapper.dispatchEvent(new Event("touchstart")); });
  wrapper.scrollTop = 10;
  const before = writes.length;
  await send(state.sockets[0], { type: "output", data: "reply during window" });
  await advance(100);
  expect(wrapper.scrollTop).toBe(10);
  // After takeover only the fake's simulated jump (0) and the restore of the
  // user's own offset were written; no prompt reveal (356/600) ran.
  expect(writes.slice(before).every((value) => value === 0 || value === 10)).toBe(true);
});

it("keeps a server-side history viewer in history through delayed callbacks, output and resize", async () => {
  const { wrapper } = mountViewer("fixture");
  await advance(1);
  await send(state.sockets[0], { type: "geometry", cols: 155, rows: 37 });
  const term = state.terms[0]!;
  const bottomCallsBefore = term.scrollToBottomCalls;
  await act(async () => { expect(term.wheelHandler!(new WheelEvent("wheel", { deltaY: -100 }))).toBe(false); });
  wrapper.scrollTop = 40;
  await send(state.sockets[0], { type: "output", data: "history window" });
  await send(state.sockets[0], { type: "geometry", cols: 120, rows: 30 });
  await send(state.sockets[0], { type: "output", data: "history window resized" });
  await advance(3000);
  expect(state.sockets[0].sent).toEqual([JSON.stringify({ type: "scroll", offset: 3 })]);
  expect(term.scrollToBottomCalls).toBe(bottomCallsBefore);
  expect(wrapper.scrollTop).toBe(40);
});

it("keeps two viewers of one pane independent: one viewer's typing, history and pan never move the other", async () => {
  const a = mountViewer("fixture-a");
  const b = mountViewer("fixture-b");
  await advance(1);
  const [socketA, socketB] = state.sockets;
  for (const socket of [socketA, socketB]) await send(socket, { type: "geometry", cols: 155, rows: 37 });
  await advance(3000);
  a.wrapper.scrollTop = 200; b.wrapper.scrollTop = 0;
  const [termA] = state.terms;
  await act(async () => { termA!.dataHandler!("ok\r"); });
  await act(async () => { termA!.wheelHandler!(new WheelEvent("wheel", { deltaY: -1 })); });
  for (const socket of [socketA, socketB]) await send(socket, { type: "output", data: "shared reply" });
  await advance(100);
  // A's own accepted typing revealed A's prompt (356); A's history wheel and
  // the shared output then kept it there. B never moved.
  expect(a.wrapper.scrollTop).toBe(356);
  expect(b.wrapper.scrollTop).toBe(0);
  expect(socketA.sent).toEqual([
    JSON.stringify({ type: "text", text: "ok" }),
    JSON.stringify({ type: "keys", keys: ["Enter"] }),
    JSON.stringify({ type: "scroll", offset: 3 }),
  ]);
  expect(socketB.sent).toEqual([]);
});

it("cancels delayed prompt reveals on unmount", async () => {
  const { mounted, writes } = mountViewer("fixture");
  await advance(1);
  await send(state.sockets[0], { type: "geometry", cols: 155, rows: 37 });
  await send(state.sockets[0], { type: "output", data: "prompt" });
  const before = writes.length;
  mounted.unmount();
  await advance(200);
  expect(writes.length).toBe(before);
  expect(state.sockets[0].closed).toBe(true);
});

it("ignores a replaced session's late write callback and pending reveals", async () => {
  const mounted = render(<FocusedTerminal sessionName="fixture-old" fit="contain" />);
  const wrapper = mounted.getByTestId("focused-terminal-fit-fixture-old");
  const writes = layout(wrapper, mounted.getByTestId("focused-terminal-fixture-old"));
  await advance(1);
  await send(state.sockets[0], { type: "geometry", cols: 155, rows: 37 });
  await advance(3000);
  state.terms[0]!.deferWrites = true;
  wrapper.scrollTop = 77;
  await send(state.sockets[0], { type: "output", data: "old session output" });

  mounted.rerender(<FocusedTerminal sessionName="fixture-new" fit="contain" />);
  expect(state.sockets[0].closed).toBe(true);
  expect(mounted.getByTestId("focused-terminal-fit-fixture-new")).toBe(wrapper);
  await advance(1);
  wrapper.scrollTop = 0;
  const before = writes.length;
  await act(async () => { for (const flush of state.terms[0]!.pendingWrites) flush(); });
  expect(wrapper.scrollTop).toBe(0);
  expect(writes.slice(before).includes(77)).toBe(false);
});


it.each(["key", "typing"])("natural keyboard viewport returns to the prompt after user pan and %s input", async (kind) => {
  const vv = Object.assign(new EventTarget(), { width: 390, height: 150, offsetTop: 0, offsetLeft: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  try {
    const view = render(<FocusedTerminal sessionName="fixture" fit="natural" autoFocus={false} />);
    const host = view.getByTestId("focused-terminal-fixture");
    const owner = host.parentElement!;
    layout(owner, host, {scrollHeight:900,clientHeight:100});
    await advance(1);
    await send(state.sockets[0], {type:"geometry",cols:90,rows:4});
    act(() => state.terms[0]!.textarea.focus());
    await advance(100);
    expect(owner.style.overflow).toBe("auto");
    expect(owner.hasAttribute("data-terminal-scroll-owner")).toBe(true);
    // Stop the initial reveal window, then model an operator panning to older rows.
    await advance(3000);
    act(() => owner.dispatchEvent(new Event("touchstart", {bubbles:true})));
    owner.scrollTop=40;
    // Output alone keeps the reader's pan on this owner (the fake write jumps it to 0).
    await send(state.sockets[0], {type:"output",data:"reply"});
    await advance(100);
    expect(owner.scrollTop).toBe(40);
    if(kind === "key") fireEvent.click(view.getByRole("button",{name:/^enter$/i}));
    else act(() => state.terms[0]!.dataHandler!("x"));
    await advance(100);
    expect(state.sockets[0].sent).toEqual([JSON.stringify(kind === "key" ? {type:"keys",keys:["Enter"]} : {type:"text",text:"x"})]);
    // Accepted input reveals the prompt: cursor 600 + line 14 - client 100 + 3 lines = 556.
    expect(owner.scrollTop).toBe(556);
    expect(host.scrollTop).toBe(0);
    // Keyboard hidden: the bound and its ownership are removed; output and
    // input fall back to the plain natural layout without stray frames.
    act(() => { vv.height = 844; vv.dispatchEvent(new Event("resize")); });
    await advance(100);
    expect(owner.hasAttribute("data-terminal-scroll-owner")).toBe(false);
    expect(owner.style.overflow).toBe("");
    await send(state.sockets[0], {type:"output",data:"after keyboard"});
    await advance(100);
    expect(state.sockets[0].sent).toHaveLength(1);
  } finally { delete (window as any).visualViewport; }
});
