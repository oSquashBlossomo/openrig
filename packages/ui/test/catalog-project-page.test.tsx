// Exact catalog project page: identity travels as project ID + canonical root
// through URL, reads, Back and reselection. Equal display/mission/slice names
// never collapse; no selection, moved roots and incomplete links never fall
// back to another project or the configured default workspace.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { CatalogProjectRoute } from "../src/components/project/catalog/CatalogProjectPage.js";
import { catalogHref, parseCatalogLocation, selectionFromLocation, matchCatalogSelection } from "../src/components/project/catalog/project-location.js";
import { catalog, execution, projects, scopes, sliceDetail } from "./project-contract-fixtures.js";

type Handler = (url: URL) => Response | Promise<Response>;
const calls: string[] = [];
const clients: QueryClient[] = [];

function serve(routes: Record<string, Handler>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = String(input);
    calls.push(raw);
    const url = new URL(raw, "http://test.local");
    const handler = routes[url.pathname] ?? routes["*"];
    return handler ? handler(url) : Response.json({ error: "not_found" }, { status: 404 });
  }));
}

const hostsLocal = () => Response.json({ ownName: "studio", selected: "local", hosts: [] });
const byProject = (make: (id: string) => unknown) => (url: URL) => {
  const id = url.searchParams.get("project")!;
  const root = url.searchParams.get("projectRoot");
  if (root !== `/books/${id}`) return Response.json({ error: "project_changed", message: `Project ${id} is no longer at ${root}` }, { status: 409 });
  return Response.json(make(id));
};
const standard: Record<string, Handler> = {
  "/api/hosts": hostsLocal,
  "/api/scopes/projects": () => Response.json(catalog),
  "/api/scopes": byProject((id) => scopes(id)),
  "/api/views/execution": (url) => byProject((id) => execution(id, url.searchParams.get("mission") ?? "trial"))(url),
  "/api/slices/one": byProject((id) => ({ ...sliceDetail, slicePath: `/books/${id}/missions/trial/slices/one` })),
  "/api/slices/one/doc/SPEC.md": byProject((id) => ({ relPath: "SPEC.md", content: `# Spec for ${id}` })),
};

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const root = createRootRoute({ component: () => <Outlet /> });
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "/project/catalog", component: CatalogProjectRoute }),
    createRoute({ getParentRoute: () => root, path: "/project", component: () => <div data-testid="workspace-page" /> }),
    createRoute({ getParentRoute: () => root, path: "/workflow/instance/$instanceId", component: () => <div data-testid="instance-page" /> }),
  ]);
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, history, client };
}

const search = (router: ReturnType<typeof mount>["router"]) => parseCatalogLocation(router.state.location.publicHref.split("?")[1] ?? "");
const reads = (path: string) => calls.filter((c) => new URL(c, "http://test.local").pathname === path);

afterEach(() => { cleanup(); clients.splice(0).forEach((c) => c.clear()); calls.length = 0; vi.unstubAllGlobals(); });

describe("catalog location codec", () => {
  it("round-trips exact ID/root bytes and never coerces numeric-looking IDs", () => {
    const href = catalogHref({ project: "1.0", projectRoot: "/books/a b&c", mission: "trial", slice: "one", view: "docs", doc: "a?b#c.md" });
    const loc = parseCatalogLocation(href.slice(href.indexOf("?")));
    expect(loc).toEqual({ project: "1.0", projectRoot: "/books/a b&c", mission: "trial", slice: "one", view: "docs", doc: "a?b#c.md" });
  });
  it("drops orphan child coordinates and requires both identity halves", () => {
    expect(parseCatalogLocation(catalogHref({ mission: "trial", slice: "one" }).split("?")[1] ?? "")).toEqual({});
    expect(selectionFromLocation({ project: "a" }).kind).toBe("invalid");
    expect(selectionFromLocation({ projectRoot: "/books/a" }).kind).toBe("invalid");
    expect(selectionFromLocation({}).kind).toBe("none");
  });
  it("classifies moved roots and re-catalogued roots without choosing by name", () => {
    expect(matchCatalogSelection(projects, { id: "a", root: "/old/a" })).toMatchObject({ kind: "moved", current: [{ id: "a", root: "/books/a" }] });
    expect(matchCatalogSelection(projects, { id: "z", root: "/books/b" })).toMatchObject({ kind: "renamed", current: [{ id: "b" }] });
    expect(matchCatalogSelection(projects, { id: "Book", root: "/nowhere" }).kind).toBe("absent");
  });
});

describe("CatalogProjectPage", () => {
  it("shows every catalog entry, flags equal names and picks nothing without an explicit choice", async () => {
    serve({ ...standard, "/api/scopes/projects": () => Response.json({ ...catalog, projects: [...projects, { ...projects[0], id: "gone", root: "/books/gone", error: "Root missing on disk" }] }) });
    mount("/project/catalog");
    await screen.findByTestId("project-catalog");
    expect(screen.getByTestId("catalog-no-selection")).toBeTruthy();
    expect(screen.getByTestId("project-catalog-entry-a-same-name").textContent).toContain("×3");
    expect(screen.getByTestId("project-catalog-entry-b").getAttribute("data-root")).toBe("/books/b");
    const gone = screen.getByTestId("project-catalog-entry-gone") as HTMLButtonElement;
    expect(gone.disabled).toBe(true);
    expect(gone.textContent).toContain("Root missing on disk");
    expect(reads("/api/scopes")).toHaveLength(0);
    expect(reads("/api/views/execution")).toHaveLength(0);
  });

  it("selects by exact ID and root, carries both on every read, and browser Back restores the previous selection", async () => {
    serve(standard);
    const { router, history } = mount("/project/catalog");
    fireEvent.click(await screen.findByTestId("project-catalog-entry-b"));
    await screen.findByTestId("project-overview");
    expect(search(router)).toEqual({ project: "b", projectRoot: "/books/b" });
    expect(reads("/api/scopes").every((c) => c.includes("project=b&projectRoot=%2Fbooks%2Fb"))).toBe(true);
    expect(screen.getByTestId("catalog-project-identity").textContent).toContain("/books/b");

    fireEvent.click(screen.getByTestId("project-mission-trial"));
    await screen.findByTestId("mission-story-facts");
    expect(search(router)).toEqual({ project: "b", projectRoot: "/books/b", mission: "trial" });
    expect(reads("/api/views/execution").at(-1)).toContain("project=b&projectRoot=%2Fbooks%2Fb&mission=trial");

    act(() => history.back());
    await screen.findByTestId("project-overview");
    expect(search(router)).toEqual({ project: "b", projectRoot: "/books/b" });
    act(() => history.back());
    await screen.findByTestId("catalog-no-selection");
  });

  it("reports a moved root with intentional reselection and never reads another root", async () => {
    serve(standard);
    const { router } = mount(catalogHref({ project: "a", projectRoot: "/old/a", mission: "trial" }));
    const moved = await screen.findByTestId("catalog-selection-moved");
    expect(moved.textContent).toContain("/old/a");
    await screen.findByTestId("catalog-identity-error");
    expect(reads("/api/scopes").length).toBeGreaterThan(0);
    for (const c of [...reads("/api/scopes"), ...reads("/api/views/execution")]) expect(c).toContain("projectRoot=%2Fold%2Fa");
    expect(screen.queryByTestId("project-overview")).toBeNull();
    fireEvent.click(within(moved).getByTestId("catalog-reselect-a"));
    await screen.findByTestId("project-overview");
    expect(search(router)).toEqual({ project: "a", projectRoot: "/books/a" });
  });

  it("refuses an incomplete link without reading anything project-scoped", async () => {
    serve(standard);
    mount("/project/catalog?project=a");
    expect((await screen.findByTestId("catalog-selection-invalid")).textContent).toContain("without its canonical root");
    expect(reads("/api/scopes")).toHaveLength(0);
  });

  it("keeps numeric-looking and reserved-character identities byte-exact through router navigation and Back", async () => {
    const odd = { id: "1.0", root: "/books/1.0 a&b", name: "Book", sourcePath: "/books/1.0 a&b/SPEC.md", missionsRoot: "/books/1.0 a&b/missions" };
    serve({ ...standard, "/api/scopes/projects": () => Response.json({ ...catalog, projects: [...projects, odd] }),
      "/api/scopes": (url) => Response.json({ ...scopes("a"), project: { ...odd, id: url.searchParams.get("project"), root: url.searchParams.get("projectRoot") } }),
      "/api/views/execution": (url) => Response.json(execution(url.searchParams.get("project")!, url.searchParams.get("mission")!)) });
    const { router, history } = mount("/project/catalog");
    fireEvent.click(await screen.findByTestId("project-catalog-entry-1.0"));
    await screen.findByTestId("project-overview");
    expect(search(router)).toEqual({ project: "1.0", projectRoot: "/books/1.0 a&b" });
    expect(reads("/api/scopes").at(-1)).toContain("project=1.0&projectRoot=%2Fbooks%2F1.0+a%26b");
    act(() => history.back());
    await screen.findByTestId("catalog-no-selection");
    act(() => history.forward());
    await screen.findByTestId("project-overview");
    expect(search(router)).toEqual({ project: "1.0", projectRoot: "/books/1.0 a&b" });

    cleanup();
    const reloaded = mount(catalogHref({ project: "1.0", projectRoot: "/books/1.0 a&b", mission: "trial" }));
    await screen.findByTestId("mission-story-facts");
    expect(search(reloaded.router)).toEqual({ project: "1.0", projectRoot: "/books/1.0 a&b", mission: "trial" });
    expect(reads("/api/views/execution").at(-1)).toContain("project=1.0&projectRoot=%2Fbooks%2F1.0+a%26b&mission=trial");
  });

  it("discloses partial sources and per-mission errors instead of hiding them", async () => {
    serve({ ...standard, "/api/scopes": byProject((id) => ({ ...scopes(id), readErrors: ["missions/legacy: unreadable"] })) });
    mount(catalogHref({ project: "a", projectRoot: "/books/a" }));
    expect((await screen.findByTestId("project-read-errors")).textContent).toContain("missions/legacy: unreadable");
    expect(screen.getByTestId("project-mission-broken-error").textContent).toContain("Source unavailable");
  });

  it("keeps the newest selection when an older project's read resolves late", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    serve({ ...standard, "/api/scopes": async (url) => {
      if (url.searchParams.get("project") === "a") await gateA;
      return byProject((id) => scopes(id))(url);
    } });
    const { router } = mount("/project/catalog");
    fireEvent.click(await screen.findByTestId("project-catalog-entry-a"));
    fireEvent.click(screen.getByTestId("project-catalog-entry-b"));
    await screen.findByTestId("project-overview");
    await act(async () => { releaseA(); await Promise.resolve(); });
    expect(search(router)).toEqual({ project: "b", projectRoot: "/books/b" });
    expect(screen.getByTestId("catalog-project-identity").textContent).toContain("/books/b");
    expect(screen.getByTestId("project-catalog-entry-b").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("project-catalog-entry-a").getAttribute("aria-current")).toBeNull();
  });

  it("shows a withdrawn native outcome as reopened beside a legacy PASS and a paired proof drop, without success colouring", async () => {
    serve(standard);
    mount(catalogHref({ project: "a", projectRoot: "/books/a", mission: "trial", slice: "one" }));
    const outcomes = await screen.findByTestId("slice-native-outcomes");
    expect(within(outcomes).getByTestId("slice-native-outcomes-item-item-a-state").textContent).toBe("withdrawn");
    expect(within(outcomes).getByTestId("slice-native-outcomes-summary").getAttribute("data-tone")).toBe("bad");
    expect(within(outcomes).getByTestId("slice-native-outcomes-item-item-a-judgment-corrects").textContent).toContain("judgment-a");
    expect(within(outcomes).getByTestId("slice-native-outcomes-history")).toBeTruthy();

    fireEvent.click(screen.getByTestId("slice-tabs-work"));
    const reviewed = await screen.findByTestId("legacy-ladder-reviewed");
    expect(reviewed.getAttribute("data-state")).toBe("yes");
    expect(within(reviewed).getByText("yes").getAttribute("data-tone")).not.toBe("good");

    fireEvent.click(screen.getByTestId("slice-tabs-proof"));
    expect((await screen.findByTestId("proof-contract-drop-verdict")).textContent).toContain("artifact says “PASS”");
    expect(screen.getByTestId("proof-contract-paired").getAttribute("data-tone")).not.toBe("good");
    const image = screen.getByAltText("shot.png") as HTMLImageElement;
    expect(image.getAttribute("src")).toContain("project=a&projectRoot=%2Fbooks%2Fa&mission=trial");
    for (const c of reads("/api/slices/one")) expect(c).toContain("project=a&projectRoot=%2Fbooks%2Fa&mission=trial");
  });

  it("reads a selected-project document only through the exact scoped helper, and only when chosen", async () => {
    serve(standard);
    const { router } = mount(catalogHref({ project: "b", projectRoot: "/books/b", mission: "trial", slice: "one", view: "docs" }));
    await screen.findByTestId("slice-docs-list");
    expect(calls.some((c) => c.includes("/doc/"))).toBe(false);
    fireEvent.click(screen.getByTestId("slice-doc-SPEC.md"));
    expect((await screen.findByTestId("slice-doc-body")).textContent).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("slice-doc-body").textContent).toContain("Spec for b"));
    expect(search(router).doc).toBe("SPEC.md");
    expect(calls.filter((c) => c.includes("/doc/"))).toEqual(["/api/slices/one/doc/SPEC.md?project=b&projectRoot=%2Fbooks%2Fb&mission=trial"]);
  });

  it("explains that a remote topology selection does not redirect project reads", async () => {
    serve({ ...standard, "/api/hosts": () => Response.json({ ownName: "studio", selected: "far", hosts: [{ id: "far", transport: "http", url: "http://far.example", selected: true, status: "reachable" }] }) });
    mount(catalogHref({ project: "a", projectRoot: "/books/a" }));
    expect((await screen.findByTestId("connected-instance-note-remote")).textContent).toContain("far");
    await screen.findByTestId("project-overview");
    for (const c of reads("/api/scopes")) expect(c).not.toContain("host=");
  });

  it("discloses an unreadable host selection rather than presuming local", async () => {
    serve({ ...standard, "/api/hosts": () => Response.json({ error: "unavailable" }, { status: 503 }) });
    mount("/project/catalog");
    expect((await screen.findByTestId("connected-instance-note-unknown")).textContent).toContain("could not be read");
  });

  it("shows mission story facts, waves and mission-bound packets for the exact mission", async () => {
    serve(standard);
    const { router } = mount(catalogHref({ project: "a", projectRoot: "/books/a", mission: "trial" }));
    await screen.findByTestId("mission-story-facts");
    expect(screen.getByTestId("mission-progress").textContent).toContain("0/1 slice outcomes accepted");
    expect(screen.getByTestId("mission-lifecycle").textContent).toContain("separate from outcomes");
    expect(screen.getByTestId("wave-build-wave")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mission-tabs-workflows"));
    fireEvent.click(await screen.findByTestId("lifecycle-packet-row-packet-a"));
    await waitFor(() => expect(search(router).packet).toBe("packet-a"));
    expect(screen.getByTestId("lifecycle-packet-action").textContent).toBe("rig workflow project --instance workflow-a --current-packet packet-a");
    expect(screen.getByTestId("lifecycle-packet-wake").textContent).toContain("does not guarantee delivery");
    expect(screen.queryByTestId("lifecycle-workflow-a-identity-mismatch")).toBeNull();
  });
});
