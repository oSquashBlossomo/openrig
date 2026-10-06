// V1 attempt-3 Phase 5 P5-9 — Mobile responsive polish.
//
// Coverage:
//   - MobileBottomNav renders 3 slots at <lg viewport (For You / Project /
//     Topology). Talk slots are V2-deferred per universal-shell.md L144;
//     negative-assertion that "talk" / advisor / operator do NOT appear
//     in the mobile bottom nav.
//   - Topology graph view-mode at <lg viewport mounts the touch-first phone
//     graph (owner requirement, PR14 — supersedes universal-shell.md L143's
//     table degradation); >= lg keeps the desktop canvas.
//   - useShellViewport hook reflects window.innerWidth changes.
//   - Bottom nav is hidden at >= lg viewport (lg:hidden class).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useShellViewport } from "../src/hooks/useShellViewport.js";
import { renderHook, act } from "@testing-library/react";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AppShell } from "../src/components/AppShell.js";
import { HostScopePage } from "../src/components/topology/ScopePages.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    // Topology bodies mount only behind a successfully read source host.
    if (url === "/api/hosts") return new Response(JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }));
    if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([]));
    if (url.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
    if (url.includes("/api/inventory")) return new Response(JSON.stringify([]));
    if (url.includes("/api/config")) return new Response("not implemented", { status: 404 });
    return new Response("[]");
  });
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
});

async function renderAt(initialPath: string, viewportWidth: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: viewportWidth,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
  const result = render(
    createAppTestRouter({
      routes: [
        { path: "/topology", component: HostScopePage },
        { path: "$", component: () => null },
      ],
      rootComponent: ({ children }) => <AppShell>{children}</AppShell>,
      initialPath,
    }),
  );
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
  }, { timeout: 5000 });
  return result;
}

describe("useShellViewport (P5-9 hook)", () => {
  it("reports isWideLayout=true when innerWidth >= 1024", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(true);
    expect(result.current.innerWidth).toBeGreaterThanOrEqual(1024);
  });

  it("reports isWideLayout=false when innerWidth < 1024", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(false);
  });

  it("reacts to window resize events", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(true);
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375, writable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.isWideLayout).toBe(false);
  });
});

describe("MobileBottomNav P5-9 — universal-shell.md L135 + L144", () => {
  it("renders 3 slots (For You / Project / Topology) at mobile viewport", async () => {
    const { container } = await renderAt("/", 375);
    const nav = container.querySelector("[data-testid='mobile-bottom-nav']");
    expect(nav).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-for-you']")).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-project']")).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-topology']")).toBeTruthy();
  });

  it("does NOT render Talk / advisor / operator slots (V2 deferred per L144)", async () => {
    const { container } = await renderAt("/", 375);
    expect(container.querySelector("[data-testid='mobile-nav-advisor']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-operator']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-talk']")).toBeNull();
    // Source-assertion: AppShell.tsx mobile-bottom-nav block must not
    // mention "advisor" or "operator" or "talk" in slot ids.
    const src = readFileSync(
      path.resolve(__dirname, "../src/components/AppShell.tsx"),
      "utf8",
    );
    const navBlock = src.match(/MobileBottomNav[\s\S]*?^}/m)?.[0] ?? "";
    expect(navBlock).not.toMatch(/id:\s*"(advisor|operator|talk)"/);
  });

  it("active route highlights the matching mobile nav slot", async () => {
    const { container } = await renderAt("/topology", 375);
    const topology = container.querySelector("[data-testid='mobile-nav-topology']");
    expect(topology?.getAttribute("data-active")).toBe("true");
    const project = container.querySelector("[data-testid='mobile-nav-project']");
    expect(project?.getAttribute("data-active")).toBe("false");
  });

  it("nav element carries lg:hidden so desktop never shows it (CSS-source contract)", async () => {
    const { container } = await renderAt("/", 375);
    const nav = container.querySelector("[data-testid='mobile-bottom-nav']");
    expect(nav?.className).toMatch(/lg:hidden/);
  });
});

describe("Topology graph at narrow vs wide viewports", () => {
  it("at <lg viewport, /topology graph view-mode mounts the phone graph (no table fallback)", async () => {
    const { container, findByTestId } = await renderAt("/topology", 375);
    // The phone graph owns the Graph tab; an empty fleet reads as such.
    expect(await findByTestId("phone-topology-graph")).toBeTruthy();
    expect(await findByTestId("phone-graph-empty")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-mobile-graph-degraded']")).toBeNull();
    expect(container.querySelector("[data-testid='host-multi-rig-graph']")).toBeNull();
  });

  it("at >= lg viewport, /topology graph view-mode renders the graph (no degradation hint)", async () => {
    const { findByTestId, container } = await renderAt("/topology", 1440);
    // Default tab is graph; placeholder visible.
    // V1 polish slice Phase 5.2: HostMultiRigGraph replaces the prior
    // placeholder card at host scope graph view-mode. At >= lg viewport
    // either the canvas mounts (with rigs) or the empty-state mounts
    // (mock returns []). Either is acceptable proof that the desktop
    // path mounts the desktop canvas, not the phone graph.
    // Wait for the read to settle: a pending inventory is "Reading rigs…",
    // not an empty fleet, so the callback must actually retry until mounted.
    const desktopMount = await waitFor(() => {
      const el =
        container.querySelector("[data-testid='host-multi-rig-graph']") ??
        container.querySelector("[data-testid='host-multi-rig-graph-empty']");
      expect(el).toBeTruthy();
      return el;
    });
    expect(desktopMount).toBeTruthy();
    expect(container.querySelector("[data-testid='phone-topology-graph']")).toBeNull();
  });
});
