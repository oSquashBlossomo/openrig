// FocusedTerminal on a phone: the software keyboard and the clipboard.
//
// Keyboard: when the focused terminal is covered by a software keyboard (the
// visual viewport is materially shorter than the layout viewport), the
// terminal fits itself into the visible band and the page scrolls it there.
// Only the focused viewer reacts; the native pane is never resized.
//
// Clipboard: Copy and Paste are explicit taps. Copy writes the selection (or
// the visible screen); Paste reads once and sends one literal text frame with
// no Enter. Where the Clipboard API is missing or refused, a text box is the
// fallback. A late clipboard read is dropped after a session switch,
// reconnect or unmount. xterm, the socket and the viewport are fakes here;
// real Safari behaviour needs a device check.

import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";

const s = vi.hoisted(() => ({
  sockets: [] as any[],
  terms: [] as Array<{ textarea: HTMLTextAreaElement; selection: string; lines: string[]; focus(): void }>,
  wheel: null as ((ev: { deltaY: number }) => boolean) | null,
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = { fontSize: 12 }; cols = 90; rows = 4;
  textarea!: HTMLTextAreaElement;
  selection = "";
  lines: string[] = [];
  buffer = { active: { viewportY: 0, getLine: (y: number) => (y < this.lines.length ? { translateToString: () => this.lines[y] } : undefined) } };
  open(el: HTMLElement) {
    this.textarea = document.createElement("textarea");
    this.textarea.className = "xterm-helper-textarea";
    el.appendChild(this.textarea);
    s.terms.push(this);
  }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  write(_d: string, done?: () => void) { done?.(); }
  focus() { this.textarea.focus(); }
  hasSelection() { return this.selection !== ""; }
  getSelection() { return this.selection; }
  dispose() {} scrollToBottom() {}
  onData() {}
  attachCustomWheelEventHandler(handler: (ev: { deltaY: number }) => boolean) { s.wheel = handler; }
} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

class FakeVisualViewport extends EventTarget {
  width = 390; height = 844; offsetTop = 0; offsetLeft = 0; scale = 1;
  listeners = 0;
  addEventListener(...args: Parameters<EventTarget["addEventListener"]>) { this.listeners++; super.addEventListener(...args); }
  removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) { this.listeners--; super.removeEventListener(...args); }
  set(next: Partial<Pick<FakeVisualViewport, "width" | "height" | "offsetTop" | "scale">>) { Object.assign(this, next); this.dispatchEvent(new Event("resize")); }
  /** Offset-only movement (Safari panning the visual viewport): no resize. */
  pan(offsetTop: number) { this.offsetTop = offsetTop; this.dispatchEvent(new Event("scroll")); }
}

let vv: FakeVisualViewport;
const setLayoutHeight = (h: number) => Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: h });

beforeEach(() => {
  s.sockets.length = 0;
  s.terms.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1; readyState = 0; sent: string[] = [];
    onopen?: () => void; onmessage?: (e: any) => void; onclose?: (e: any) => void;
    constructor(public url: string) { s.sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  });
  vv = new FakeVisualViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  setLayoutHeight(844);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as any).visualViewport;
  delete (navigator as any).clipboard;
});

const open = (w: any) => act(() => { w.readyState = 1; w.onopen?.(); });
const ready = (w: any) => { open(w); act(() => w.onmessage?.({ data: JSON.stringify({ type: "geometry", cols: 90, rows: 4 }) })); };
const frames = (w: any) => w.sent.map((f: string) => JSON.parse(f));
// Enough animation frames for the band to settle: measure, then fit passes
// (scroll, cap, lift). Separate acts so each commit's effects run between.
const frame = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20); });
};
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const tools = (view: ReturnType<typeof render>, session = "fixture") => within(view.getByRole("group", { name: `Terminal input for ${session}` }));
const setClipboard = (clipboard: Partial<Clipboard> | undefined) => Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 390, width: 390, height, x: 0, y: top, toJSON() {} }) as DOMRect;

// ---------------------------------------------------------------------------
// Software keyboard
// ---------------------------------------------------------------------------

/** Layout model: an optional scrolling page (`scrollHeight`, clamped
 *  scrollTop) and/or a fixed clipping box around the terminal's input area.
 *  The area sits `base` below the page top and is `natural` tall unless its
 *  max-height caps it; a relative `top` lifts it. */
function layout(root: HTMLElement, opts: { base: number; natural: number; page?: HTMLElement; scrollHeight?: number; clip?: { el: HTMLElement; top: number; height: number } }) {
  let top = 0;
  const writes: number[] = [];
  const { page: pageEl, scrollHeight = 4000 } = opts;
  if (pageEl) {
    Object.defineProperty(pageEl, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(pageEl, "clientHeight", { configurable: true, get: () => window.innerHeight });
    Object.defineProperty(pageEl, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = Math.min(Math.max(0, v), scrollHeight - window.innerHeight); writes.push(top); } });
    pageEl.getBoundingClientRect = () => rect(0, window.innerHeight);
  }
  if (opts.clip) {
    const { el, top: clipTop, height } = opts.clip;
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => height });
    el.getBoundingClientRect = () => rect(clipTop, height);
  }
  root.getBoundingClientRect = () => {
    const cap = Number.parseFloat(root.style.maxHeight);
    const lift = -(Number.parseFloat(root.style.top) || 0);
    return rect(opts.base - top - lift, Number.isFinite(cap) ? Math.min(opts.natural, cap) : opts.natural);
  };
  return { writes, rect: () => root.getBoundingClientRect() };
}

const inputArea = (view: ReturnType<typeof render>, session = "fixture") => view.getByTestId(`focused-terminal-input-area-${session}`);

function mountInPage(session = "fixture", fit: "width" | "contain" = "contain") {
  const view = render(<div data-testid="page" style={{ overflowY: "auto" }}><FocusedTerminal sessionName={session} fit={fit} autoFocus={false} /></div>);
  ready(s.sockets.at(-1));
  return { view, root: inputArea(view, session), pageEl: view.getByTestId("page") };
}

it("portrait: a keyboard covering the focused terminal fits it into the visible band and scrolls it above the keyboard", async () => {
  const { root, pageEl } = mountInPage();
  const p = layout(root, { page: pageEl, base: 600, natural: 400 });
  act(() => { s.terms[0]!.focus(); });
  act(() => { vv.set({ height: 450 }); });
  await frame();
  expect(root.style.maxHeight).toBe("450px");
  expect(p.rect().bottom).toBe(450);
  expect(p.rect().top).toBeGreaterThanOrEqual(0);
  expect(s.sockets[0].sent).toEqual([]);
});

it("landscape: a short, offset visual viewport caps the terminal to the band and reveals it there", async () => {
  setLayoutHeight(390);
  vv.set({ width: 844, height: 390 });
  const { root, pageEl } = mountInPage("fixture", "width");
  const p = layout(root, { page: pageEl, base: 200, natural: 300 });
  act(() => { s.terms[0]!.focus(); });
  act(() => { vv.offsetTop = 40; vv.set({ height: 150 }); });
  await frame();
  expect(root.style.maxHeight).toBe("150px");
  expect(p.rect().top).toBe(40);
  expect(p.rect().bottom).toBe(190);
});

it("rotation re-fits to the new band; hiding the keyboard or blurring restores the layout without scrolling again", async () => {
  const { root, pageEl } = mountInPage();
  const p = layout(root, { page: pageEl, base: 600, natural: 400 });
  act(() => { s.terms[0]!.focus(); });
  act(() => { vv.set({ height: 450 }); });
  await frame();
  expect(root.style.maxHeight).toBe("450px");

  // Rotate to landscape with the keyboard still up.
  setLayoutHeight(390);
  act(() => { vv.set({ width: 844, height: 160 }); });
  await frame();
  expect(root.style.maxHeight).toBe("160px");
  expect(p.rect().bottom).toBeLessThanOrEqual(160);
  expect(p.rect().top).toBeGreaterThanOrEqual(0);

  // Keyboard hidden: no cap or lift, and the page is not scrolled again.
  const writes = p.writes.length;
  act(() => { vv.set({ height: 390 }); });
  await frame();
  expect(root.style.maxHeight).toBe("");
  expect(root.style.top).toBe("");
  expect(p.writes.length).toBe(writes);

  // Keyboard back, then focus leaves the terminal.
  act(() => { vv.set({ height: 160 }); });
  await frame();
  expect(root.style.maxHeight).toBe("160px");
  act(() => { s.terms[0]!.textarea.blur(); });
  await frame();
  expect(root.style.maxHeight).toBe("");
});

it("at the end of a page with no scroll room left, lifts the input area above the keyboard instead of leaving it covered", async () => {
  const { root, pageEl } = mountInPage();
  // 156px of scroll room; the area needs 650px.
  const p = layout(root, { page: pageEl, base: 800, natural: 300, scrollHeight: 1000 });
  act(() => { s.terms[0]!.focus(); });
  act(() => { vv.set({ height: 450 }); });
  await frame();
  expect(pageEl.scrollTop).toBe(156);
  expect(p.rect().top).toBeGreaterThanOrEqual(0);
  expect(p.rect().bottom).toBeLessThanOrEqual(450);
  expect(root.style.position).toBe("relative");

  act(() => { vv.set({ height: 844 }); });
  await frame();
  expect(root.style.top).toBe("");
  expect(root.style.position).toBe("");
});

it("follows offset-only visual viewport movement (Safari focus pan) without snapping a history reader's scroll position", async () => {
  const { view, root, pageEl } = mountInPage();
  const p = layout(root, { page: pageEl, base: 600, natural: 400 });
  const wrapper = view.getByTestId("focused-terminal-fit-fixture");
  const wrapperWrites: number[] = [];
  let wrapperTop = 0;
  Object.defineProperty(wrapper, "scrollTop", { configurable: true, get: () => wrapperTop, set: (v: number) => { wrapperTop = v; wrapperWrites.push(v); } });
  act(() => { s.terms[0]!.focus(); });
  act(() => { vv.set({ height: 450 }); });
  await frame();
  // The new band revealed the prompt row inside the terminal once.
  expect(wrapperWrites.length).toBeGreaterThan(0);

  // The user pans the terminal to read part of the pane.
  act(() => { wrapper.scrollTop = 77; });
  wrapperWrites.length = 0;

  // Safari pans the visual viewport: no resize, only scroll/offsetTop.
  act(() => { vv.pan(200); });
  await frame();
  expect(p.rect().top).toBeGreaterThanOrEqual(200);
  expect(p.rect().bottom).toBeLessThanOrEqual(650);
  expect(wrapperWrites).toEqual([]);
  expect(wrapper.scrollTop).toBe(77);

  // The user reads server history.
  act(() => { s.wheel!({ deltaY: -1 }); });

  // Even a new band height does not snap a history reader to the prompt.
  setLayoutHeight(390);
  act(() => { vv.offsetTop = 0; vv.set({ width: 844, height: 160 }); });
  await frame();
  expect(wrapperWrites).toEqual([]);
  expect(frames(s.sockets[0])).toEqual([{ type: "scroll", offset: 3 }]);
});

it("natural mode in a fixed clipping popover: the native rows pan inside a bounded area and the toolbar stays in a short landscape band", async () => {
  setLayoutHeight(390);
  vv.set({ width: 844, height: 390 });
  const view = render(
    // Longhands: jsdom does not expand the overflow shorthand.
    <div data-testid="pop" style={{ position: "fixed", overflowX: "hidden", overflowY: "hidden" }}>
      <FocusedTerminal sessionName="fixture" autoFocus={false} />
    </div>,
  );
  ready(s.sockets[0]);
  const root = inputArea(view);
  const host = view.getByTestId("focused-terminal-fixture");
  const naturalArea = host.parentElement!;
  // Desktop / no keyboard: plain natural layout, nothing bounded.
  expect(root.getAttribute("style")).toBeNull();
  expect(naturalArea.getAttribute("style")).toBeNull();

  // Popover box 20..380 (clipped); the area sits 6px inside, 340px tall.
  const p = layout(root, { base: 26, natural: 340, clip: { el: view.getByTestId("pop"), top: 20, height: 360 } });
  act(() => { s.terms[0]!.focus(); });
  act(() => { vv.set({ height: 150 }); });
  await frame();
  expect(p.rect().top).toBeGreaterThanOrEqual(20);
  expect(p.rect().bottom).toBeLessThanOrEqual(150);
  expect(naturalArea.style.overflow).toBe("auto");
  expect(root.contains(view.getByRole("group", { name: "Terminal keys for fixture" }))).toBe(true);
  // Native geometry and the pane are untouched.
  expect(host.style.maxHeight).toBe("");
  expect((s.terms[0] as unknown as { cols: number; rows: number }).cols).toBe(90);
  expect(s.sockets[0].sent).toEqual([]);
});

it("keeps the keyboard protection while the clipboard fallback box is focused, so Send stays reachable; a sibling viewer does not react", async () => {
  setClipboard({ readText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) });
  const view = render(
    <div data-testid="page" style={{ overflowY: "auto" }}>
      <FocusedTerminal sessionName="fixture" fit="contain" autoFocus={false} />
      <FocusedTerminal sessionName="other" fit="contain" autoFocus={false} />
    </div>,
  );
  ready(s.sockets[0]);
  ready(s.sockets[1]);
  const root = inputArea(view);
  const p = layout(root, { page: view.getByTestId("page"), base: 600, natural: 400 });
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  await flush();
  const box = view.getByRole("textbox", { name: /text to paste/i }) as HTMLTextAreaElement;

  act(() => { box.focus(); });
  act(() => { vv.set({ height: 450 }); });
  await frame();
  expect(root.style.maxHeight).toBe("450px");
  expect(p.rect().bottom).toBeLessThanOrEqual(450);
  expect(p.rect().top).toBeGreaterThanOrEqual(0);
  const send = view.getByRole("button", { name: /send paste/i });
  expect(root.contains(send)).toBe(true);
  expect(inputArea(view, "other").style.maxHeight).toBe("");
  expect(tools(view).getByRole("button", { name: /hide keyboard/i })).toBeTruthy();

  fireEvent.change(box, { target: { value: "ünïcode\nline" } });
  fireEvent.click(send);
  expect(frames(s.sockets[0])).toEqual([{ type: "text", text: "ünïcode\nline" }]);
  expect(s.sockets[1].sent).toEqual([]);
});

it("Keyboard shows and hides: a tap focuses the terminal input, the next tap dismisses it; no bytes, no reconnect", async () => {
  const view = render(<FocusedTerminal sessionName="fixture" fit="contain" autoFocus={false} />);
  ready(s.sockets[0]);
  const show = tools(view).getByRole("button", { name: "Show keyboard" });
  expect(fireEvent.mouseDown(show)).toBe(false);
  fireEvent.click(show);
  expect(document.activeElement).toBe(s.terms[0]!.textarea);
  await frame();
  const hide = tools(view).getByRole("button", { name: "Hide keyboard" });
  fireEvent.click(hide);
  expect(document.activeElement).not.toBe(s.terms[0]!.textarea);
  await frame();
  expect(tools(view).getByRole("button", { name: "Show keyboard" })).toBeTruthy();
  expect(s.sockets).toHaveLength(1);
  expect(s.sockets[0].sent).toEqual([]);
});

// autoFocus focuses xterm while mounting, before the viewport/focus listeners
// attach: the initial measurement must still see the focus and an already
// open keyboard, with no later focus or resize event to prompt it.
it("autoFocus under an already-open keyboard is measured on mount: capped, offers Hide, and Hide blurs without input", async () => {
  vv.height = 450;
  const view = render(<div data-testid="page" style={{ overflowY: "auto" }}><FocusedTerminal sessionName="fixture" fit="contain" /></div>);
  ready(s.sockets[0]);
  const root = inputArea(view);
  layout(root, { page: view.getByTestId("page"), base: 600, natural: 400 });
  expect(document.activeElement).toBe(s.terms[0]!.textarea);
  await frame();
  expect(root.style.maxHeight).toBe("450px");
  fireEvent.click(tools(view).getByRole("button", { name: "Hide keyboard" }));
  expect(document.activeElement).not.toBe(s.terms[0]!.textarea);
  await frame();
  expect(root.style.maxHeight).toBe("");
  expect(tools(view).getByRole("button", { name: "Show keyboard" })).toBeTruthy();
  expect(s.sockets).toHaveLength(1);
  expect(s.sockets[0].sent).toEqual([]);
});

it("leaves an unfocused viewer alone, and does nothing without keyboard occlusion (desktop, pinch zoom)", async () => {
  const view = render(
    <div data-testid="page" style={{ overflowY: "auto" }}>
      <FocusedTerminal sessionName="a" fit="contain" autoFocus={false} />
      <FocusedTerminal sessionName="b" fit="contain" autoFocus={false} />
    </div>,
  );
  ready(s.sockets[0]);
  ready(s.sockets[1]);
  const rootA = inputArea(view, "a");
  const rootB = inputArea(view, "b");
  const p = layout(rootA, { page: view.getByTestId("page"), base: 600, natural: 400 });

  // Desktop: focusing never scrolls or caps.
  act(() => { s.terms[0]!.focus(); });
  await frame();
  expect(rootA.style.maxHeight).toBe("");
  expect(p.writes).toEqual([]);

  // Pinch zoom shrinks the visual viewport without a keyboard.
  act(() => { vv.set({ height: 422, scale: 2 }); });
  await frame();
  expect(rootA.style.maxHeight).toBe("");
  expect(p.writes).toEqual([]);

  act(() => { vv.set({ height: 450, scale: 1 }); });
  await frame();
  expect(rootA.style.maxHeight).toBe("450px");
  expect(rootB.style.maxHeight).toBe("");
});

it("removes its viewport listeners (resize and scroll) and pending frames on unmount and session change", async () => {
  const { view } = mountInPage("a");
  const attached = vv.listeners;
  expect(attached).toBe(2);
  view.rerender(<div data-testid="page"><FocusedTerminal sessionName="b" fit="contain" autoFocus={false} /></div>);
  expect(vv.listeners).toBe(attached);
  act(() => { s.terms.at(-1)!.focus(); });
  act(() => { vv.set({ height: 450 }); });
  view.unmount();
  expect(vv.listeners).toBe(0);
  await frame();
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

it("Copy writes the xterm selection exactly once on tap and never touches the clipboard otherwise", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const readText = vi.fn();
  setClipboard({ writeText, readText });
  const view = render(<FocusedTerminal sessionName="fixture" fit="width" />);
  ready(s.sockets[0]);
  act(() => s.sockets[0].onmessage?.({ data: JSON.stringify({ type: "output", data: "out" }) }));
  expect(writeText).not.toHaveBeenCalled();
  expect(readText).not.toHaveBeenCalled();

  s.terms[0]!.selection = "naïve ✓\nline two";
  const copy = tools(view).getByRole("button", { name: /^copy/i });
  expect(fireEvent.mouseDown(copy)).toBe(false);
  fireEvent.click(copy);
  await flush();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith("naïve ✓\nline two");
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).toMatch(/copied the selection/i);
  expect(readText).not.toHaveBeenCalled();
  expect(s.sockets[0].sent).toEqual([]);
});

it("Copy without a selection copies the visible screen, trimming trailing blank rows", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  setClipboard({ writeText });
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  s.terms[0]!.lines = ["$ echo hi", "hi", "$", ""];
  fireEvent.click(tools(view).getByRole("button", { name: /^copy/i }));
  await flush();
  expect(writeText).toHaveBeenCalledWith("$ echo hi\nhi\n$");
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).toMatch(/copied the visible screen/i);
});

it.each([
  ["refused", () => setClipboard({ writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) })],
  ["unavailable", () => setClipboard(undefined)],
])("Copy %s: shows the text selected in a box for the device's own Copy, and says so", async (_case, setup) => {
  setup();
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  s.terms[0]!.selection = "secret-free text";
  fireEvent.click(tools(view).getByRole("button", { name: /^copy/i }));
  await flush();
  const box = view.getByRole("textbox", { name: /text to copy/i }) as HTMLTextAreaElement;
  expect(box.value).toBe("secret-free text");
  expect(box.readOnly).toBe(true);
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).toMatch(/not copied/i);
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).not.toMatch(/copied the/i);
  fireEvent.click(view.getByRole("button", { name: /close/i }));
  expect(view.queryByRole("textbox", { name: /text to copy/i })).toBeNull();
});

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

it("Paste reads once on tap and sends one literal text frame: Unicode and line breaks kept, no Enter", async () => {
  const readText = vi.fn().mockResolvedValue("héllo\r\nwörld 👋\nend");
  setClipboard({ readText });
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  expect(readText).not.toHaveBeenCalled();
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  await flush();
  expect(readText).toHaveBeenCalledTimes(1);
  expect(frames(s.sockets[0])).toEqual([{ type: "text", text: "héllo\nwörld 👋\nend" }]);
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).toMatch(/pasted.*not submitted/i);
});

it.each([
  ["refused", () => setClipboard({ readText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) })],
  ["unavailable", () => setClipboard(undefined)],
])("Paste %s: a paste box sends its text once, literally, on Send", async (_case, setup) => {
  setup();
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  await flush();
  expect(s.sockets[0].sent).toEqual([]);
  const box = view.getByRole("textbox", { name: /text to paste/i });
  fireEvent.change(box, { target: { value: "a\r\nb ✓" } });
  fireEvent.click(view.getByRole("button", { name: /send paste/i }));
  expect(frames(s.sockets[0])).toEqual([{ type: "text", text: "a\nb ✓" }]);
  expect(view.queryByRole("textbox", { name: /text to paste/i })).toBeNull();
});

it("Paste over the input limit is refused visibly and sends nothing", async () => {
  setClipboard({ readText: vi.fn().mockResolvedValue("x".repeat(256 * 1024)) });
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  await flush();
  expect(s.sockets[0].sent).toEqual([]);
  expect(view.getByTestId("focused-terminal-input-warning-fixture").textContent).toMatch(/256 KiB/);
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).not.toMatch(/pasted/i);
});

function deferredClipboard() {
  let resolve!: (text: string) => void;
  setClipboard({ readText: vi.fn(() => new Promise<string>((r) => { resolve = r; })) });
  return (text: string) => act(async () => { resolve(text); await Promise.resolve(); await Promise.resolve(); });
}

it("drops a late clipboard result after a session switch: neither seat receives it", async () => {
  const answer = deferredClipboard();
  const view = render(<FocusedTerminal sessionName="a" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view, "a").getByRole("button", { name: /^paste/i }));
  view.rerender(<FocusedTerminal sessionName="b" />);
  ready(s.sockets[1]);
  await answer("late");
  expect(s.sockets[0].sent).toEqual([]);
  expect(s.sockets[1].sent).toEqual([]);
});

it("drops a late clipboard result after a reconnect, and never replays it", async () => {
  const answer = deferredClipboard();
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  act(() => { s.sockets[0].readyState = 3; s.sockets[0].onclose?.({ code: 1006, reason: "" }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  ready(s.sockets[1]);
  await answer("late");
  expect(s.sockets.flatMap((w) => w.sent)).toEqual([]);
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).toMatch(/discarded/i);
});

it("drops a late clipboard result after unmount", async () => {
  const answer = deferredClipboard();
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  view.unmount();
  await answer("late");
  expect(s.sockets[0].sent).toEqual([]);
});

// A clipboard completion that is no longer the latest clipboard intent (a
// newer operation, a draft, a session switch) changes nothing, not even UI.
const typeDraft = (view: ReturnType<typeof render>, text: string) => fireEvent.change(view.getByRole("textbox", { name: /text to paste/i }), { target: { value: text } });
const draft = (view: ReturnType<typeof render>) => (view.getByRole("textbox", { name: /text to paste/i }) as HTMLTextAreaElement).value;

it("a late paste read from seat A does not replace seat B's fallback draft", async () => {
  const answer = deferredClipboard();
  const view = render(<FocusedTerminal sessionName="a" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view, "a").getByRole("button", { name: /^paste/i }));
  view.rerender(<FocusedTerminal sessionName="b" />);
  ready(s.sockets[1]);
  setClipboard({ readText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) });
  fireEvent.click(tools(view, "b").getByRole("button", { name: /^paste/i }));
  await flush();
  typeDraft(view, "b draft ✓");
  await answer("late from a");
  expect(draft(view)).toBe("b draft ✓");
  expect(view.getByTestId("focused-terminal-clipboard-b").textContent).not.toMatch(/discarded/i);
  expect(s.sockets.flatMap((w) => w.sent)).toEqual([]);
});

it("switching away supersedes a pending paste: returning to the seat shows no stale outcome and sends nothing", async () => {
  const answer = deferredClipboard();
  const view = render(<FocusedTerminal sessionName="a" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view, "a").getByRole("button", { name: /^paste/i }));
  view.rerender(<FocusedTerminal sessionName="b" />);
  ready(s.sockets[1]);
  view.rerender(<FocusedTerminal sessionName="a" />);
  ready(s.sockets[2]);
  await answer("late");
  expect(view.queryByTestId("focused-terminal-clipboard-a")).toBeNull();
  expect(s.sockets.flatMap((w) => w.sent)).toEqual([]);
});

it("after a reconnect, a late paste read neither sends nor replaces a newer fallback draft", async () => {
  const answer = deferredClipboard();
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  act(() => { s.sockets[0].readyState = 3; s.sockets[0].onclose?.({ code: 1006, reason: "" }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  ready(s.sockets[1]);
  setClipboard(undefined);
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  typeDraft(view, "newer\ndraft");
  await answer("late");
  expect(draft(view)).toBe("newer\ndraft");
  expect(s.sockets.flatMap((w) => w.sent)).toEqual([]);
});

it.each([
  ["fulfils", (d: { resolve(): void; reject(e: unknown): void }) => d.resolve()],
  ["rejects", (d: { resolve(): void; reject(e: unknown): void }) => d.reject(new DOMException("denied", "NotAllowedError"))],
])("a delayed Copy that %s after a newer fallback draft edit leaves the draft and notice alone", async (_case, settle) => {
  let pending!: { resolve(): void; reject(e: unknown): void };
  setClipboard({ writeText: vi.fn(() => new Promise<void>((resolve, reject) => { pending = { resolve, reject }; })) });
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  s.terms[0]!.selection = "old selection";
  // Paste fallback open (no readText), then Copy pending, then the draft.
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  fireEvent.click(tools(view).getByRole("button", { name: /^copy/i }));
  typeDraft(view, "keep me");
  await act(async () => { settle(pending); await Promise.resolve(); await Promise.resolve(); });
  expect(draft(view)).toBe("keep me");
  expect(view.queryByRole("textbox", { name: /text to copy/i })).toBeNull();
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).not.toMatch(/copied/i);
  expect(s.sockets[0].sent).toEqual([]);
});

it("a refused fallback Send keeps the exact draft and the limit warning; a smaller edit then sends once", async () => {
  setClipboard(undefined);
  const view = render(<FocusedTerminal sessionName="fixture" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view).getByRole("button", { name: /^paste/i }));
  // 4-byte characters over the 256 KiB encoded limit, with line breaks (LF:
  // a textarea value never holds CR).
  const oversized = `${"😀".repeat(66 * 1024)}\nlast ✓`;
  typeDraft(view, oversized);
  fireEvent.click(view.getByRole("button", { name: /send paste/i }));
  expect(s.sockets[0].sent).toEqual([]);
  expect(draft(view)).toBe(oversized);
  expect(view.getByTestId("focused-terminal-input-warning-fixture").textContent).toMatch(/256 KiB/);
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).toMatch(/not sent/i);

  typeDraft(view, "smaller ✓\nline");
  fireEvent.click(view.getByRole("button", { name: /send paste/i }));
  expect(frames(s.sockets[0])).toEqual([{ type: "text", text: "smaller ✓\nline" }]);
  expect(view.queryByRole("textbox", { name: /text to paste/i })).toBeNull();
});

it("clears a paste box when the session changes", async () => {
  setClipboard(undefined);
  const view = render(<FocusedTerminal sessionName="a" />);
  ready(s.sockets[0]);
  fireEvent.click(tools(view, "a").getByRole("button", { name: /^paste/i }));
  fireEvent.change(view.getByRole("textbox", { name: /text to paste/i }), { target: { value: "for a" } });
  view.rerender(<FocusedTerminal sessionName="b" />);
  ready(s.sockets[1]);
  expect(view.queryByRole("textbox", { name: /text to paste/i })).toBeNull();
});
