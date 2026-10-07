// Phone/narrow-tablet navigation: the slide-over shows the 48px icon rail AND
// the destination's Explorer side by side. Root confirmed in the browser at
// 430×932 on /project that the Explorer (fixed left-0, w-72, z-40) covered the
// rail completely: elementFromPoint at the Library link's centre hit the
// Explorer tree, so Library/Settings/… could not be tapped. jsdom has no
// layout, so this guards the geometry contract through the applied classes:
// below lg the Explorer starts after the rail (+ left safe area) and, when
// closed, translates fully off-screen; from lg the desktop column is unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AppShell } from "../src/components/AppShell.js";

const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width, writable: true });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => new Response("[]", { headers: { "content-type": "application/json" } }));
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
  setWidth(1024);
});

async function mountAt(path: string, width: number) {
  setWidth(width);
  const result = render(createAppTestRouter({
    routes: [{ path: "$", component: () => null }],
    rootComponent: ({ children }) => <AppShell>{children}</AppShell>,
    initialPath: path,
  }));
  const explorer = await waitFor(() => {
    const el = result.container.querySelector<HTMLElement>("[data-testid='explorer']");
    expect(el).toBeTruthy();
    return el!;
  });
  return { ...result, explorer };
}

/** Base (below-lg) utility classes, i.e. without any responsive prefix. */
function baseClasses(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter((c) => c && !/^(sm|md|lg|xl|2xl|supports-\[[^\]]*\]):/.test(c));
}

describe("narrow-layout Explorer sits beside the rail instead of over it", () => {
  for (const width of [430, 834]) {
    it(`${width}px /project: the open Explorer starts after the 48px rail and the rail stays tappable`, async () => {
      const { container, explorer } = await mountAt("/project", width);
      fireEvent.click(container.querySelector("[data-testid='mobile-menu-toggle']")!);
      const tray = container.querySelector<HTMLElement>("[data-testid='mobile-rail-tray']")!;
      expect(tray.className).toContain("translate-x-0");
      expect(tray.querySelector("[data-testid='rail-specs']")).toBeTruthy();
      const base = baseClasses(explorer);
      // Not anchored at the viewport edge where the rail lives.
      expect(base).not.toContain("left-0");
      // Anchored at rail width (3rem = the rail's w-12) plus the left safe area,
      // the same origin the tray uses for the rail itself.
      expect(base).toContain("left-[calc(var(--safe-left)+3rem)]");
      // Rail (3rem) + Explorer (15rem) = the tray's w-72 (18rem).
      expect(base).toContain("w-60");
      expect(base).toContain("translate-x-0");
    });
  }

  it("430px closed: the Explorer translates past the rail offset so no strip stays on screen", async () => {
    const { explorer } = await mountAt("/project", 430);
    const base = baseClasses(explorer);
    expect(base).not.toContain("-translate-x-full");
    expect(base).toContain("-translate-x-[calc(100%+3rem+var(--safe-left))]");
  });

  it("desktop (1440px): the persistent Explorer column is unchanged", async () => {
    const { explorer } = await mountAt("/project", 1440);
    for (const cls of ["lg:absolute", "lg:left-12", "lg:w-72", "lg:max-w-none", "lg:translate-x-0", "lg:pl-0"]) {
      expect(explorer.className.split(/\s+/)).toContain(cls);
    }
  });
});
