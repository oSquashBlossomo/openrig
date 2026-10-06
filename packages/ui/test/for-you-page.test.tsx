// For You = canonical Attention (default) + the unchanged Activity feed.
// View and the exact selected item ride a validated query string so direct
// links, reload and Back restore them. The Activity feed itself is covered
// by its own suites; here it is a stub so this file tests the wrapper.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { operatorTwinBody } from "../twin/operator-fixtures.js";

vi.mock("../src/components/for-you/Feed.js", () => ({ Feed: () => <div data-testid="for-you-feed">activity feed</div> }));

import { ForYouPage } from "../src/components/operator/ForYouPage.js";
import { validateForYouSearch } from "../src/components/operator/operator-search.js";

let qc: QueryClient | undefined;
afterEach(() => { cleanup(); qc?.clear(); qc = undefined; vi.unstubAllGlobals(); });

function mount(initial: string, hosts = { ownName: "demo-studio", selected: "local" }) {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://local");
    calls.push(url);
    if (url.pathname === "/api/hosts") return Response.json({ ...hosts, hosts: [] });
    const served = operatorTwinBody(url.pathname, url.searchParams);
    return served ? Response.json(served.body, { status: served.status }) : Response.json({ error: "not_found" }, { status: 404 });
  }));
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const client = qc;
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> });
  const forYou = createRoute({ getParentRoute: () => root, path: "/for-you", validateSearch: validateForYouSearch, component: ForYouPage });
  const health = createRoute({ getParentRoute: () => root, path: "/settings/health", component: () => <p>health</p> });
  const router = createRouter({ routeTree: root.addChildren([forYou, health]), history: createMemoryHistory({ initialEntries: [initial] }) });
  render(<RouterProvider router={router} />);
  return { router, calls };
}

describe("For You page", () => {
  it("defaults to canonical Attention and labels the connected instance", async () => {
    mount("/for-you");
    expect((await screen.findByTestId("for-you-page")).getAttribute("data-view")).toBe("attention");
    expect(screen.getByTestId("for-you-tab-attention").getAttribute("aria-selected")).toBe("true");
    await screen.findByTestId("attention-row-queue:q-twin-101");
    await waitFor(() => expect(screen.getByTestId("operator-instance-label").textContent).toBe("Connected instance · demo-studio"));
  });

  it("keeps the Activity feed reachable and the selected item across tab switches and Back", async () => {
    const { router } = mount("/for-you");
    fireEvent.click(await screen.findByTestId("attention-row-queue:q-twin-101"));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "attention", item: "queue:q-twin-101" }));
    expect((await screen.findByTestId("attention-detail-summary")).textContent).toContain("Approve release-train build plan");

    fireEvent.click(screen.getByTestId("for-you-tab-activity"));
    await waitFor(() => expect(router.state.location.search).toEqual({ item: "queue:q-twin-101", view: "activity" }));
    expect(screen.getByTestId("for-you-feed")).toBeTruthy();

    await act(async () => { router.history.back(); });
    expect((await screen.findByTestId("attention-detail-summary")).textContent).toContain("Approve release-train build plan");
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(screen.getByTestId("attention-detail-empty")).toBeTruthy());
  });

  it("a direct link restores the view and exact delivered item from its own dataset", async () => {
    const { calls } = mount("/for-you?view=attention&item=human-update%3Aq-twin-120");
    expect((await screen.findByTestId("attention-delivered-body")).textContent).toContain("412 tests");
    expect(calls.some((c) => c.pathname === "/api/attention" && c.searchParams.has("item"))).toBe(false);
  });

  it("drops an invalid view and never coerces an unrelated event ID into an attention item", async () => {
    const { calls } = mount("/for-you?view=feed&item=evt-42");
    expect((await screen.findByTestId("for-you-page")).getAttribute("data-view")).toBe("attention");
    expect(await screen.findByTestId("attention-detail-unrecognized")).toBeTruthy();
    await screen.findByTestId("attention-row-queue:q-twin-101");
    expect(calls.some((c) => c.searchParams.get("item") === "evt-42")).toBe(false);
  });

  it("keeps the Attention lens and search in the URL so Back restores them", async () => {
    const { router } = mount("/for-you?lens=delivered&q=nightly");
    expect((await screen.findByTestId("attention-search") as HTMLInputElement).value).toBe("nightly");
    expect(screen.getByTestId("attention-lens-delivered").getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByTestId("attention-row-human-update:q-twin-120")).toBeTruthy();
    expect(screen.queryByTestId("attention-row-human-update:q-twin-118")).toBeNull();
    expect(screen.queryByTestId("attention-section-action")).toBeNull();

    fireEvent.click(screen.getByTestId("attention-row-human-update:q-twin-120"));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ lens: "delivered", q: "nightly", item: "human-update:q-twin-120" }));
    fireEvent.click(screen.getByTestId("attention-lens-all"));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("lens"));
    await act(async () => { router.history.back(); });
    await waitFor(() => expect(screen.getByTestId("attention-lens-delivered").getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByTestId("attention-search") as HTMLInputElement).value).toBe("nightly");
  });

  it("supports arrow-key tab navigation", async () => {
    const { router } = mount("/for-you");
    const tab = await screen.findByTestId("for-you-tab-attention");
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "activity" }));
    expect(screen.getByTestId("for-you-tab-activity").getAttribute("tabindex")).toBe("0");
  });

  it("explains a remote topology selection while still reading the connected instance", async () => {
    const { calls } = mount("/for-you", { ownName: "demo-studio", selected: "remote-box" });
    expect((await screen.findByTestId("operator-remote-context")).textContent).toMatch(/remote-box.*connected instance/s);
    await screen.findByTestId("attention-row-queue:q-twin-101");
    expect(calls.some((c) => c.searchParams.has("host"))).toBe(false);
  });
});
