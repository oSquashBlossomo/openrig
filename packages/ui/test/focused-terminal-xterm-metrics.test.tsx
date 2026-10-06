// Real @xterm/xterm 6 renderer regression for font-only fitting. No xterm mock:
// the subclass below only records instances so the test can read the buffer.
// Character metrics are deterministic (0.6em wide, 1em high) and frames settle
// on jsdom's real animation-frame timer. The WebSocket is inert; frames are fed
// by the test. jsdom has no layout, so this proves xterm's inline physical
// geometry (screen, scrollbar, helper textarea), not browser scrollHeight.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";

const state = vi.hoisted(() => {
  // xterm samples a canvas context at module load; install the deterministic
  // stub before the module is imported and restore it after the suite.
  const previousGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: () => ({ width: 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  })) as unknown as HTMLCanvasElement["getContext"];
  return { terms: [] as XtermTerminal[], sockets: [] as any[], observers: [] as Array<() => void>, previousGetContext };
});

vi.mock("@xterm/xterm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xterm/xterm")>();
  class RecordedTerminal extends actual.Terminal {
    constructor(options?: ConstructorParameters<typeof actual.Terminal>[0]) {
      super(options);
      state.terms.push(this as unknown as XtermTerminal);
    }
  }
  return { ...actual, Terminal: RecordedTerminal };
});

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";
import { resyncXtermRenderMetrics } from "../src/components/terminal/xterm-render-metrics.js";

const box = { w: 0, h: 0 };
const restore: Array<() => void> = [];

function override<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => (previous ? Object.defineProperty(target, key, previous) : delete (target as Record<string, unknown>)[key]));
}

const px = (value: string | undefined) => Number.parseFloat(value ?? "") || 0;

beforeAll(() => {
  restore.push(() => { HTMLCanvasElement.prototype.getContext = state.previousGetContext; });
  override(HTMLElement.prototype, "offsetWidth", {
    get(this: HTMLElement) {
      if (this.classList.contains("xterm-char-measure-element")) return px(this.style.fontSize) * 0.6 * 32;
      const screen = this.dataset.testid?.startsWith("focused-terminal-") ? this.querySelector<HTMLElement>(".xterm-screen") : null;
      return px(screen ? screen.style.width : this.style.width);
    },
  });
  override(HTMLElement.prototype, "offsetHeight", {
    get(this: HTMLElement) {
      if (this.classList.contains("xterm-char-measure-element")) return px(this.style.fontSize);
      const screen = this.dataset.testid?.startsWith("focused-terminal-") ? this.querySelector<HTMLElement>(".xterm-screen") : null;
      return px(screen ? screen.style.height : this.style.height);
    },
  });
});

afterAll(() => { while (restore.length) restore.pop()!(); });

beforeEach(() => {
  state.terms.length = state.sockets.length = state.observers.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { state.observers.push(this.callback); }
    disconnect() { state.observers.splice(state.observers.indexOf(this.callback), 1); }
    unobserve() {}
  });
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1; readyState = 1; sent: string[] = [];
    onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: (event: { code: number; reason: string }) => void;
    constructor(public url: string) { state.sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 80)));
const frame = (data: unknown) => act(async () => { state.sockets[0].onmessage?.({ data: JSON.stringify(data) }); });
const refit = (w: number, h: number) => act(async () => { box.w = w; box.h = h; for (const callback of [...state.observers]) callback(); });

function physical(host: HTMLElement) {
  const term = state.terms[0]!;
  return {
    font: term.options.fontSize,
    screen: px(host.querySelector<HTMLElement>(".xterm-screen")?.style.height),
    scrollbar: px(host.querySelector<HTMLElement>(".xterm-scrollable-element > .scrollbar.vertical")?.style.height),
    caretTop: px(term.textarea?.style.top),
    caretHeight: px(term.textarea?.style.height),
  };
}

function bufferSnapshot() {
  const buffer = state.terms[0]!.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)!.translateToString(true));
  return { length: buffer.length, baseY: buffer.baseY, viewportY: buffer.viewportY, cursorY: buffer.cursorY, lines };
}

async function mountAt155x37Font17() {
  const mounted = render(<FocusedTerminal sessionName="fixture" fit="contain" />);
  const wrapper = mounted.getByTestId("focused-terminal-fit-fixture");
  Object.defineProperty(wrapper, "clientWidth", { configurable: true, get: () => box.w });
  Object.defineProperty(wrapper, "clientHeight", { configurable: true, get: () => box.h });
  // Not laid out until native geometry arrives, so natural size is measured at
  // the 12px base: 155x37 is 444px high. The height-limited box then contains
  // it at exactly 17px (37 x 17 = 629); width is deliberately not the limit.
  box.w = 0; box.h = 0;
  await settle();
  await frame({ type: "geometry", cols: 155, rows: 37 });
  await settle();
  await refit(3000, 629);
  await settle();
  // Genuine native history: 60 lines scroll the buffer, then the prompt repaints.
  const history = Array.from({ length: 60 }, (_, i) => `fixture history ${String(i).padStart(2, "0")}`).join("\r\n");
  await frame({ type: "output", data: `${history}\r\n\x1b[37;1Hfixture prompt> ` });
  await settle();
  return { mounted, host: mounted.getByTestId("focused-terminal-fixture"), wrapper };
}

it("uses current physical metrics after a font-only fit from 17px to 8px at native 155x37, with history intact", async () => {
  const { host } = await mountAt155x37Font17();
  expect(state.terms[0]!.cols).toBe(155);
  expect(state.terms[0]!.rows).toBe(37);
  expect(physical(host)).toMatchObject({ font: 17, screen: 629, scrollbar: 629, caretTop: 36 * 17 });
  const before = bufferSnapshot();
  expect(before.baseY).toBeGreaterThan(0);
  expect(before.lines).toContain("fixture history 00");

  await refit(3000, 296);
  await settle();

  expect(physical(host)).toEqual({ font: 8, screen: 296, scrollbar: 296, caretTop: 36 * 8, caretHeight: 8 });
  // Logical scrollback is untouched: same lines, rows, base and live position.
  expect(bufferSnapshot()).toEqual(before);
  expect(state.terms[0]!.cols).toBe(155);
  expect(state.terms[0]!.rows).toBe(37);

  // Ordinary prompt output keeps the corrected metrics.
  await frame({ type: "output", data: "\x1b[37;17Hok" });
  await settle();
  expect(physical(host)).toMatchObject({ font: 8, screen: 296, scrollbar: 296, caretTop: 36 * 8 });
  expect(bufferSnapshot().lines.slice(0, before.baseY)).toEqual(before.lines.slice(0, before.baseY));

  // Browser fitting never asks the shared native pane to resize or repaint.
  expect(state.sockets[0].sent).toEqual([]);
  expect(host.style.transform).toBe("");
});

it("keeps a locally scrolled-back line in place while the scrollbar adopts the new cell height", async () => {
  const { host } = await mountAt155x37Font17();
  await act(async () => { state.terms[0]!.scrollLines(-5); });
  await settle();
  const before = bufferSnapshot();
  expect(before.viewportY).toBe(before.baseY - 5);

  await refit(3000, 296);
  await settle();

  expect(bufferSnapshot()).toEqual(before);
  expect(physical(host)).toMatchObject({ font: 8, screen: 296, scrollbar: 296 });
  // Slider height is proportional to the new visible/scroll height, not the old one.
  const slider = px(host.querySelector<HTMLElement>(".scrollbar.vertical > .slider")?.style.height);
  expect(Math.abs(slider - 296 * 296 / (before.length * 8))).toBeLessThanOrEqual(1);
});

it("detects the installed xterm's sync routines (upgrade tripwire) and stops syncing after unmount", async () => {
  const { mounted } = await mountAt155x37Font17();
  const term = state.terms[0]!;
  expect(resyncXtermRenderMetrics(term)).toBe(true);
  await refit(3000, 296);
  mounted.unmount();
  await settle();
  expect(state.sockets[0].readyState).toBe(3);
  expect(state.observers).toHaveLength(0);
});

// Bidirectional and repeated refits. A height-limited box of 37 x font px fits
// native 155x37 at exactly that font (the width is never the limit here).
const FONT_CYCLE = [8, 17, 24, 10, 17, 8, 17];
const boxHeightFor = (font: number) => 37 * font;

/** Every logical scroll xterm reports while refitting; must stay empty. */
function recordLogicalScrolls() {
  const events: number[] = [];
  const subscription = state.terms[0]!.onScroll((ydisp) => events.push(ydisp));
  return { events, dispose: () => subscription.dispose() };
}

function sliderMatchesLine(host: HTMLElement, viewportY: number, length: number, cell: number) {
  const bar = px(host.querySelector<HTMLElement>(".scrollbar.vertical")?.style.height);
  const slider = host.querySelector<HTMLElement>(".scrollbar.vertical > .slider")!;
  const sliderHeight = px(slider.style.height);
  const scrollHeight = length * cell;
  const expectedTop = (viewportY * cell) * (bar - sliderHeight) / (scrollHeight - bar);
  return Math.abs(px(slider.style.top) - expectedTop) <= 1;
}

it("preserves the live logical viewport, bytes and physical metrics across repeated shrink/grow refits", async () => {
  const { host } = await mountAt155x37Font17();
  const before = bufferSnapshot();
  expect(before.viewportY).toBe(before.baseY);
  const scrolls = recordLogicalScrolls();
  for (const font of FONT_CYCLE) {
    await refit(3000, boxHeightFor(font));
    await settle();
    expect({ font, ...bufferSnapshot() }).toEqual({ font, ...before });
    expect(physical(host)).toEqual({ font, screen: 37 * font, scrollbar: 37 * font, caretTop: 36 * font, caretHeight: font });
    expect(sliderMatchesLine(host, before.viewportY, before.length, font)).toBe(true);
  }
  scrolls.dispose();
  expect(scrolls.events).toEqual([]);
  expect(state.terms[0]!.cols).toBe(155);
  expect(state.terms[0]!.rows).toBe(37);
  expect(state.sockets[0].sent).toEqual([]);
});

it("preserves a scrolled-back history line and its scroll position across repeated shrink/grow refits", async () => {
  const { host } = await mountAt155x37Font17();
  await act(async () => { state.terms[0]!.scrollLines(-5); });
  await settle();
  const before = bufferSnapshot();
  expect(before.viewportY).toBe(before.baseY - 5);
  const scrolls = recordLogicalScrolls();
  for (const font of FONT_CYCLE) {
    await refit(3000, boxHeightFor(font));
    await settle();
    expect({ font, ...bufferSnapshot() }).toEqual({ font, ...before });
    expect(physical(host)).toMatchObject({ font, screen: 37 * font, scrollbar: 37 * font });
    expect(sliderMatchesLine(host, before.viewportY, before.length, font)).toBe(true);
  }
  scrolls.dispose();
  expect(scrolls.events).toEqual([]);
  expect(state.sockets[0].sent).toEqual([]);
});

it("preserves position when refits arrive back to back before a frame renders", async () => {
  const { host } = await mountAt155x37Font17();
  await act(async () => { state.terms[0]!.scrollLines(-3); });
  await settle();
  const before = bufferSnapshot();
  const scrolls = recordLogicalScrolls();
  await refit(3000, boxHeightFor(8));
  await refit(3000, boxHeightFor(24));
  await refit(3000, boxHeightFor(10));
  await settle();
  expect(bufferSnapshot()).toEqual(before);
  expect(physical(host)).toMatchObject({ font: 10, screen: 370, scrollbar: 370 });
  expect(sliderMatchesLine(host, before.viewportY, before.length, 10)).toBe(true);
  scrolls.dispose();
  expect(scrolls.events).toEqual([]);
});
