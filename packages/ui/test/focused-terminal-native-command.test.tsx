// FocusedTerminal: a native command handed over from Chat. The command is
// shown in a local box only; nothing reaches the terminal until the operator
// taps Paste command, which runs the owner's fresh check first and then sends
// one literal text frame without Enter. Mounting, connecting, reconnecting
// and remounting send nothing. xterm and the socket are fakes; this proves the
// viewer's input rules, not tmux or any native CLI's command handling.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const s = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = { fontSize: 12 }; cols = 90; rows = 4;
  buffer = { active: { viewportY: 0, getLine: () => undefined } };
  open(el: HTMLElement) { el.appendChild(document.createElement("textarea")); }
  resize() {} write(_d: string, done?: () => void) { done?.(); }
  focus() {} hasSelection() { return false; } getSelection() { return ""; }
  dispose() {} scrollToBottom() {} onData() {} attachCustomWheelEventHandler() {}
} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { FocusedTerminal, type StagedCommand } from "../src/components/terminal/FocusedTerminal.js";

beforeEach(() => {
  s.sockets.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1; readyState = 0; sent: string[] = [];
    onopen?: () => void; onmessage?: (e: any) => void; onclose?: (e: any) => void;
    constructor(public url: string) { s.sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ready = (w: any) => {
  act(() => { w.readyState = 1; w.onopen?.(); });
  act(() => w.onmessage?.({ data: JSON.stringify({ type: "geometry", cols: 90, rows: 4 }) }));
};
const frames = (w: any) => w.sent.map((f: string) => JSON.parse(f));
const allFrames = () => s.sockets.flatMap(frames);
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const TEXT = "/my-plugin:review résumé ✓ --deep";
function staged(over: Partial<StagedCommand> = {}): StagedCommand {
  return { id: "c1", text: TEXT, sessionName: "fixture", check: vi.fn(async () => true as const), onPasted: vi.fn(), onDismiss: vi.fn(), ...over };
}
const box = (view: ReturnType<typeof render>) => view.queryByRole("textbox", { name: "Native command" }) as HTMLTextAreaElement | null;
const pasteButton = (view: ReturnType<typeof render>) => view.getByRole("button", { name: "Paste command" }) as HTMLButtonElement;
const reconnect = async (w: any) => {
  act(() => w.onclose?.({ code: 1006, reason: "" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  await flush();
};

it("shows the staged command locally and sends nothing on mount, connect, reconnect or remount", async () => {
  const command = staged();
  const view = render(<FocusedTerminal sessionName="fixture" autoFocus={false} command={command} />);
  expect(box(view)!.value).toBe(TEXT);
  expect(box(view)!.readOnly).toBe(true);
  expect(pasteButton(view).disabled).toBe(true);
  ready(s.sockets[0]);
  expect(pasteButton(view).disabled).toBe(false);
  await reconnect(s.sockets[0]);
  ready(s.sockets[1]);
  view.unmount();
  const again = render(<FocusedTerminal sessionName="fixture" autoFocus={false} command={command} />);
  ready(s.sockets[2]);
  await flush();
  expect(box(again)!.value).toBe(TEXT);
  expect(allFrames()).toEqual([]);
  expect(command.check).not.toHaveBeenCalled();
  expect(command.onPasted).not.toHaveBeenCalled();
});

it("Paste command checks first, then sends the exact text as one literal frame without Enter; Enter stays the operator's own key", async () => {
  const command = staged();
  const view = render(<FocusedTerminal sessionName="fixture" command={command} />);
  ready(s.sockets[0]);
  fireEvent.click(pasteButton(view));
  await flush();
  expect(command.check).toHaveBeenCalledTimes(1);
  expect(frames(s.sockets[0])).toEqual([{ type: "text", text: TEXT }]);
  expect(command.onPasted).toHaveBeenCalledWith("c1");
  const notice = view.getByTestId("focused-terminal-clipboard-fixture").textContent!;
  expect(notice).toMatch(/no Enter/i);
  expect(notice).toMatch(/does not confirm/i);
  // The owner consumed it; the row goes away and nothing repeats.
  view.rerender(<FocusedTerminal sessionName="fixture" command={null} />);
  expect(box(view)).toBeNull();
  // Native controls are the real terminal keys, sent only when tapped.
  const keys = view.getByRole("group", { name: "Terminal keys for fixture" });
  fireEvent.click(keys.querySelector('[aria-label="Enter"]')!);
  expect(frames(s.sockets[0])).toEqual([{ type: "text", text: TEXT }, { type: "keys", keys: ["Enter"] }]);
});

it("a refused check sends nothing, shows the reason and keeps the command for another try", async () => {
  const check = vi.fn<StagedCommand["check"]>(async () => ({ refuse: "The native conversation changed since this command was staged." }));
  const command = staged({ check });
  const view = render(<FocusedTerminal sessionName="fixture" command={command} />);
  ready(s.sockets[0]);
  fireEvent.click(pasteButton(view));
  await flush();
  expect(allFrames()).toEqual([]);
  expect(command.onPasted).not.toHaveBeenCalled();
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).toMatch(/conversation changed/);
  expect(box(view)!.value).toBe(TEXT);
  check.mockResolvedValueOnce(true);
  fireEvent.click(pasteButton(view));
  await flush();
  expect(frames(s.sockets[0])).toEqual([{ type: "text", text: TEXT }]);
});

it("a check that settles after a reconnect sends nothing, on either socket", async () => {
  let settle!: (v: true) => void;
  const command = staged({ check: vi.fn(() => new Promise<true>((r) => { settle = r; })) });
  const view = render(<FocusedTerminal sessionName="fixture" command={command} />);
  ready(s.sockets[0]);
  fireEvent.click(pasteButton(view));
  await reconnect(s.sockets[0]);
  ready(s.sockets[1]);
  await act(async () => { settle(true); });
  await flush();
  expect(allFrames()).toEqual([]);
  expect(command.onPasted).not.toHaveBeenCalled();
  expect(view.getByTestId("focused-terminal-clipboard-fixture").textContent).toMatch(/nothing was sent/i);
});

it("a check that settles after a switch to another session or unmount sends nothing", async () => {
  let settle!: (v: true) => void;
  const command = staged({ check: vi.fn(() => new Promise<true>((r) => { settle = r; })) });
  const view = render(<FocusedTerminal sessionName="fixture" command={command} />);
  ready(s.sockets[0]);
  fireEvent.click(pasteButton(view));
  view.rerender(<FocusedTerminal sessionName="other" command={command} />);
  ready(s.sockets[1]);
  // Bound to its own session: the other viewer does not offer it.
  expect(box(view)).toBeNull();
  await act(async () => { settle(true); });
  await flush();
  view.unmount();
  expect(allFrames()).toEqual([]);
  expect(command.onPasted).not.toHaveBeenCalled();
});

it("a command bound to another session is never offered", () => {
  const view = render(<FocusedTerminal sessionName="fixture" command={staged({ sessionName: "elsewhere" })} />);
  ready(s.sockets[0]);
  expect(box(view)).toBeNull();
  expect(view.queryByRole("button", { name: "Paste command" })).toBeNull();
});

it("Close hands the dismissal to the owner and sends nothing", () => {
  const command = staged();
  const view = render(<FocusedTerminal sessionName="fixture" command={command} />);
  ready(s.sockets[0]);
  fireEvent.click(view.getByRole("button", { name: "Close native command" }));
  expect(command.onDismiss).toHaveBeenCalledWith("c1");
  expect(allFrames()).toEqual([]);
});
