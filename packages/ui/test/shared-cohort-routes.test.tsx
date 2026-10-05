// Shared mounting of the Files and Pulse/Recent cohorts in the ACTUAL route
// tree (root providers + AppShell): raw identity search (no JSON/number
// coercion, exact percent bytes), discoverable rail/phone entries, Back, and
// no extraneous transport (no host= forwarding, no reads of unconfirmed roots).
// Bodies come from the cohorts' test-only twin fixtures (fictional data).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "../src/routes.js";
import { queryClient } from "../src/lib/query-client.js";
import { shellRouterOptions } from "../src/components/shell/history-scroll.js";
import { operatorTwinBody, twinQueueRows } from "../twin/operator-fixtures.js";
import { filesTwinBody, filesTwinRoots } from "../twin/files-fixtures.js";
import { recentPulseQueueRows, recentPulseTwinBody } from "../twin/recent-pulse-fixtures.js";

const LAZY = { timeout: 5000 } as const;
let calls: URL[] = [];

beforeEach(() => {
  calls = []; sessionStorage.clear(); localStorage.setItem("openrig.uiExperimentalNoticeDismissed.v2", "1");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://twin.invalid");
    calls.push(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "demo-studio", selected: "local", hosts: [] });
    if (url.pathname === "/api/rigs/summary") return Response.json([]);
    if (url.pathname === "/api/files/roots") return Response.json({ roots: filesTwinRoots });
    const served = operatorTwinBody(url.pathname, url.searchParams)
      ?? recentPulseTwinBody(url.pathname, url.searchParams, [...recentPulseQueueRows, ...twinQueueRows])
      ?? filesTwinBody(url.pathname, url.searchParams, method) ?? undefined;
    return served ? Response.json(served.body, { status: served.status }) : Response.json({ unavailable: true, reason: "test_unrouted" }, { status: 404 });
  }));
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); localStorage.clear(); });

function mountApp(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), ...shellRouterOptions() });
  render(<RouterProvider router={router} />);
  return router;
}

const filesReads = () => calls.filter((u) => u.pathname.startsWith("/api/files/") && u.pathname !== "/api/files/roots");

describe("/files (FilesRoutePage)", () => {
  it("opens an exact percent-encoded file by raw identity; Back walks file entries; no forwarding", async () => {
    const router = mountApp(`/files?root=demo-notes&file=${encodeURIComponent("space & name.md")}`);
    expect((await screen.findByTestId("files-content-path", undefined, LAZY)).textContent).toBe("demo-notes/space & name.md");
    expect(router.state.location.pathname).toBe("/files");
    fireEvent.click(await screen.findByTestId("files-entry-résumé.md"));
    await waitFor(() => expect(screen.getByTestId("files-content-path").textContent).toBe("demo-notes/résumé.md"));
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(screen.getByTestId("files-content-path").textContent).toBe("demo-notes/space & name.md"));
    expect(filesReads().every((u) => !u.searchParams.has("host"))).toBe(true);
    expect(filesReads().every((u) => ["demo-notes", "demo-mirror"].includes(u.searchParams.get("root") ?? ""))).toBe(true);
  });

  it("keeps numeric-looking query identities exact (no 1.0 → 1 coercion)", async () => {
    mountApp("/files?root=demo-notes&dir=1.0");
    await screen.findByTestId("files-workspace", undefined, LAZY);
    await waitFor(() => expect(filesReads().some((u) => u.pathname === "/api/files/list")).toBe(true));
    expect(filesReads().filter((u) => u.pathname === "/api/files/list").every((u) => u.searchParams.get("path") === "1.0")).toBe(true);
  });

  it("an unconfirmed root performs no list/read", async () => {
    mountApp("/files?root=not-a-served-root&file=README.md");
    await screen.findByTestId("files-workspace", undefined, LAZY);
    await waitFor(() => expect(calls.some((u) => u.pathname === "/api/files/roots")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(filesReads()).toEqual([]);
  });
});

describe("/pulse (RecentPulseRoute)", () => {
  it("is reachable from the rail; the phone nav links it too", async () => {
    const router = mountApp("/settings/health");
    expect((await screen.findByTestId("mobile-nav-pulse", undefined, LAZY)).getAttribute("href")).toBe("/pulse");
    fireEvent.click(await screen.findByTestId("rail-pulse"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pulse"));
    expect(await screen.findByTestId("recent-pulse-page", undefined, LAZY)).toBeTruthy();
    expect(screen.getByTestId("rail-pulse").getAttribute("data-active")).toBe("true");
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/health"));
  });

  it("reads raw rig identities exactly (1.0 stays a string) and never forwards to a host", async () => {
    mountApp("/pulse?view=recent&rig=1.0");
    await screen.findByTestId("recent-pulse-page", undefined, LAZY);
    await waitFor(() => expect(calls.some((u) => u.pathname === "/api/queue/recent-transitions")).toBe(true));
    const recent = calls.filter((u) => u.pathname === "/api/queue/recent-transitions");
    expect(recent.every((u) => u.searchParams.get("rig") === "1.0" && u.searchParams.get("scope") === "rig")).toBe(true);
    expect(calls.some((u) => u.searchParams.has("host"))).toBe(false);
  });
});
