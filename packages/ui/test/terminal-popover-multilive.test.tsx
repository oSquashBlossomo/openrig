// OPR.0.4.0.1 rev1-r2 fix: progressive terminal popovers (the graph/table
// surfaces) must COEXIST under the global LiveTerminalRegistry cap. The old
// single-open TERMINAL_PREVIEW_EVENT force-closed every sibling popover when one
// opened, so only ONE popover (hence <=1 live) could exist at a time -- making
// AC-4 ("watch A while typing in B" + cap=2 oldest-eviction) UNREACHABLE on the
// popover surfaces (only the topology grid in-place path reached it). Progressive
// popovers now open independently; the global cap bounds the live count.
// Heavy leaves (FocusedTerminal xterm+WS, SessionPreviewPane polling) are stubbed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`live-${sessionName}`}>live terminal</div>
  ),
}));
vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`preview-${sessionName}`}>static preview</div>
  ),
}));

import { TerminalPreviewPopover } from "../src/components/topology/TerminalPreviewPopover.js";
import {
  LiveTerminalProvider,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

// Open a progressive popover and click its static trigger to go live.
function goLive(prefix: string) {
  fireEvent.click(screen.getByTestId(`${prefix}-terminal-open`));
  fireEvent.click(screen.getByTestId(`${prefix}-static`));
}

describe("Progressive terminal popovers coexist under the global cap (rev1-r2 fix)", () => {
  it("opening a second progressive popover does NOT close the first -- two live at once", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pa" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="b" sessionName="b@r" testIdPrefix="pb" progressive />
      </LiveTerminalProvider>,
    );
    goLive("pa");
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    goLive("pb");
    // BOTH live simultaneously -- the first popover was NOT force-closed.
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
  });

  it("OPR.0.4.0.39 (founder spec, REVERSES rev1-r2 reshape): the popover holds the full-terminal width for BOTH static and live (no reshape on go-live)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pa" progressive />
      </LiveTerminalProvider>,
    );
    // open the popover -> STATIC -> shell is already the full-terminal width (the
    // static is the 90-col mirror, not a small compact preview).
    fireEvent.click(screen.getByTestId("pa-terminal-open"));
    expect(screen.getByTestId("pa-terminal-popover").className).toContain("w-max");
    expect(screen.getByTestId("pa-terminal-popover").className).not.toContain("w-[calc(80ch+24px)]");
    // click inside -> LIVE -> SAME width (no reshape / relocation; the static just
    // flips glass->opaque in place - the founder's mirror requirement).
    fireEvent.click(screen.getByTestId("pa-static"));
    expect(screen.getByTestId("pa-terminal-popover").className).toContain("w-max");
    expect(screen.getByTestId("pa-terminal-popover").className).not.toContain("w-[calc(80ch+24px)]");
  });

  it("a third live progressive popover evicts the OLDEST to static (global cap=2)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pa" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="b" sessionName="b@r" testIdPrefix="pb" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="c" sessionName="c@r" testIdPrefix="pc" progressive />
      </LiveTerminalProvider>,
    );
    goLive("pa");
    goLive("pb");
    goLive("pc");
    // cap=2: the oldest (a) reverts to static; b + c stay live.
    expect(screen.queryByTestId("live-a@r")).toBeNull();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
    expect(screen.getByTestId("live-c@r")).toBeTruthy();
  });
});

// A phone's software keyboard shrinks (and may pan) the visual viewport with
// no window resize; the fixed popover must move into the visible band so its
// live terminal is not left under the keyboard. Without a keyboard the
// position is unchanged.
describe("Terminal popover follows the visible viewport", () => {
  it("repositions above a software keyboard and stays put without one", () => {
    const vv = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 844 });
    try {
      render(<TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pk" />);
      screen.getByTestId("pk-terminal-open").parentElement!.getBoundingClientRect = () =>
        ({ left: 20, right: 40, top: 600, bottom: 620, width: 20, height: 20, x: 20, y: 600, toJSON() {} }) as DOMRect;
      fireEvent.click(screen.getByTestId("pk-terminal-open"));
      const popover = screen.getByTestId("pk-terminal-popover");
      // Fallback 240px tall: no room below the anchor, so it opens above it.
      expect(popover.style.top).toBe("352px");

      act(() => { Object.assign(vv, { height: 300, offsetTop: 100 }); vv.dispatchEvent(new Event("resize")); });
      const top = Number.parseFloat(popover.style.top);
      expect(top).toBeGreaterThanOrEqual(100);
      expect(top + 240).toBeLessThanOrEqual(400);
      // Never taller than the visible band (8px margins), so the live
      // terminal's own fitting keeps its toolbar inside the popover.
      expect(popover.style.maxHeight).toBe("284px");
    } finally {
      delete (window as any).visualViewport;
    }
  });

  // Pinch zoom + horizontal pan: the visible band is narrower than the layout
  // viewport and offset to the right; the popover and its 90ch content must
  // stay inside it on both axes.
  it("stays inside a zoomed, horizontally panned visual viewport; falls back to the window without one", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 768 });
    const vv = Object.assign(new EventTarget(), { width: 200, height: 400, offsetTop: 100, offsetLeft: 600, scale: 5 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    try {
      const view = render(<TerminalPreviewPopover rigId="r1" logicalId="z" sessionName="z@r" testIdPrefix="pz" />);
      screen.getByTestId("pz-terminal-open").parentElement!.getBoundingClientRect = () =>
        ({ left: 620, right: 640, top: 150, bottom: 170, width: 20, height: 20, x: 620, y: 150, toJSON() {} }) as DOMRect;
      fireEvent.click(screen.getByTestId("pz-terminal-open"));
      const popover = screen.getByTestId("pz-terminal-popover");
      const left = Number.parseFloat(popover.style.left);
      expect(left).toBeGreaterThanOrEqual(608);
      expect(popover.style.maxWidth).toBe("184px");
      expect(left + 184).toBeLessThanOrEqual(792);
      expect((popover.firstElementChild as HTMLElement).style.maxWidth).toBe("168px");
      const top = Number.parseFloat(popover.style.top);
      expect(top).toBeGreaterThanOrEqual(108);
      view.unmount();

      // No visual viewport (fallback): the window bounds, as before.
      delete (window as any).visualViewport;
      render(<TerminalPreviewPopover rigId="r1" logicalId="w" sessionName="w@r" testIdPrefix="pw" />);
      screen.getByTestId("pw-terminal-open").parentElement!.getBoundingClientRect = () =>
        ({ left: 20, right: 40, top: 150, bottom: 170, width: 20, height: 20, x: 20, y: 150, toJSON() {} }) as DOMRect;
      fireEvent.click(screen.getByTestId("pw-terminal-open"));
      const fallback = screen.getByTestId("pw-terminal-popover");
      expect(fallback.style.left).toBe("48px");
      expect(fallback.style.top).toBe("150px");
      expect(fallback.style.maxWidth).toBe("1008px");
      expect(fallback.style.maxHeight).toBe("752px");
    } finally {
      delete (window as any).visualViewport;
    }
  });
});
