// Shared route adapter for /specs/$specKind/$specName → Library's
// SpecLookupPage, mounted through the ACTUAL route tree (root providers +
// AppShell) against Library's test-only twin fixtures. Library owns the
// resolver, its ambiguity/origin rules and its own tests; this file proves the
// shared binding: exact once-decoded path params, raw `version`/`source`
// bytes, route precedence, and the real choice → review → Back journey.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "../src/routes.js";
import { queryClient } from "../src/lib/query-client.js";
import { shellRouterOptions } from "../src/components/shell/history-scroll.js";
import { lookupPropsFrom, rawQueryOf } from "../src/components/shell/SpecLookupRoute.js";
import { LIBRARY_TWIN_IDS, libraryTwinBody, resetLibraryTwin } from "../twin/library-fixtures.js";

const LAZY = { timeout: 5000 } as const;
let calls: URL[] = [];

beforeEach(() => {
  calls = []; resetLibraryTwin(); sessionStorage.clear();
  localStorage.setItem("openrig.uiExperimentalNoticeDismissed.v2", "1");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://twin.invalid");
    calls.push(url);
    if (url.pathname === "/api/hosts") return Response.json({ ownName: "demo-studio", selected: "local", hosts: [] });
    const served = libraryTwinBody(url.pathname, url.searchParams, (init?.method ?? "GET").toUpperCase());
    return served ? Response.json(served.body, { status: served.status }) : Response.json({ unavailable: true, reason: "test_unrouted" }, { status: 404 });
  }));
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); localStorage.clear(); });

function mountApp(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/specs", path] }), ...shellRouterOptions() });
  render(<RouterProvider router={router} />);
  return router;
}

describe("spec lookup route adapter (pure)", () => {
  it("passes path params verbatim and raw version/source bytes; absent stays undefined, empty stays empty", () => {
    const params = { specKind: "agent", specName: "planner: alpha/beta 1.0" };
    expect(lookupPropsFrom(params, "/specs/agent/x")).toEqual({ kind: "agent", name: "planner: alpha/beta 1.0", version: undefined, source: undefined });
    expect(lookupPropsFrom(params, "/specs/agent/x?version=&source=")).toMatchObject({ version: "", source: "" });
    expect(lookupPropsFrom(params, "/specs/agent/x?version=1.0&source=local#frag")).toMatchObject({ version: "1.0", source: "local" });
    expect(lookupPropsFrom(params, "/specs/agent/x?version=a%3Fb%2F%C3%A9%25&source=far%3A1")).toMatchObject({ version: "a?b/é%", source: "far:1" });
    // A literal second "?" belongs to the value, not a new query.
    expect(rawQueryOf("/specs/agent/x?version=1?x").get("version")).toBe("1?x");
    expect(rawQueryOf("/specs/agent/x#v?version=9").has("version")).toBe(false);
  });
});

describe("spec lookup through the actual route tree", () => {
  it("an exact kind/name/version forwards to that served-ID review with the explicit source; Back skips the lookup", async () => {
    const name = "planner: alpha/beta 1.0";
    const router = mountApp(`/specs/agent/${encodeURIComponent(name)}?version=1.0&source=local`);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/specs/library/${encodeURIComponent(LIBRARY_TWIN_IDS.plannerReserved)}`), LAZY);
    expect(new URLSearchParams(router.state.location.publicHref.split("?")[1]).get("source")).toBe("local");
    expect(await screen.findByTestId("library-review-origin", undefined, LAZY)).toBeTruthy();
    // Catalog read with exact kind on the explicit origin (local → no host=).
    expect(calls.some((u) => u.pathname === "/api/specs/library" && u.searchParams.get("kind") === "agent" && !u.searchParams.has("host"))).toBe(true);
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/specs"));
  });

  it("several served candidates show a visible choice (none chosen); choosing opens that exact review; Back returns with source/query intact", async () => {
    const router = mountApp("/specs/agent/reviewer?version=1&source=local");
    const list = await screen.findByTestId("spec-lookup-ambiguous", undefined, LAZY);
    const candidates = within(list).getAllByTestId("spec-lookup-candidate");
    expect(candidates).toHaveLength(2);
    expect(router.state.location.pathname).toBe("/specs/agent/reviewer");
    const link = within(candidates[1]!).getAllByRole("link")[0]!;
    expect(link.getAttribute("href")).toMatch(/^\/specs\/library\/specfile%3Av2%3A0+2\?source=local$/);
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/specs/library/${encodeURIComponent(LIBRARY_TWIN_IDS.reviewerUser)}`));
    await act(async () => { router.history.back(); });
    await screen.findByTestId("spec-lookup-ambiguous", undefined, LAZY);
    expect(router.state.location.publicHref).toBe("/specs/agent/reviewer?version=1&source=local");
  });

  it("specific static library routes keep precedence over the generic lookup", async () => {
    const router = mountApp(`/specs/library/${encodeURIComponent(LIBRARY_TWIN_IDS.reviewerV2)}?source=local`);
    await screen.findByTestId("library-review-origin", undefined, LAZY);
    expect(router.state.matches.at(-1)!.routeId).toBe("/specs/library/$entryId");
    expect(screen.queryByTestId("spec-lookup")).toBeNull();
  });
});
