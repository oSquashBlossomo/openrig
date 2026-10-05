// Shared shell integration against the ACTUAL route tree, root providers and
// AppShell: newly mounted cohorts are reachable from the shell, retained
// provider state survives route unmounts, Help works offline and every help
// target is a registered route. Only `fetch`/`EventSource` are replaced;
// bodies come from the test-only twin fixtures (fictional data).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRouter, RouterProvider, type AnyRoute } from "@tanstack/react-router";
import { routeTree } from "../src/routes.js";
import { queryClient } from "../src/lib/query-client.js";
import { HELP_SECTIONS } from "../src/components/shell/help-registry.js";
import { operatorTwinBody } from "../twin/operator-fixtures.js";
import { projectWorkflowTwinBody } from "../twin/project-workflow-fixtures.js";
import { recoveryTwinBody, resetRecoveryTwin } from "../twin/recovery-twin-routes.js";
import { shellRouterOptions } from "../src/components/shell/history-scroll.js";

class FakeEventSource {
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: (() => void) | null = null;
  readyState = 0; url: string;
  constructor(url: string) { this.url = url; }
  addEventListener() {} removeEventListener() {} close() { this.readyState = 2; }
}

interface Call { method: string; path: string; search: URLSearchParams }
let offline = false;
let advisorSession = "";
let calls: Call[] = [];

function installDaemon() {
  calls = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://twin.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, search: url.searchParams });
    if (offline) throw new TypeError("Failed to fetch");
    let body: unknown;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "demo-studio", selected: "local", hosts: [] });
    if (url.pathname === "/api/rigs/summary") return Response.json([]);
    if (url.pathname === "/api/config" && url.searchParams.get("view") !== "browser") {
      return Response.json({ settings: {
        "ui.timezone": { value: "Europe/London", source: "file", defaultValue: "America/Los_Angeles" },
        "agents.advisor_session": { value: advisorSession, source: "file", defaultValue: "" },
      } });
    }
    const served = operatorTwinBody(url.pathname, url.searchParams)
      ?? projectWorkflowTwinBody(url.pathname, url.searchParams, method, body)
      ?? recoveryTwinBody(url.pathname, url.searchParams, method, []);
    return served ? Response.json(served.body, { status: served.status }) : Response.json({ unavailable: true, reason: "test_unrouted" }, { status: 404 });
  }));
}

// Lazily loaded route chunks can take longer than the default 1s under load.
const LAZY = { timeout: 5000 } as const;

function mountApp(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), ...shellRouterOptions() });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  offline = false; advisorSession = ""; resetRecoveryTwin(); sessionStorage.clear(); localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  installDaemon();
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); });

describe("shared shell · cohort entry points", () => {
  it("zero-rig saved terminals: reachable from the Settings explorer; exact token detail; Back keeps the filter", async () => {
    const router = mountApp("/settings");
    fireEvent.click(await screen.findByTestId("settings-explorer-item-terminals"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/terminals"));
    expect(await screen.findByTestId("terminal-derived-empty", undefined, LAZY)).toBeTruthy();
    fireEvent.change(await screen.findByTestId("terminal-catalog-filter"), { target: { value: "wall" } });
    fireEvent.click(await screen.findByTestId("terminal-row-saved:sv-wall"));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "saved:sv-wall" }));
    expect((await screen.findByTestId("terminal-detail-token")).textContent).toBe("saved:sv-wall");
    await act(async () => { router.history.back(); });
    expect(((await screen.findByTestId("terminal-catalog-filter")) as HTMLInputElement).value).toBe("wall");
    expect(screen.getByTestId("settings-explorer-item-terminals").getAttribute("data-active")).toBe("true");
  });

  it("fleet restore receipt survives navigating away and back (provider above the route Outlet), with one kickoff", async () => {
    const router = mountApp("/settings/restore");
    const start = await screen.findByTestId("fleet-kickoff-start", undefined, LAZY) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    expect((await screen.findByTestId("fleet-attempt-id")).textContent).toBe("twin-fleet-attempt-1");
    await act(async () => { await router.navigate({ to: "/settings/health" }); });
    await screen.findByTestId("operator-health-page", undefined, LAZY);
    await act(async () => { router.history.back(); });
    expect((await screen.findByTestId("fleet-attempt-id")).textContent).toBe("twin-fleet-attempt-1");
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/crash-cart/restore-fleet")).toHaveLength(1);
  });

  it("seat startup is reachable and labels the connected instance", async () => {
    mountApp("/settings");
    fireEvent.click(await screen.findByTestId("settings-explorer-item-startup"));
    expect(await screen.findByTestId("startup-chooser", undefined, LAZY)).toBeTruthy();
  });

  it("catalog projects are reachable from the project Explorer and duplicate names stay distinguished by root", async () => {
    const router = mountApp("/project");
    fireEvent.click(await screen.findByTestId("explorer-project-catalog-link"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/project/catalog"));
    await screen.findByTestId("catalog-project-page", undefined, LAZY);
    await waitFor(() => expect(document.body.textContent).toContain("/srv/books/north"));
    expect(document.body.textContent).toContain("/srv/books/south");
    // Nothing is selected implicitly: no scoped project read happened.
    expect(calls.some((c) => c.search.has("projectRoot"))).toBe(false);
  });
});

describe("shared shell · help and action discovery", () => {
  it("the top-bar help opens contextual help for the current page; return goes back to it", async () => {
    const router = mountApp("/settings/health");
    await screen.findByTestId("operator-health-page", undefined, LAZY);
    fireEvent.click(screen.getByTestId("topbar-help"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/help"));
    expect(router.state.location.search).toEqual({ from: "/settings/health" });
    expect((await screen.findByTestId("help-contextual")).textContent).toMatch(/On this page · System · Health/);
    fireEvent.click(screen.getByTestId("help-return"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/health"));
  });

  it("? opens help outside text fields and is ignored while typing", async () => {
    const router = mountApp("/settings/configuration");
    const search = await screen.findByTestId("configuration-search");
    fireEvent.keyDown(search, { key: "?" });
    expect(router.state.location.pathname).toBe("/settings/configuration");
    fireEvent.keyDown(document.body, { key: "?" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/help"));
    expect(router.state.location.search).toEqual({ from: "/settings/configuration" });
  });

  it("help, its links and Back keep working while every daemon read fails", async () => {
    offline = true;
    const router = mountApp("/settings/health");
    await screen.findByTestId("health-list-error");
    fireEvent.click(screen.getByTestId("topbar-help"));
    const offlineEntry = await screen.findByTestId("help-entry-offline");
    expect(offlineEntry.textContent).toContain("rig daemon start");
    expect(within(screen.getByTestId("help-section-terminals")).getAllByTestId("help-entry-terminals-link")[0]!.getAttribute("href")).toBe("/terminals");
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/health"));
  });

  it("help search filters actions and states an empty match explicitly", async () => {
    mountApp("/help");
    fireEvent.change(await screen.findByTestId("help-search"), { target: { value: "timezone" } });
    expect(await screen.findByTestId("help-entry-timezone")).toBeTruthy();
    expect(screen.queryByTestId("help-entry-terminals")).toBeNull();
    fireEvent.change(screen.getByTestId("help-search"), { target: { value: "no-such-action-xyz" } });
    expect(await screen.findByTestId("help-filter-empty")).toBeTruthy();
  });

  it("covers all eight TUI sections and every help target is a registered route", () => {
    const tuiSections = HELP_SECTIONS.map((s) => s.tuiSection).filter(Boolean);
    expect(new Set(tuiSections)).toEqual(new Set(["topology", "specs", "scopes", "terminals", "needs", "system", "config", "connections"]));
    const children = (routeTree as unknown as { children: AnyRoute[] | Record<string, AnyRoute> }).children;
    const paths = new Set((Array.isArray(children) ? children : Object.values(children)).map((r) => (r.options as { path?: string }).path));
    const targets = HELP_SECTIONS.flatMap((s) => s.entries.flatMap((e) => e.targets ?? []));
    expect(targets.length).toBeGreaterThan(20);
    for (const target of targets) expect(paths.has(target.to), `${target.to} is a route`).toBe(true);
    for (const entry of HELP_SECTIONS.flatMap((s) => s.entries)) {
      if (entry.availability !== "gui") expect(entry.note ?? entry.cli, `${entry.id} explains its availability`).toBeTruthy();
      if (entry.availability === "gui") expect(entry.targets?.length ?? entry.keys, `${entry.id} has a destination`).toBeTruthy();
    }
  });
});

describe("shared shell · display time", () => {
  it("adopts the connected instance's ui.timezone app-wide and shows the zone and source", async () => {
    mountApp("/settings/health");
    await waitFor(() => expect(screen.getByTestId("operator-health-display-zone").textContent).toMatch(/Showing Europe\/London \(ui.timezone · file\)/));
  });
});

describe("shared shell · Back/Forward scroll continuity", () => {
  it("push starts at the top, replace keeps the scroll, Back restores the entry's scroll", async () => {
    // jsdom lacks Element.scrollTo; model it as assigning scrollTop.
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
      this.scrollTop = typeof options === "object" ? options.top ?? 0 : 0;
    } as typeof HTMLElement.prototype.scrollTo;
    try {
      const router = mountApp("/settings/health");
      await screen.findByTestId("health-row-hf-queue-stall-builder2", undefined, LAZY);
      const main = screen.getByTestId("content-area");
      main.scrollTop = 400;
      fireEvent.scroll(main);
      await new Promise((resolve) => setTimeout(resolve, 150));

      fireEvent.click(screen.getByTestId("settings-explorer-item-configuration"));
      await screen.findByTestId("configuration-list", undefined, LAZY);
      await waitFor(() => expect(main.scrollTop).toBe(0));

      main.scrollTop = 250;
      fireEvent.scroll(main);
      await new Promise((resolve) => setTimeout(resolve, 150));
      fireEvent.change(screen.getByTestId("configuration-search"), { target: { value: "workspace" } });
      await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "workspace" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(main.scrollTop).toBe(250);

      await act(async () => { router.history.back(); });
      await screen.findByTestId("health-row-hf-queue-stall-builder2", undefined, LAZY);
      await waitFor(() => expect(main.scrollTop).toBe(400));
    } finally {
      HTMLElement.prototype.scrollTo = original;
    }
  });
});

describe("shared shell · spatial link contract integration", () => {
  it("chat seats link with exact raw params and an explicit local source", async () => {
    advisorSession = "lead 100%@alpha/one";
    const router = mountApp("/settings/health");
    const advisor = await screen.findByTestId("rail-advisor");
    await waitFor(() => expect(advisor.getAttribute("href")).toContain("/topology/seat/"));
    expect(advisor.getAttribute("href")).toContain("sourceHost=local");
    fireEvent.click(advisor);
    await waitFor(() => expect(router.state.location.pathname.startsWith("/topology/seat/")).toBe(true));
    const match = router.state.matches.at(-1)!;
    expect(match.params).toMatchObject({ rigId: "alpha/one", logicalId: "lead 100%" });
    expect((router.state.location.search as Record<string, unknown>).sourceHost).toBe("local");
  });

  it("the app router keeps topology raw search fields exact (no JSON/number coercion)", async () => {
    const router = mountApp("/topology?spatialQuery=1.0&selectedRig=007");
    await waitFor(() => expect(router.state.location.pathname).toBe("/topology"));
    expect(router.state.location.search).toMatchObject({ spatialQuery: "1.0", selectedRig: "007" });
  });
});

describe("shared shell · first-load notice and header", () => {
  it("renders the notice in flow below the header; Help works while it is visible; dismissal removes it", async () => {
    const router = mountApp("/settings/health");
    const notice = await screen.findByTestId("ui-maintenance-notice");
    const header = screen.getByTestId("app-topbar");
    expect(header.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header.contains(screen.getByTestId("topbar-help"))).toBe(true);
    expect(notice.contains(screen.getByTestId("topbar-help"))).toBe(false);
    expect(notice.className).not.toMatch(/\b(fixed|absolute)\b/);
    fireEvent.click(screen.getByTestId("topbar-help"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/help"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss experimental UI notice" }));
    expect(screen.queryByTestId("ui-maintenance-notice")).toBeNull();
  });
});

describe("shared shell · help return admission", () => {
  it.each(["/\\example.invalid", "/\n/example.invalid", "/\t/example.invalid", "//example.invalid/x", "/ok\u0000x"])("refuses a return path that a browser would resolve elsewhere: %j", async (from) => {
    mountApp(`/help?from=${encodeURIComponent(from)}`);
    await screen.findByTestId("help-page", undefined, LAZY);
    expect(screen.queryByTestId("help-return")).toBeNull();
    expect(screen.queryByTestId("help-contextual")).toBeNull();
  });

  it("keeps an ordinary local return exact, including query, hash and opaque bytes", async () => {
    const from = "/settings/configuration?q=1.0#section";
    mountApp(`/help?from=${encodeURIComponent(from)}`);
    const link = await screen.findByTestId("help-return") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(from);
    expect(new URL(link.href).origin).toBe(window.location.origin);
  });
});

describe("shared shell · scroll identity across replace", () => {
  it("a filter replace keeps the entry's saved scroll for Back without another scroll event", async () => {
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
      this.scrollTop = typeof options === "object" ? options.top ?? 0 : 0;
    } as typeof HTMLElement.prototype.scrollTo;
    try {
      const router = mountApp("/settings/configuration");
      await screen.findByTestId("configuration-list", undefined, LAZY);
      const main = screen.getByTestId("content-area");
      main.scrollTop = 250; fireEvent.scroll(main);
      await new Promise((resolve) => setTimeout(resolve, 150));
      fireEvent.change(screen.getByTestId("configuration-search"), { target: { value: "workspace" } });
      await waitFor(() => expect(router.state.location.search).toMatchObject({ q: "workspace" }));
      await act(async () => { await router.navigate({ to: "/settings/health" }); });
      await screen.findByTestId("operator-health-page", undefined, LAZY);
      await waitFor(() => expect(main.scrollTop).toBe(0));
      await act(async () => { router.history.back(); });
      await screen.findByTestId("configuration-list", undefined, LAZY);
      expect(router.state.location.search).toMatchObject({ q: "workspace" });
      await waitFor(() => expect(main.scrollTop).toBe(250));
    } finally {
      HTMLElement.prototype.scrollTo = original;
    }
  });
});

describe("shared shell · rapid Back/Forward keeps the entry's main offset", () => {
  it("an offset scrolled moments before an immediate Back survives Forward (no settle wait)", async () => {
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
      this.scrollTop = typeof options === "object" ? options.top ?? 0 : 0;
    } as typeof HTMLElement.prototype.scrollTo;
    try {
      const router = mountApp("/settings/health");
      await screen.findByTestId("health-row-hf-queue-stall-builder2", undefined, LAZY);
      const main = screen.getByTestId("content-area");
      await act(async () => { await router.navigate({ to: "/settings/configuration" }); });
      await screen.findByTestId("configuration-list", undefined, LAZY);
      await waitFor(() => expect(main.scrollTop).toBe(0)); // fresh push starts at the top
      main.scrollTop = 400; fireEvent.scroll(main);
      // Immediately: no time for the router's throttled capture.
      await act(async () => { router.history.back(); });
      await screen.findByTestId("health-row-hf-queue-stall-builder2", undefined, LAZY);
      await act(async () => { router.history.forward(); });
      await screen.findByTestId("configuration-list", undefined, LAZY);
      await waitFor(() => expect(main.scrollTop).toBe(400));
      await new Promise((resolve) => setTimeout(resolve, 250)); // late throttled work must not reset it
      expect(main.scrollTop).toBe(400);
    } finally {
      HTMLElement.prototype.scrollTo = original;
    }
  });
});
