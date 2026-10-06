// OPR.0.4.0.1 — ProgressiveTerminal behavior: default-static, click-to-live, and
// the GLOBAL cap with oldest-eviction-to-static. The heavy children
// (FocusedTerminal -> xterm+WS, SessionPreviewPane -> polling) are stubbed so the
// test exercises the interaction model + cap, not xterm/WebSocket internals.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName, fit }: { sessionName: string; fit?: string }) => (
    <div data-testid={`live-${sessionName}`} data-fit={fit}>live terminal</div>
  ),
}));
vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`preview-${sessionName}`}>static preview</div>
  ),
}));

import { ProgressiveTerminal } from "../src/components/terminal/ProgressiveTerminal.js";
import {
  LiveTerminalProvider,
  useLiveTerminal,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

describe("ProgressiveTerminal (OPR.0.4.0.1 interaction model)", () => {
  it("AC-1: defaults to the STATIC preview on render (no live terminal)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" />
      </LiveTerminalProvider>,
    );
    expect(screen.getByTestId("preview-a@r")).toBeTruthy();
    expect(screen.queryByTestId("live-a@r")).toBeNull();
  });

  it("AC-2: a click upgrades that terminal to LIVE (FocusedTerminal)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" />
      </LiveTerminalProvider>,
    );
    fireEvent.click(screen.getByTestId("progressive-terminal-static"));
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    expect(screen.queryByTestId("preview-a@r")).toBeNull();
  });

  it("live upgrade forwards the caller's fit and keeps readable-floor panning inside its own box", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" />
        <ProgressiveTerminal sessionName="b@r" terminalKey="b" testIdPrefix="detail" fit="contain" />
      </LiveTerminalProvider>,
    );
    fireEvent.click(screen.getByTestId("progressive-terminal-static"));
    fireEvent.click(screen.getByTestId("detail-static"));
    expect(screen.getByTestId("live-a@r").dataset.fit).toBe("width");
    expect(screen.getByTestId("live-b@r").dataset.fit).toBe("contain");
    expect(screen.getByTestId("progressive-terminal-live").className.split(" ")).toEqual(["w-full", "min-w-0"]);
    expect(screen.getByTestId("detail-live").className.split(" ")).toEqual(["h-full", "w-full", "min-w-0"]);
  });

  it("AC-4: GLOBAL cap=2 — opening a 3rd live evicts the OLDEST back to static; static previews uncapped", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" testIdPrefix="pt-a" />
        <ProgressiveTerminal sessionName="b@r" terminalKey="b" testIdPrefix="pt-b" />
        <ProgressiveTerminal sessionName="c@r" terminalKey="c" testIdPrefix="pt-c" />
      </LiveTerminalProvider>,
    );
    fireEvent.click(screen.getByTestId("pt-a-static")); // a -> live (oldest)
    fireEvent.click(screen.getByTestId("pt-b-static")); // b -> live
    fireEvent.click(screen.getByTestId("pt-c-static")); // c -> live, evicts a

    // a reverted to static; b + c remain live; total live == cap.
    expect(screen.getByTestId("pt-a-static")).toBeTruthy();
    expect(screen.queryByTestId("live-a@r")).toBeNull();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
    expect(screen.getByTestId("live-c@r")).toBeTruthy();
  });

  it("AC-5: the cap is config-driven — cap=3 admits three live before evicting", () => {
    render(
      <LiveTerminalProvider cap={3}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" testIdPrefix="pt-a" />
        <ProgressiveTerminal sessionName="b@r" terminalKey="b" testIdPrefix="pt-b" />
        <ProgressiveTerminal sessionName="c@r" terminalKey="c" testIdPrefix="pt-c" />
      </LiveTerminalProvider>,
    );
    fireEvent.click(screen.getByTestId("pt-a-static"));
    fireEvent.click(screen.getByTestId("pt-b-static"));
    fireEvent.click(screen.getByTestId("pt-c-static"));
    // cap=3 -> all three live, none evicted.
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
    expect(screen.getByTestId("live-c@r")).toBeTruthy();
  });

  it("another seat rendered in place starts static: the live viewer never carries over uncapped", () => {
    // The seat page reuses one ProgressiveTerminal when the route moves to a
    // cached seat (Back, a peer link): the old seat's live mode must not
    // become a live socket on the new session with no cap slot.
    const tree = (session: string, key: string) => (
      <LiveTerminalProvider cap={1}>
        <ProgressiveTerminal sessionName={session} terminalKey={key} testIdPrefix="pt-x" />
        <ProgressiveTerminal sessionName="c@r" terminalKey="c" testIdPrefix="pt-c" />
      </LiveTerminalProvider>
    );
    const { rerender } = render(tree("a@r", "a"));
    fireEvent.click(screen.getByTestId("pt-x-static"));
    expect(screen.getByTestId("live-a@r")).toBeTruthy();

    rerender(tree("b@r", "b"));
    expect(screen.queryByTestId("live-b@r")).toBeNull();
    expect(screen.getByTestId("pt-x-static")).toBeTruthy();
    // Returning to the first seat does not resurrect its live viewer either.
    rerender(tree("a@r", "a"));
    expect(screen.queryByTestId("live-a@r")).toBeNull();
    rerender(tree("b@r", "b"));

    // The cap still holds: one live terminal at cap 1.
    fireEvent.click(screen.getByTestId("pt-c-static"));
    expect(screen.getByTestId("live-c@r")).toBeTruthy();
    expect(screen.queryAllByTestId(/^live-/)).toHaveLength(1);
  });

  it("a session change under the same cap key starts static instead of reconnecting the live viewer", () => {
    // e.g. a seat card keyed rig:logicalId whose canonical session is recorded later.
    const tree = (session: string) => (
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName={session} terminalKey="ra:dev.impl" testIdPrefix="pt-x" />
      </LiveTerminalProvider>
    );
    const { rerender } = render(tree("dev.impl"));
    fireEvent.click(screen.getByTestId("pt-x-static"));
    expect(screen.getByTestId("live-dev.impl")).toBeTruthy();
    rerender(tree("dev-impl@ra"));
    expect(screen.queryByTestId("live-dev-impl@ra")).toBeNull();
    expect(screen.getByTestId("pt-x-static")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pt-x-static"));
    expect(screen.getByTestId("live-dev-impl@ra")).toBeTruthy();
  });

  describe("a configured cap change while terminals are live", () => {
    let registry: ReturnType<typeof useLiveTerminal>;
    function Capture() { registry = useLiveTerminal(); return null; }
    const tree = (cap: number) => (
      <LiveTerminalProvider cap={cap}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="a" testIdPrefix="pt-a" />
        <ProgressiveTerminal sessionName="b@r" terminalKey="b" testIdPrefix="pt-b" />
        <ProgressiveTerminal sessionName="c@r" terminalKey="c" testIdPrefix="pt-c" />
        <Capture />
      </LiveTerminalProvider>
    );

    it("lowering the cap evicts the oldest live terminals to static and keeps enforcing it", () => {
      const { rerender } = render(tree(2));
      fireEvent.click(screen.getByTestId("pt-a-static"));
      fireEvent.click(screen.getByTestId("pt-b-static"));
      rerender(tree(1));
      expect(screen.queryByTestId("live-a@r")).toBeNull();
      expect(screen.getByTestId("live-b@r")).toBeTruthy();
      expect(registry.isLive("a")).toBe(false);
      expect(registry.isLive("b")).toBe(true);
      fireEvent.click(screen.getByTestId("pt-c-static"));
      expect(screen.queryAllByTestId(/^live-/).map((el) => el.dataset.testid)).toEqual(["live-c@r"]);
    });

    it("raising the cap keeps live terminals live and counted; unmount releases them", () => {
      const { rerender, unmount } = render(tree(1));
      fireEvent.click(screen.getByTestId("pt-a-static"));
      rerender(tree(2));
      expect(screen.getByTestId("live-a@r")).toBeTruthy();
      expect(registry.isLive("a")).toBe(true);
      fireEvent.click(screen.getByTestId("pt-b-static"));
      fireEvent.click(screen.getByTestId("pt-c-static")); // cap 2: evicts a, the oldest
      expect(screen.queryByTestId("live-a@r")).toBeNull();
      expect(screen.getByTestId("live-b@r")).toBeTruthy();
      expect(screen.getByTestId("live-c@r")).toBeTruthy();
      const live = registry;
      unmount();
      expect(live.isLive("b")).toBe(false);
      expect(live.isLive("c")).toBe(false);
    });
  });
});
