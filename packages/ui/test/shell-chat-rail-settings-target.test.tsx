// Advisor / Operator rail icons with no configured seat promise a one-click
// path to configure it: `/settings#agents-{role}-session` (resolveChatTo,
// universal-shell.md L80). The Settings page must actually carry that
// anchor and an editable row for the key, or the click is a dead end.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { AppShell } from "../src/components/AppShell.js";
import { SettingsCenter } from "../src/components/system/SettingsCenter.js";

const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;

function settingsBody(operator: string, advisor: string) {
  const row = (value: unknown, defaultValue: unknown = "") => ({ value, source: value === defaultValue ? "default" : "file", defaultValue });
  return {
    settings: {
      "workspace.root": row("/w", "/w"),
      "agents.advisor_session": row(advisor, "advisor-lead@openrig-velocity"),
      "agents.operator_session": row(operator, ""),
    },
  };
}

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/config" && (!init || !init.method || init.method === "GET")) {
      return new Response(JSON.stringify(settingsBody("", "")), { headers: { "content-type": "application/json" } });
    }
    return new Response("[]", { headers: { "content-type": "application/json" } });
  });
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  // jsdom has no scrollIntoView; the router's hash scroll and SettingsTab use it.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
});

function mount(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <AppShell><Outlet /></AppShell>
      </QueryClientProvider>
    ),
  });
  const settings = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsCenter });
  const rest = createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => <div data-testid="elsewhere" /> });
  const router = createRouter({ routeTree: rootRoute.addChildren([settings, rest]), history: createMemoryHistory({ initialEntries: [initialPath] }) });
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("Advisor / Operator rail → Settings configuration target", () => {
  for (const role of ["operator", "advisor"] as const) {
    it(`unset ${role} seat: the rail lands on Settings at an editable agents.${role}_session row`, async () => {
      const { router, container } = mount("/");
      const link = await waitFor(() => {
        const el = container.querySelector<HTMLAnchorElement>(`[data-testid='rail-${role}']`);
        expect(el).toBeTruthy();
        return el!;
      });
      fireEvent.click(link);
      await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
      expect(router.state.location.hash).toBe(`agents-${role}-session`);
      // The promised anchor exists and holds the editable row for that key.
      const anchor = await waitFor(() => {
        const el = container.querySelector(`#agents-${role}-session`);
        expect(el).toBeTruthy();
        return el!;
      });
      const row = anchor.querySelector(`[data-testid='setting-agents.${role}_session']`);
      expect(row).toBeTruthy();
      expect(row!.querySelector(`[data-testid='setting-agents.${role}_session-edit']`)).toBeTruthy();
      // Settings loads after navigation; the anchor is still brought into view.
      expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(anchor);
    });
  }
});
