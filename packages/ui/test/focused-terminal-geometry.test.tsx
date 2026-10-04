import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
const state = vi.hoisted(() => ({ sockets: [] as any[], terms: [] as any[], events: [] as string[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: { fontSize: number }; cols: number; rows: number;
  constructor(options: any) { this.options = options; this.cols = options.cols; this.rows = options.rows; state.terms.push(this); }
  open(el: HTMLElement) {
    Object.defineProperty(el, "offsetWidth", { configurable: true, get: () => this.cols * 10 * this.options.fontSize / 12 });
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => this.rows * 20 * this.options.fontSize / 12 });
  }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; state.events.push(`resize:${cols}:${rows}`); }
  write(data: string, done?: () => void) { state.events.push(`write:${data}`); done?.(); }
  focus() {} scrollToBottom() {} onData() {} dispose() {} attachCustomWheelEventHandler() {}
} }));
import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

beforeEach(() => {
  state.sockets.length = state.terms.length = state.events.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1; readyState = 1; sent: string[] = []; onopen?: () => void; onmessage?: (event: any) => void;
    constructor(public url: string) { state.sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
    send(data: string) { this.sent.push(data); } close() {}
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const frame = async (data: unknown) => act(async () => state.sockets[0].onmessage?.({ data: JSON.stringify(data) }));

it("negotiates geometry framing and resizes the browser before writing a snapshot without sending resize input", async () => {
  render(<FocusedTerminal sessionName="fixture" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(state.sockets[0].url).toContain("protocol=2");
  await frame({ type: "geometry", cols: 137, rows: 43 });
  await frame({ type: "output", data: "snapshot" });
  expect(state.events).toEqual(["resize:137:43", "write:snapshot"]);
  expect(state.sockets[0].sent).toEqual([]);
  await frame({ type: "output", data: '{"type":"geometry","cols":1,"rows":1}' });
  expect(state.terms[0].cols).toBe(137); // native JSON output is never a control frame
});

it("refits actual native dimensions and preserves the browser viewport when native geometry changes", async () => {
  const mounted = render(<FocusedTerminal sessionName="fixture" fit="width" />);
  const wrapper = mounted.getByTestId("focused-terminal-fit-fixture");
  // Wide enough that both native grids fit above the readable font floor.
  Object.defineProperty(wrapper, "clientWidth", { value: 1200 });
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  await frame({ type: "geometry", cols: 137, rows: 43 });
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  expect(state.terms[0].options.fontSize).toBeCloseTo(12 * 1200 / 1370);
  const viewport = mounted.getByTestId("focused-terminal-fixture");
  viewport.scrollTop = 31; viewport.scrollLeft = 17;
  wrapper.scrollTop = 23; wrapper.scrollLeft = 41;
  await frame({ type: "geometry", cols: 155, rows: 37 });
  await frame({ type: "output", data: "resized snapshot" });
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  expect(state.terms[0].options.fontSize).toBeCloseTo(12 * 1200 / 1550);
  expect([viewport.scrollTop, viewport.scrollLeft]).toEqual([31, 17]);
  // The fit wrapper is the actual scroll owner; its offsets survive too.
  expect([wrapper.scrollTop, wrapper.scrollLeft]).toEqual([23, 41]);
  expect(wrapper.getAttribute("data-terminal-overflow")).toBe("fit");
  expect(state.sockets[0].sent).toEqual([]);
});

it("keeps a readable font floor and pans the native grid instead of fitting it to 2px", async () => {
  const mounted = render(<FocusedTerminal sessionName="fixture" fit="width" />);
  const wrapper = mounted.getByTestId("focused-terminal-fit-fixture");
  Object.defineProperty(wrapper, "clientWidth", { value: 300 });
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  await frame({ type: "geometry", cols: 155, rows: 37 });
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  // 12 * 300 / 1550 would be 2.3px; the desktop floor holds instead.
  expect(state.terms[0].options.fontSize).toBe(8);
  expect(state.terms[0].cols).toBe(155);
  expect(state.terms[0].rows).toBe(37);
  expect(wrapper.getAttribute("data-terminal-overflow")).toBe("pan");
  expect(wrapper.getAttribute("aria-label")).toBe("Terminal fixture, native 155 by 37; scroll to pan the full pane");
  expect(wrapper.className).toContain("overflow-auto");
  expect(state.sockets[0].sent).toEqual([]);
});

it("rejects output before geometry and malformed/out-of-bounds geometry rather than showing a fake grid", async () => {
  const mounted = render(<FocusedTerminal sessionName="fixture" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  await frame({ type: "geometry", cols: 0, rows: 27 });
  expect(mounted.container.textContent).toContain("invalid terminal geometry");
  expect(state.events).toEqual([]);
});

it("reports an old raw-stream daemon explicitly and never retries its invalid protocol", async () => {
  const mounted = render(<FocusedTerminal sessionName="fixture" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  await act(async () => state.sockets[0].onmessage?.({ data: "old raw stream" }));
  expect(mounted.container.textContent).toContain("update the daemon and reload");
  await act(async () => state.sockets[0].onclose?.({ code: 1005, reason: "" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(state.sockets).toHaveLength(1);
});

it("reports output before geometry and does not expose a guessed-size mirror", async () => {
  const mounted = render(<FocusedTerminal sessionName="fixture" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(mounted.getByTestId("focused-terminal-fixture").style.visibility).toBe("hidden");
  await frame({ type: "output", data: "unverified snapshot" });
  expect(mounted.container.textContent).toContain("before native geometry");
  expect(state.events).toEqual([]);
});
