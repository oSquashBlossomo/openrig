// FocusedTerminal's opt-in admission seam (beforeConnect) and autoFocus.
// Existing callers pass neither: they must connect synchronously and focus as
// before. With a check, every open — first and reconnect — waits for it, and a
// resolution that arrives after the mount/session moved on never connects.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import React from "react";

const instances: MockWS[] = [];
let focusCalls = 0;

class MockWS {
  url: string;
  readyState = 1;
  onopen: ((evt?: unknown) => void) | null = null;
  onclose: ((evt: { code: number; reason: string }) => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalled = false;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.closeCalled = true; this.readyState = 3; }
  static OPEN = 1;
}
vi.stubGlobal("WebSocket", MockWS);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open(el: HTMLElement) { el.appendChild(document.createElement("div")); }
    write() {}
    onData() {}
    focus() { focusCalls++; }
    scrollToBottom() {}
    attachCustomWheelEventHandler() {}
    dispose() {}
    options = { fontSize: 13 };
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  instances.length = 0;
  focusCalls = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FocusedTerminal defaults (existing callers)", () => {
  it("connects synchronously on mount and focuses, with no admission seam", () => {
    render(<FocusedTerminal sessionName="dev@rig" />);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toContain("/api/terminal/dev%40rig?protocol=2");
    expect(focusCalls).toBe(1);
  });
});

describe("FocusedTerminal beforeConnect", () => {
  it("waits for admission before the first socket and sends nothing on open", async () => {
    const gate = deferred<true | { refuse: string }>();
    const beforeConnect = vi.fn(() => gate.promise);
    render(<FocusedTerminal sessionName="dev@rig" beforeConnect={beforeConnect} autoFocus={false} />);
    expect(beforeConnect).toHaveBeenCalledWith({ reconnect: false });
    expect(instances).toHaveLength(0);
    await act(async () => { gate.resolve(true); });
    expect(instances).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(instances[0]!.sent).toEqual([]);
    expect(focusCalls).toBe(0);
  });

  it("never connects for a check that resolves after unmount", async () => {
    const gate = deferred<true | { refuse: string }>();
    const { unmount } = render(<FocusedTerminal sessionName="dev@rig" beforeConnect={() => gate.promise} />);
    unmount();
    await act(async () => { gate.resolve(true); });
    expect(instances).toHaveLength(0);
  });

  it("never connects the old session when its check resolves after a session change", async () => {
    const gates = [deferred<true | { refuse: string }>(), deferred<true | { refuse: string }>()];
    let call = 0;
    const beforeConnect = () => gates[call++]!.promise;
    const { rerender } = render(<FocusedTerminal sessionName="a@rig" beforeConnect={beforeConnect} />);
    rerender(<FocusedTerminal sessionName="b@rig" beforeConnect={beforeConnect} />);
    await act(async () => { gates[0]!.resolve(true); });
    expect(instances).toHaveLength(0);
    await act(async () => { gates[1]!.resolve(true); });
    expect(instances.map((w) => w.url)).toEqual([expect.stringContaining("/api/terminal/b%40rig")]);
  });

  it("a refusal or a rejected check shows the honest reason and opens nothing", async () => {
    render(<FocusedTerminal sessionName="dev@rig" beforeConnect={async () => ({ refuse: "Seat identity changed" })} />);
    await act(async () => {});
    expect(instances).toHaveLength(0);
    expect(screen.getByTestId("focused-terminal-dev@rig").textContent).toContain("Terminal unavailable: Seat identity changed");
    cleanup();
    render(<FocusedTerminal sessionName="dev@rig" beforeConnect={async () => { throw new Error("detail read failed"); }} />);
    await act(async () => {});
    expect(instances).toHaveLength(0);
    expect(screen.getByTestId("focused-terminal-dev@rig").textContent).toContain("detail read failed");
  });

  it("re-checks before every reconnect; a refused reconnect stays closed", async () => {
    const verdicts: Array<true | { refuse: string }> = [true, true, { refuse: "Seat identity changed while reconnecting" }];
    const beforeConnect = vi.fn(async () => verdicts.shift()!);
    render(<FocusedTerminal sessionName="dev@rig" beforeConnect={beforeConnect} />);
    await act(async () => {});
    expect(instances).toHaveLength(1);
    // Transient drop → reconnect after 3s, through admission.
    act(() => { instances[0]!.onclose?.({ code: 1006, reason: "" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(beforeConnect).toHaveBeenLastCalledWith({ reconnect: true });
    expect(instances).toHaveLength(2);
    act(() => { instances[1]!.onclose?.({ code: 1006, reason: "" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(beforeConnect).toHaveBeenCalledTimes(3);
    expect(instances).toHaveLength(2);
    expect(screen.getByTestId("focused-terminal-dev@rig").textContent).toContain("Seat identity changed while reconnecting");
  });

  it("a new callback identity does not remount or reconnect the viewer", async () => {
    const { rerender } = render(<FocusedTerminal sessionName="dev@rig" beforeConnect={async () => true} />);
    await act(async () => {});
    rerender(<FocusedTerminal sessionName="dev@rig" beforeConnect={async () => true} />);
    await act(async () => {});
    expect(instances).toHaveLength(1);
    expect(instances[0]!.closeCalled).toBe(false);
  });
});
