// Phone navigation slide-over: the tray is sized for the 48px rail PLUS the
// destination's Explorer (w-72). Destinations without an Explorer (Dashboard,
// Workflows, Pulse, Files, …) show only the rail, so the tray must fit the
// rail instead of opening a blank 240px panel beside it (root dogfood,
// workflow-phone-drawer-empty.png).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AppShell } from "../src/components/AppShell.js";

const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => new Response("[]", { headers: { "content-type": "application/json" } }));
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 430, writable: true });
  window.dispatchEvent(new Event("resize"));
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024, writable: true });
  window.dispatchEvent(new Event("resize"));
});

async function openMenuAt(path: string) {
  const result = render(createAppTestRouter({
    routes: [{ path: "$", component: () => null }],
    rootComponent: ({ children }) => <AppShell>{children}</AppShell>,
    initialPath: path,
  }));
  const toggle = await waitFor(() => {
    const el = result.container.querySelector<HTMLElement>("[data-testid='mobile-menu-toggle']");
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(toggle);
  const tray = result.container.querySelector<HTMLElement>("[data-testid='mobile-rail-tray']")!;
  expect(tray.className).toContain("translate-x-0");
  return { tray, container: result.container };
}

describe("phone navigation tray width follows its content", () => {
  for (const path of ["/workflows", "/", "/pulse", "/files"]) {
    it(`${path} (no Explorer): the tray fits the rail, no blank panel`, async () => {
      const { tray, container } = await openMenuAt(path);
      expect(container.querySelector("[data-testid='explorer']")).toBeNull();
      expect(tray.className).not.toMatch(/\bw-72\b/);
      expect(tray.querySelector("[data-testid='app-rail']")).toBeTruthy();
    });
  }

  it("/project (Explorer-bearing): the tray keeps the rail + Explorer width", async () => {
    const { tray, container } = await openMenuAt("/project");
    expect(container.querySelector("[data-testid='explorer']")).toBeTruthy();
    expect(tray.className).toMatch(/\bw-72\b/);
  });
});
